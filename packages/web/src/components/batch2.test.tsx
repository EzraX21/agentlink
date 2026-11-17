import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation, Member, Message } from '@agentlink/protocol';
import { ChatWindow } from './ChatWindow.js';
import { ConversationList } from './ConversationList.js';
import { MemberPanel } from './MemberPanel.js';
import { clearDraft, loadDraft, loadPinned, loadUnread, orderByPinned, saveDraft, savePinned, saveUnread } from '../lib/localState.js';

/**
 * 第 2 批（纯客户端）的行为测试：日期分隔、引用回复、右键菜单、草稿、未读、置顶、成员搜索。
 */

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: vi.fn(async () => 'blob:mock'),
  releaseAttachmentUrl: vi.fn(),
  uploadAttachment: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

const CONV: Conversation = {
  id: 'c_batch2',
  kind: 'group',
  title: '测试群',
  announcement: '',
  created_by: 'u_a',
  created_at: Date.now(),
};

const self: Member = {
  conv_id: CONV.id,
  user_id: 'u_a',
  role: 'owner',
  is_agent: false,
  muted_until: 0,
  joined_at: 1,
  user: { id: 'u_a', kind: 'human', display_name: '我' },
};
const other: Member = {
  conv_id: CONV.id,
  user_id: 'u_b',
  role: 'member',
  is_agent: false,
  muted_until: 0,
  joined_at: 2,
  user: { id: 'u_b', kind: 'human', display_name: '小明' },
};

const day = 24 * 60 * 60 * 1000;

function msg(id: string, text: string, at: number, senderId = 'u_b', replyTo: string | null = null): Message {
  return {
    id,
    conv_id: CONV.id,
    seq: Number(id.replace(/\D/g, '')) || 1,
    sender:
      senderId === 'u_a'
        ? { id: 'u_a', kind: 'human', display_name: '我' }
        : { id: 'u_b', kind: 'human', display_name: '小明' },
    content: [{ type: 'text', text }],
    reply_to: replyTo,
    state: 'final',
    interrupted: false,
    created_at: at,
    revoked_at: null,
  };
}

function chatProps(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
  return {
    convId: CONV.id,
    convTitle: CONV.title,
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

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('日期分隔线', () => {
  it('不同天的消息之间插一条日期分隔', async () => {
    const now = Date.now();
    render(
      <ChatWindow
        {...chatProps({
          messages: [
            msg('m1', '昨天的消息', now - day - 1000),
            msg('m2', '今天的消息', now),
          ],
        })}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('昨天')).toBeTruthy();
      expect(screen.getByText('今天')).toBeTruthy();
    });
  });
});

describe('引用回复', () => {
  it('reply_to 指向的消息以引用块显示作者与摘要', async () => {
    const now = Date.now();
    render(
      <ChatWindow
        {...chatProps({
          messages: [msg('m1', '周报什么时候交', now - 1000), msg('m2', '这周五', now, 'u_a', 'm1')],
        })}
      />,
    );
    // 引用块是带 title 的按钮；原消息本身也在列表里，所以用结构定位而不是纯文本
    await waitFor(() => {
      const quote = document.querySelector('button[title="跳到被引用的消息"]');
      expect(quote).not.toBeNull();
      expect(quote?.textContent).toContain('小明');
      expect(quote?.textContent).toContain('周报什么时候交');
    });
  });

  it('从右键菜单选「引用回复」后，输入框上方出现回复提示，发送时带 reply_to', async () => {
    const now = Date.now();
    const onSend = vi.fn();
    render(
      <ChatWindow
        {...chatProps({
          messages: [msg('m1', '原始消息', now), msg('m2', '第二条', now + 1000, 'u_a')],
          onSend,
        })}
      />,
    );

    // 右键第一条
    const first = await screen.findByText('原始消息');
    const bubble = first.closest('[data-message-id]') as HTMLElement;
    fireEvent.contextMenu(bubble);
    fireEvent.click(await screen.findByRole('menuitem', { name: '引用回复' }));

    await waitFor(() => expect(screen.getByText(/回复 小明/)).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/回复 小明/), { target: { value: '我的回复' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith('我的回复', 'm1');
  });
});

describe('消息右键菜单', () => {
  it('自己的消息能撤回；他人的消息没有撤回项（非管理员）', async () => {
    const now = Date.now();
    render(
      <ChatWindow
        {...chatProps({
          messages: [msg('m1', '别人的', now), msg('m2', '我自己的', now + 1000, 'u_a')],
          canRevokeOthers: false,
        })}
      />,
    );

    const otherBubble = (await screen.findByText('别人的')).closest('[data-message-id]') as HTMLElement;
    fireEvent.contextMenu(otherBubble);
    expect(screen.queryByRole('menuitem', { name: '撤回' })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: '复制文本' }));

    const mine = (await screen.findByText('我自己的')).closest('[data-message-id]') as HTMLElement;
    fireEvent.contextMenu(mine);
    expect(await screen.findByRole('menuitem', { name: '撤回' })).toBeTruthy();
  });
});

