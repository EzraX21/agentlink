import { describe, expect, it } from 'vitest';
import { createChatStore, type ChatState } from './store.js';
import { sendText, type SendTextDeps } from './sendText.js';
import type { EvtFrame, Message, Self } from '@agentlink/protocol';

/**
 * 回归测试："发一条消息显示两次"。
 *
 * 真实链路：客户端先插一条乐观消息（本地 id），服务端把 message.new **也推给
 * 发送者**（真实 id），随后 message.send 的响应到达。如果只按 id 去重，
 * 本地 id 与真实 id 不同 → 用户看到两条。
 *
 * 这个测试把两条到达顺序都跑一遍，断言最终恰好一条。
 */

const SELF: Self = { id: 'u_self', kind: 'human', display_name: '我', tenant_id: 'default' };
const CONV = 'c_01M7JD0000000000000000000A';

/**
 * 造一个真实 store + 一个"永远读最新状态"的入口。
 *
 * 注意：`set` 会用新对象替换整个状态，所以测试里**不能**缓存方法返回时的对象，
 * 必须每步都通过 `getState()` 读 —— 这正是 store 内部用 `get()` 的原因。
 */
function makeStore(): { getState: () => ChatState; methods: ChatState } {
  let state: ChatState;
  const set = (partial: Partial<ChatState>): void => {
    state = { ...state, ...partial };
  };
  state = createChatStore(set, () => state);
  return { getState: () => state, methods: state };
}

/** 服务端真推回来的 message.new（真实 id）。 */
function serverEcho(text: string, id = 'm_real1', seq = 7): EvtFrame {
  const message: Message = {
    id,
    conv_id: CONV,
    seq,
    sender: { id: SELF.id, kind: 'human', display_name: SELF.display_name },
    content: [{ type: 'text', text }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: 1_700_000_000_000,
    revoked_at: null,
  };
  return { v: 1, kind: 'evt', type: 'message.new', seq, ts: 1_700_000_000_000, data: { conv_id: CONV, message } };
}

function deps(store: ChatState, opts: { beforeResolve?: () => void } = {}): SendTextDeps {
  return {
    call: async <T,>() => {
      // 模拟"事件先于响应到达"：在返回响应之前，先把服务端推送灌进 store
      opts.beforeResolve?.();
      return { message_id: 'm_real1', seq: 7, created_at: 1_700_000_000_000 } as T;
    },
    replaceMessage: store.replaceMessage,
    removeMessage: store.removeMessage,
    setError: store.setError,
    uuid: () => 'uuid-fixed',
    now: () => 1_700_000_000_000,
  };
}

describe('发送消息不重复', () => {
  it('事件先到（服务端先推 message.new，再回响应）：最终只有一条', async () => {
    const store = makeStore();
    const echoed = serverEcho('你好');

    await sendText(
      deps(store.methods, { beforeResolve: () => store.methods.handleEvent(echoed) }),
      { convId: CONV, self: SELF, text: '你好' },
    );

    const list = store.getState().messages[CONV] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('m_real1');
    expect(list[0]?.content[0]).toEqual({ type: 'text', text: '你好' });
  });

  it('响应先到（乐观消息先被替换，事件后到）：最终只有一条', async () => {
    const store = makeStore();
    const echoed = serverEcho('你好');

    await sendText(deps(store.methods), { convId: CONV, self: SELF, text: '你好' });
    // 响应处理完毕后再灌事件（幂等）
    store.methods.handleEvent(echoed);

    const list = store.getState().messages[CONV] ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('m_real1');
  });

  it('发送时立刻能看到乐观消息（点发送有即时反馈）', async () => {
    const store = makeStore();
    let sawOptimistic = false;
    const d = deps(store.methods);
    const originalCall = d.call;
    d.call = async <T,>(op: string, data: unknown) => {
      // 在等服务端响应期间，列表里应该已经有这条（本地 id）
      const list = store.getState().messages[CONV] ?? [];
      sawOptimistic = list.length === 1 && list[0]?.id.startsWith('local_') === true;
      return originalCall<T>(op, data);
    };

    await sendText(d, { convId: CONV, self: SELF, text: '你好' });
    expect(sawOptimistic).toBe(true);
  });

  it('发送失败时把乐观消息撤回，不留假消息', async () => {
    const store = makeStore();
    await sendText(
      {
        ...deps(store.methods),
        call: async () => {
          throw new Error('网络断了');
        },
      },
      { convId: CONV, self: SELF, text: '你好' },
    );

    expect(store.getState().messages[CONV] ?? []).toHaveLength(0);
    expect(store.getState().lastError).toBe('网络断了');
  });

  it('空白文本不发', async () => {
    const store = makeStore();
    const r = await sendText(deps(store.methods), { convId: CONV, self: SELF, text: '   ' });
    expect(r).toBeNull();
    expect(store.getState().messages[CONV] ?? []).toHaveLength(0);
  });

  it('连发两条不同的消息，各自只出现一次', async () => {
    const store = makeStore();
    await sendText(deps(store.methods), { convId: CONV, self: SELF, text: '第一条' });
    // 第二条用不同的真实 id
    const d2: SendTextDeps = {
      ...deps(store.methods),
      uuid: () => 'uuid-2',
      call: async <T,>() => ({ message_id: 'm_real2', seq: 8, created_at: 1_700_000_001_000 }) as T,
    };
    await sendText(d2, { convId: CONV, self: SELF, text: '第二条' });

    const list = store.getState().messages[CONV] ?? [];
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id).sort()).toEqual(['m_real1', 'm_real2']);
  });
});