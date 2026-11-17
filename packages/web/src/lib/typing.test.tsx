import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Member } from '@agentlink/protocol';
import {
  reportTyping,
  resetTypingCapability,
  typingSupported,
  whoIsTyping,
} from '../lib/typing.js';
import { ChatWindow } from '../components/ChatWindow.js';

/**
 * 「正在输入」的客户端一半。
 *
 * 协议里**没有** `typing.send`（§6 有事件、§5 没有 op），属于需要审批的变更。
 * 客户端按协议 §12 的降级语义处理：尝试发送 → 收到 `UNSUPPORTED_OP` → 永久停用。
 * 这样服务端一旦支持，客户端零改动就生效；现在也不会每 2 秒撞一次。
 */

const CONV = 'c_01M7JD0000000000000000000A';

beforeEach(() => {
  resetTypingCapability();
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

function client(impl: () => Promise<unknown>) {
  return { call: vi.fn(impl) };
}

describe('打字节流', () => {
  it('2 秒内重复调用只发一次', async () => {
    const c = client(async () => ({ ok: true }));
    await reportTyping(c, CONV, 1_000);
    await reportTyping(c, CONV, 1_500); // 500ms 后
    await reportTyping(c, CONV, 2_400); // 还在 2 秒内
    expect(c.call).toHaveBeenCalledTimes(1);
    await reportTyping(c, CONV, 3_100); // 超过 2 秒
    expect(c.call).toHaveBeenCalledTimes(2);
  });

  it('服务端不支持（UNSUPPORTED_OP）后永久停用，不再打扰服务端', async () => {
    const err = Object.assign(new Error('typing.send: UNSUPPORTED_OP'), { code: 'UNSUPPORTED_OP' });
    const c = client(async () => {
      throw err;
    });
    await reportTyping(c, CONV, 1_000);
    expect(typingSupported()).toBe(false);
    await reportTyping(c, CONV, 10_000); // 早过 2 秒
    expect(c.call).toHaveBeenCalledTimes(1); // 没有再发
  });

  it('其它错误不影响后续（断线恢复后还能发）', async () => {
    let fail = true;
    const c = client(async () => {
      if (fail) throw Object.assign(new Error('连接未建立'), { code: 'AUTH_REQUIRED' });
      return { ok: true };
    });
    await reportTyping(c, CONV, 1_000);
    expect(typingSupported()).toBeNull(); // 未定，不是 false
    fail = false;
    await reportTyping(c, CONV, 5_000);
    expect(typingSupported()).toBe(true);
    expect(c.call).toHaveBeenCalledTimes(2);
  });

  it('永不抛错（打字指示是尽力而为）', async () => {
    const c = client(async () => {
      throw new Error('炸了');
    });
    await expect(reportTyping(c, CONV, 1_000)).resolves.toBeUndefined();
  });
});

describe('谁在打字', () => {
  const names = new Map([
    ['u_b', '小明'],
    ['u_c', '卡罗'],
  ]);

  it('3 秒内的才算，排除自己', () => {
    const typing = {
      [`${CONV}:u_b`]: 4_900, // 0.1 秒前 → 有效
      [`${CONV}:u_c`]: 1_000, // 4 秒前 → 过期
      [`${CONV}:u_self`]: 4_900,
    };
    expect(whoIsTyping(typing, CONV, 'u_self', names, 5_000)).toEqual(['小明']);
  });

  it('别的会话的记录不算', () => {
    const typing = { 'c_other:u_b': 4_900 };
    expect(whoIsTyping(typing, CONV, 'u_self', names, 5_000)).toEqual([]);
  });

  it('未知用户回退显示 id', () => {
    const typing = { [`${CONV}:u_zzz`]: 4_900 };
    expect(whoIsTyping(typing, CONV, 'u_self', names, 5_000)).toEqual(['u_zzz']);
  });
});

describe('聊天窗显示"正在输入"', () => {
  const self: Member = {
    conv_id: CONV,
    user_id: 'u_a',
    role: 'owner',
    is_agent: false,
    muted_until: 0,
    joined_at: 1,
    user: { id: 'u_a', kind: 'human', display_name: '我' },
  };
  const other: Member = {
    conv_id: CONV,
    user_id: 'u_b',
    role: 'member',
    is_agent: false,
    muted_until: 0,
    joined_at: 2,
    user: { id: 'u_b', kind: 'human', display_name: '小明' },
  };

  function props(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
    return {
      convId: CONV,
      convTitle: '测试群',
      announcement: '',
      messages: [],
      streaming: {},
      selfId: 'u_a',
      members: [self, other],
      onSend: vi.fn(),
      onSendAttachment: vi.fn(async () => {}),
      onJumpToMessage: vi.fn(),
      onRevoke: vi.fn(),
      onInterrupt: vi.fn(),
      onLoadMore: vi.fn(),
      hasMore: false,
      loadingMore: false,
      onToggleMembers: vi.fn(),
      canRevokeOthers: false,
      highlightMessageId: null,
      ...overrides,
    } satisfies React.ComponentProps<typeof ChatWindow>;
  }

  it('有他人打字时头部显示「小明 正在输入…」', async () => {
    render(<ChatWindow {...props({ typing: { [`${CONV}:u_b`]: Date.now() } })} />);
    await waitFor(() => expect(screen.getByText('小明 正在输入…')).toBeTruthy());
  });

  it('没有打字记录时显示成员数', () => {
    render(<ChatWindow {...props({ typing: {} })} />);
    expect(screen.getByText('2 位成员')).toBeTruthy();
  });

  it('自己打字不显示在自己界面上', () => {
    render(<ChatWindow {...props({ typing: { [`${CONV}:u_a`]: Date.now() } })} />);
    expect(screen.queryByText(/正在输入/)).toBeNull();
  });

  it('输入框有变化时调用 onTyping（节流在上层）', () => {
    const onTyping = vi.fn();
    render(<ChatWindow {...props({ onTyping })} />);
    fireEvent.change(screen.getByLabelText('消息输入'), { target: { value: '在打字了' } });
    expect(onTyping).toHaveBeenCalledTimes(1);
  });
});