describe('草稿', () => {
  it('切换会话再回来，草稿还在', async () => {
    const { unmount } = render(<ChatWindow {...chatProps()} />);
    const box = screen.getByPlaceholderText(/写消息/);
    fireEvent.change(box, { target: { value: '没发完的内容' } });
    // 草稿写入有 300ms 防抖
    await waitFor(() => expect(loadDraft(CONV.id)).toBe('没发完的内容'), { timeout: 2000 });
    unmount();

    render(<ChatWindow {...chatProps()} />);
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/写消息/) as HTMLTextAreaElement).value).toBe(
        '没发完的内容',
      );
    });
  });

  it('发送成功后草稿被清掉', async () => {
    const onSend = vi.fn();
    render(<ChatWindow {...chatProps({ onSend })} />);
    fireEvent.change(screen.getByPlaceholderText(/写消息/), { target: { value: '要发的内容' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('要发的内容', undefined));
    expect((screen.getByPlaceholderText(/写消息/) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('未读与置顶', () => {
  const convs: Conversation[] = [
    { ...CONV, id: 'c1', title: '会话一' },
    { ...CONV, id: 'c2', title: '会话二' },
  ];

  function listProps(overrides: Partial<React.ComponentProps<typeof ConversationList>> = {}) {
    return {
      convs,
      activeConvId: 'c1',
      messages: {},
      onSelect: vi.fn(),
      onNewGroup: vi.fn(),
      selfName: '我',
      onLogout: vi.fn(),
      onOpenSearch: vi.fn(),
      unread: {},
      pinned: [],
      onTogglePin: vi.fn(),
      ...overrides,
    } satisfies React.ComponentProps<typeof ConversationList>;
  }

  it('有未读时显示角标，超过 99 显示 99+', () => {
    render(<ConversationList {...listProps({ unread: { c1: 3, c2: 150 } })} />);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('99+')).toBeTruthy();
  });

  it('置顶的会话排在最前面并带 📌', () => {
    render(<ConversationList {...listProps({ pinned: ['c2'] })} />);
    const titles = screen.getAllByText(/会话[一二]/).map((el) => el.textContent ?? '');
    expect(titles[0]).toContain('会话二');
    expect(titles[0]).toContain('📌');
  });

  it('点置顶按钮触发 onTogglePin 且不切换会话', () => {
    const onTogglePin = vi.fn();
    const onSelect = vi.fn();
    render(<ConversationList {...listProps({ onTogglePin, onSelect })} />);
    const pins = screen.getAllByTitle('置顶');
    fireEvent.click(pins[0] as HTMLElement);
    expect(onTogglePin).toHaveBeenCalledWith('c1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('orderByPinned 是稳定排序', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(orderByPinned(items, ['c']).map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(orderByPinned(items, []).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('成员搜索', () => {
  it('按昵称过滤成员', () => {
    render(
      <MemberPanel
        members={[self, other]}
        selfId="u_a"
        myRole="owner"
        onKick={vi.fn()}
        onMute={vi.fn()}
        onSetRole={vi.fn()}
        onInvite={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('搜索成员…'), { target: { value: '小明' } });
    expect(screen.queryByText('我')).toBeNull();
    expect(screen.getByText(/小明/)).toBeTruthy();
  });
});

describe('localState 持久化', () => {
  it('草稿/未读/置顶能存能读', () => {
    saveDraft('c9', 'hi');
    expect(loadDraft('c9')).toBe('hi');
    clearDraft('c9');
    expect(loadDraft('c9')).toBe('');

    saveUnread({ c1: 2 });
    expect(loadUnread()).toEqual({ c1: 2 });

    savePinned(['c2', 'c3']);
    expect(loadPinned()).toEqual(['c2', 'c3']);
  });

  it('损坏的 JSON 不会抛异常', () => {
    localStorage.setItem('agentlink.unread.all', '{not json');
    expect(loadUnread()).toEqual({});
    localStorage.setItem('agentlink.pinned', '"oops"');
    expect(loadPinned()).toEqual([]);
  });
});