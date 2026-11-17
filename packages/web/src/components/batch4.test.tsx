import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Conversation, Member } from '@agentlink/protocol';
import { ConversationList } from './ConversationList.js';
import { GroupInfoDialog } from './GroupInfoDialog.js';
import { loadSidebarWidth, saveSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../lib/localState.js';
import { ChatWindow } from './ChatWindow.js';

/**
 * 第 4 轮（仍不动协议）：群信息编辑入口、会话列表右键菜单、侧栏宽度。
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
  id: 'c_group',
  kind: 'group',
  title: '项目讨论',
  announcement: '周报每周五交',
  created_by: 'u_a',
  created_at: 1,
};

describe('群信息对话框', () => {
  it('管理员能改群名与公告，保存时只提交改动的字段', async () => {
    const onSave = vi.fn(async () => {});
    render(
      <GroupInfoDialog
        initialTitle="项目讨论"
        initialAnnouncement="周报每周五交"
        canEdit
        onClose={() => {}}
        onSave={onSave}
      />,
    );

    // 初始值在输入框里
    expect((screen.getByLabelText('群名') as HTMLInputElement).value).toBe('项目讨论');

    // 没改动时保存按钮不可用
    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true);

    fireEvent.change(screen.getByLabelText('群名'), { target: { value: '新群名' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 公告没改 → 不应出现在 patch 里
    expect(onSave).toHaveBeenCalledWith({ title: '新群名' });
  });

  it('非管理员只能看，不能保存', () => {
    const onSave = vi.fn(async () => {});
    render(
      <GroupInfoDialog
        initialTitle="项目讨论"
        initialAnnouncement="公告内容"
        canEdit={false}
        onClose={() => {}}
        onSave={onSave}
      />,
    );
    expect(screen.getByText(/只有群主和管理员能修改/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
    expect((screen.getByLabelText('群名') as HTMLInputElement).disabled).toBe(true);
  });

  it('保存失败时显示错误且不关闭', async () => {
    const onSave = vi.fn(async () => {
      throw new Error('需要管理员权限');
    });
    const onClose = vi.fn();
    render(
      <GroupInfoDialog
        initialTitle="A"
        initialAnnouncement=""
        canEdit
        onClose={onClose}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText('群名'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByText('需要管理员权限')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('聊天窗的群信息入口', () => {
  function chatProps(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
    return {
      convId: CONV.id,
      convTitle: CONV.title,
      announcement: '',
      messages: [],
      streaming: {},
      selfId: 'u_a',
      members: [] as Member[],
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

  it('给了 onOpenGroupInfo 才显示"群信息"按钮', async () => {
    const { unmount } = render(<ChatWindow {...chatProps()} />);
    expect(screen.queryByRole('button', { name: '群信息' })).toBeNull();
    unmount();

    const onOpen = vi.fn();
    render(<ChatWindow {...chatProps({ onOpenGroupInfo: onOpen, canEditGroup: true })} />);
    const btn = await screen.findByRole('button', { name: '群信息' });
    expect(btn.getAttribute('title')).toContain('可编辑');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('会话列表右键菜单', () => {
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
      onMarkRead: vi.fn(),
      width: 300,
      ...overrides,
    } satisfies React.ComponentProps<typeof ConversationList>;
  }

  it('右键弹出菜单，可置顶与标记已读', async () => {
    const onTogglePin = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <ConversationList
        {...listProps({ unread: { c2: 5 }, onTogglePin, onMarkRead })}
      />,
    );

    fireEvent.contextMenu(screen.getByText('会话二'));
    const pin = await screen.findByRole('button', { name: '置顶' });
    fireEvent.click(pin);
    expect(onTogglePin).toHaveBeenCalledWith('c2');

    fireEvent.contextMenu(screen.getByText('会话二'));
    const read = await screen.findByRole('button', { name: '标记为已读' });
    fireEvent.click(read);
    expect(onMarkRead).toHaveBeenCalledWith('c2');
  });

  it('没有未读时"标记为已读"不可点', async () => {
    render(<ConversationList {...listProps()} />);
    fireEvent.contextMenu(screen.getByText('会话一'));
    const read = await screen.findByRole('button', { name: '标记为已读' });
    expect(read.hasAttribute('disabled')).toBe(true);
  });
});

describe('侧栏底部的连接状态与全局操作', () => {
  const convs: Conversation[] = [{ ...CONV, id: 'c1', title: '会话一' }];

  function listProps(overrides: Partial<React.ComponentProps<typeof ConversationList>> = {}) {
    return {
      convs,
      activeConvId: null,
      messages: {},
      onSelect: vi.fn(),
      onNewGroup: vi.fn(),
      selfName: '我',
      onLogout: vi.fn(),
      onOpenSearch: vi.fn(),
      unread: {},
      pinned: [],
      onTogglePin: vi.fn(),
      onMarkRead: vi.fn(),
      width: 300,
      ...overrides,
    } satisfies React.ComponentProps<typeof ConversationList>;
  }

  it('显示连接状态、主题切换与管理入口', () => {
    const onToggleTheme = vi.fn();
    const onOpenAdmin = vi.fn();
    render(
      <ConversationList
        {...listProps({ theme: 'light', onToggleTheme, isAdmin: true, onOpenAdmin })}
      />,
    );
    expect(screen.getByText('● 已连接')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('切换到深色主题'));
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '管理' }));
    expect(onOpenAdmin).toHaveBeenCalledTimes(1);
  });

  it('断线时状态变红并显示「重连中」', () => {
    render(<ConversationList {...listProps({ connected: false })} />);
    expect(screen.getByText('○ 重连中')).toBeTruthy();
  });

  it('非管理员看不到管理入口', () => {
    render(<ConversationList {...listProps({ isAdmin: false })} />);
    expect(screen.queryByRole('button', { name: '管理' })).toBeNull();
  });
});

describe('侧栏宽度', () => {
  it('持久化并夹在合理区间内', () => {
    saveSidebarWidth(360);
    expect(loadSidebarWidth()).toBe(360);
    saveSidebarWidth(10);
    expect(loadSidebarWidth()).toBe(SIDEBAR_MIN);
    saveSidebarWidth(9999);
    expect(loadSidebarWidth()).toBe(SIDEBAR_MAX);
  });

  it('没存过时用默认 300', () => {
    localStorage.clear();
    expect(loadSidebarWidth()).toBe(300);
  });
});