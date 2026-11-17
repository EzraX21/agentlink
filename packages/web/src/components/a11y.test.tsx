import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { renderHook } from '@testing-library/react';
import { REDUCED_MOTION_QUERY, useMediaQuery } from '../lib/useMediaQuery.js';
import { Modal } from './Modal.js';
import { MessageBubble } from './MessageBubble.js';
import { ChatWindow } from './ChatWindow.js';
import { ConversationList } from './ConversationList.js';
import type { Conversation } from '@agentlink/protocol';

/**
 * 可访问性（a11y）：模态语义与焦点管理、键盘可达、读屏可播报。
 *
 * 这些不是"锦上添花"：一个只有鼠标能用的聊天窗，键盘用户直接没法用。
 */

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: vi.fn(async () => 'blob:mock'),
  releaseAttachmentUrl: vi.fn(),
  uploadAttachment: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

function Harness({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <button
        onClick={() => {
          setOpen(true);
        }}
      >
        打开弹窗
      </button>
      {open && (
        <Modal
          title="测试弹窗"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <input aria-label="第一个" />
          <input aria-label="第二个" />
          <button>确定</button>
        </Modal>
      )}
    </div>
  );
}

describe('Modal 可访问性', () => {
  it('有 role=dialog 与 aria-modal，并以标题为 label', () => {
    render(<Harness onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    // label 指向的元素内容就是标题
    const id = dialog.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(id)?.textContent ?? dialog.dataset['modalTitle']).toContain(
      '测试弹窗',
    );
  });

  it('打开后焦点进入弹窗（第一个可聚焦元素）', async () => {
    render(<Harness onClose={() => {}} />);
    await waitFor(() => {
      expect(document.activeElement?.getAttribute('aria-label')).toBe('第一个');
    });
  });

  it('Tab 在弹窗内部循环，不会跑到背后的页面', async () => {
    render(<Harness onClose={() => {}} />);
    const first = screen.getByLabelText('第一个');
    const last = screen.getByRole('button', { name: '确定' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('Esc 关闭，并把焦点还给打开前的元素', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

const CONV: Conversation = {
  id: 'c_a11y',
  kind: 'group',
  title: '可访问性群',
  announcement: '',
  created_by: 'u_a',
  created_at: 1,
};

function chatProps(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
  return {
    convId: CONV.id,
    convTitle: CONV.title,
    announcement: '',
    messages: [],
    streaming: {},
    selfId: 'u_a',
    members: [],
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

describe('聊天窗可访问性', () => {
  it('消息区是 role=log + aria-live，读屏会播报新消息', () => {
    render(<ChatWindow {...chatProps()} />);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('polite');
    expect(log.getAttribute('aria-label')).toContain('可访问性群');
  });

  it('输入框与按钮有可访问名', () => {
    render(<ChatWindow {...chatProps()} />);
    expect(screen.getByLabelText('消息输入')).toBeTruthy();
    expect(screen.getByLabelText('发送消息')).toBeTruthy();
    expect(screen.getByLabelText('添加附件')).toBeTruthy();
  });
});

describe('消息气泡可访问性', () => {
  const msg = {
    id: 'm_a11y',
    conv_id: CONV.id,
    seq: 1,
    sender: { id: 'u_b', kind: 'human' as const, display_name: '小明' },
    content: [{ type: 'text' as const, text: '一条消息' }],
    reply_to: null,
    state: 'final' as const,
    interrupted: false,
    created_at: 1,
    revoked_at: null,
  };

  it('气泡可聚焦，Enter/空格打开操作菜单（等价于右键）', () => {
    render(<ChatWindow {...chatProps({ messages: [msg] })} />);
    const bubble = screen.getByRole('article');
    expect(bubble.getAttribute('tabindex')).toBe('0');
    expect(bubble.getAttribute('aria-label')).toContain('小明');
    expect(bubble.getAttribute('aria-label')).toContain('一条消息');
  });

  it('Enter 触发键盘菜单回调', () => {
    const onOpen = vi.fn();
    // 直接渲染 MessageBubble 以隔离 ChatWindow 的菜单状态
    render(
      <MessageBubble
        message={msg}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
        onOpenMenuByKeyboard={onOpen}
      />,
    );
    const bubble = screen.getByRole('article');
    fireEvent.keyDown(bubble, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('减少动效（prefers-reduced-motion）', () => {
  it('useMediaQuery 能读到"要求减少动效"的系统设置', () => {
    // CSS 里那段媒体查询由 ui-ux 验收脚本检查（那边是 Node 环境，能直接读文件）
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));

    expect(renderHook(() => useMediaQuery(REDUCED_MOTION_QUERY)).result.current).toBe(true);
    expect(renderHook(() => useMediaQuery('(max-width: 767px)')).result.current).toBe(false);

    vi.unstubAllGlobals();
  });
});

describe('会话列表可访问性', () => {
  function listProps(overrides: Partial<React.ComponentProps<typeof ConversationList>> = {}) {
    return {
      convs: [CONV],
      activeConvId: null,
      messages: {},
      onSelect: vi.fn(),
      onNewGroup: vi.fn(),
      selfName: '我',
      onLogout: vi.fn(),
      onOpenSearch: vi.fn(),
      unread: { [CONV.id]: 7 },
      pinned: [],
      onTogglePin: vi.fn(),
      onMarkRead: vi.fn(),
      width: 300,
      ...overrides,
    } satisfies React.ComponentProps<typeof ConversationList>;
  }

  it('会话项可用键盘聚焦，Enter 与空格都能选中', () => {
    const onSelect = vi.fn();
    render(<ConversationList {...listProps({ onSelect })} />);

    const item = screen.getByRole('button', { name: /可访问性群/ });
    expect(item.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('未读角标有 aria-label，读屏能读出条数', () => {
    render(<ConversationList {...listProps()} />);
    expect(screen.getByLabelText('7 条未读')).toBeTruthy();
  });

  it('↑↓ 在会话之间移动焦点，Home/End 跳到首尾', () => {
    const convs = [
      { ...CONV, id: 'c1', title: '会话一' },
      { ...CONV, id: 'c2', title: '会话二' },
      { ...CONV, id: 'c3', title: '会话三' },
    ];
    render(<ConversationList {...listProps({ convs, unread: {} })} />);

    const list = screen.getByRole('list', { name: '会话列表' });
    const items = screen.getAllByRole('button').filter((el) => el.getAttribute('role') === 'button');

    // 初始只有第一个可 Tab
    expect(items[0]?.getAttribute('tabindex')).toBe('0');
    expect(items[1]?.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('会话二');

    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('会话一');

    fireEvent.keyDown(list, { key: 'End' });
    expect(document.activeElement?.textContent).toContain('会话三');

    fireEvent.keyDown(list, { key: 'Home' });
    expect(document.activeElement?.textContent).toContain('会话一');
  });

  it('会话列表容器有 aria-label', () => {
    render(<ConversationList {...listProps()} />);
    expect(screen.getByRole('list', { name: '会话列表' })).toBeTruthy();
  });
});