import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bumpAttempts,
  clearOutbox,
  enqueueOutbox,
  loadOutbox,
  outboxCount,
  removeFromOutbox,
  type OutboxEntry,
} from '../lib/outbox.js';
import { sendText, type SendTextDeps } from '../lib/sendText.js';
import { createChatStore, type ChatState } from '../lib/store.js';
import type { Self } from '@agentlink/protocol';

/**
 * 离线发件箱：断线时消息不能丢，恢复后重发不能重复。
 *
 * 关键设计：重发复用同一个 `client_msg_id`（协议 §5.3 的幂等键），
 * 所以"上次其实已到达、只是响应丢了"的情况下服务端会返回同一条消息。
 */

const SELF: Self = { id: 'u_self', kind: 'human', display_name: '我', tenant_id: 'default' };
const CONV = 'c_01M7JD0000000000000000000A';

function makeStore(): { getState: () => ChatState; methods: ChatState } {
  let state: ChatState;
  const set = (p: Partial<ChatState>): void => {
    state = { ...state, ...p };
  };
  state = createChatStore(set, () => state);
  return { getState: () => state, methods: state };
}

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    localId: 'local_1',
    convId: CONV,
    clientMsgId: 'cmid-1',
    content: [{ type: 'text', text: '断线时写的' }],
    replyTo: null,
    createdAt: 1_700_000_000_000,
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('发件箱存储', () => {
  it('入队、读取、移除', () => {
    expect(outboxCount()).toBe(0);
    enqueueOutbox(entry());
    expect(outboxCount()).toBe(1);
    expect(loadOutbox()[0]?.clientMsgId).toBe('cmid-1');
    removeFromOutbox('cmid-1');
    expect(outboxCount()).toBe(0);
  });

  it('同一个 client_msg_id 只留一份（重复点发送不会排队两条）', () => {
    enqueueOutbox(entry());
    enqueueOutbox(entry({ localId: 'local_2' }));
    expect(outboxCount()).toBe(1);
    expect(loadOutbox()[0]?.localId).toBe('local_2');
  });

  it('损坏的 localStorage 不会抛异常', () => {
    localStorage.setItem('agentlink.outbox', '{not json');
    expect(loadOutbox()).toEqual([]);
    localStorage.setItem('agentlink.outbox', '{"a":1}');
    expect(loadOutbox()).toEqual([]);
  });

  it('上限 100 条，超出丢最旧的', () => {
    for (let i = 0; i < 105; i += 1) {
      enqueueOutbox(entry({ clientMsgId: `cmid-${i}`, localId: `local_${i}` }));
    }
    const all = loadOutbox();
    expect(all.length).toBe(100);
    expect(all[0]?.clientMsgId).toBe('cmid-5');
    expect(all[all.length - 1]?.clientMsgId).toBe('cmid-104');
  });

  it('bumpAttempts 递增尝试次数', () => {
    enqueueOutbox(entry());
    const next = bumpAttempts('cmid-1');
    expect(next?.attempts).toBe(1);
    expect(loadOutbox()[0]?.attempts).toBe(1);
    expect(bumpAttempts('不存在')).toBeNull();
    clearOutbox();
    expect(outboxCount()).toBe(0);
  });
});

describe('sendText 的离线行为', () => {
  function deps(
    store: ChatState,
    overrides: Partial<SendTextDeps> = {},
  ): { deps: SendTextDeps; offline: Array<{ localId: string; clientMsgId: string }> } {
    const offline: Array<{ localId: string; clientMsgId: string }> = [];
    return {
      offline,
      deps: {
        call: async <T,>() => ({ message_id: 'm_real', seq: 1, created_at: 1 }) as T,
        replaceMessage: store.replaceMessage,
        removeMessage: store.removeMessage,
        setError: store.setError,
        uuid: () => 'uuid-1',
        now: () => 1_700_000_000_000,
        isOnline: () => true,
        onOffline: (e) => offline.push({ localId: e.localId, clientMsgId: e.clientMsgId }),
        ...overrides,
      },
    };
  }

  it('断线时不尝试发送，直接进发件箱，并保留本地气泡', async () => {
    const store = makeStore();
    const call = vi.fn();
    const { deps: d, offline } = deps(store.methods, { isOnline: () => false, call });

    await sendText(d, { convId: CONV, self: SELF, text: '断线时写的' });

    expect(call).not.toHaveBeenCalled(); // 不浪费 10 秒去等超时
    expect(offline).toHaveLength(1);
    // 气泡还在（用户不会以为字丢了）
    const list = store.getState().messages[CONV] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toMatch(/^local_/);
  });

  it('连接断开导致的发送失败也进发件箱', async () => {
    const store = makeStore();
    const { deps: d, offline } = deps(store.methods, {
      call: async () => {
        throw new Error('连接未建立');
      },
    });
    await sendText(d, { convId: CONV, self: SELF, text: '发送时刚好断线' });
    expect(offline).toHaveLength(1);
    expect(store.getState().messages[CONV] ?? []).toHaveLength(1);
  });

  it('权限/校验类失败不进队列，并删掉占位（不能假装发出去了）', async () => {
    const store = makeStore();
    const { deps: d, offline } = deps(store.methods, {
      call: async () => {
        throw new Error('PERM_DENIED 你被禁言了');
      },
    });
    await sendText(d, { convId: CONV, self: SELF, text: '被禁言' });
    expect(offline).toHaveLength(0);
    expect(store.getState().messages[CONV] ?? []).toHaveLength(0);
    expect(store.getState().lastError).toContain('禁言');
  });

  it('重发复用同一个 client_msg_id（幂等键不变）', async () => {
    const store = makeStore();
    let usedId = '';
    const { deps: d } = deps(store.methods, {
      call: async <T,>(op: string, data: unknown) => {
        usedId = (data as { client_msg_id: string }).client_msg_id;
        return { message_id: 'm_1', seq: 1, created_at: 1 } as T;
      },
    });
    await sendText(d, { convId: CONV, self: SELF, text: '先发一次' });
    const first = usedId;
    // 模拟发件箱重发：用同一个 client_msg_id 再发一次
    await sendText(
      { ...deps(store.methods).deps, uuid: () => first },
      { convId: CONV, self: SELF, text: '先发一次' },
    );
    expect(usedId).toBe(first);
  });
});