import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaViewer } from './MediaViewer.js';
import { VideoBlockView } from './AttachmentBlocks.js';
import { MessageBubble } from './MessageBubble.js';
import { ReactionBar } from './ReactionBar.js';
import { ChatWindow } from './ChatWindow.js';
import type { Message } from '@agentlink/protocol';

/**
 * 媒体预览弹窗：图片与视频共用一套弹窗语义。
 *
 * 之前图片是一个自定义的 fixed 遮罩（没有 dialog 语义、Esc/方向键靠元素上的
 * onKeyDown，焦点不在上面就不生效）；视频干脆不能预览，只能下载。
 */

const acquireAttachmentUrl = vi.fn();
const releaseAttachmentUrl = vi.fn();
const fetchAttachmentThumbnail = vi.fn();

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: (...args: unknown[]) => acquireAttachmentUrl(...args),
  releaseAttachmentUrl: (...args: unknown[]) => releaseAttachmentUrl(...args),
  fetchAttachmentThumbnail: (...args: unknown[]) => fetchAttachmentThumbnail(...args),
  uploadAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  formatBytes: (n: number) => `${Math.round(n / 1024)} KB`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

beforeEach(() => {
  acquireAttachmentUrl.mockReset();
  releaseAttachmentUrl.mockReset();
  fetchAttachmentThumbnail.mockReset();
  // 默认没有缩略图（服务端没装 ffmpeg / 不是视频）
  fetchAttachmentThumbnail.mockResolvedValue(null);
});

function viewerProps(overrides: Partial<React.ComponentProps<typeof MediaViewer>> = {}) {
  return {
    title: '图片.png',
    caption: '12 KB',
    onClose: vi.fn(),
    ...overrides,
  } satisfies React.ComponentProps<typeof MediaViewer>;
}

describe('MediaViewer 弹窗语义', () => {
  it('是 role=dialog + aria-modal，并以标题为 label', () => {
    render(
      <MediaViewer {...viewerProps()}>
        <img alt="预览" />
      </MediaViewer>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const id = dialog.getAttribute('aria-labelledby') ?? '';
    expect(document.getElementById(id)?.textContent).toContain('图片.png');
  });

  it('Esc 关闭', () => {
    const onClose = vi.fn();
    render(
      <MediaViewer {...viewerProps({ onClose })}>
        <img alt="预览" />
      </MediaViewer>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('← → 切换上一张/下一张', () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    render(
      <MediaViewer {...viewerProps({ onPrev, onNext, position: { index: 2, total: 5 } })}>
        <img alt="预览" />
      </MediaViewer>,
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);
    // 序号显示在标题里
    expect(screen.getByText(/2\/5/)).toBeTruthy();
  });

  it('关闭后焦点回到打开前的位置', () => {
    const before = document.createElement('button');
    before.textContent = '触发按钮';
    document.body.appendChild(before);
    before.focus();

    const { unmount } = render(
      <MediaViewer {...viewerProps()}>
        <img alt="预览" />
      </MediaViewer>,
    );
    expect(document.activeElement).not.toBe(before);
    unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('点遮罩关闭，但点内容不关闭', () => {
    const onClose = vi.fn();
    render(
      <MediaViewer {...viewerProps({ onClose })}>
        <img alt="预览" data-testid="media" />
      </MediaViewer>,
    );
    fireEvent.mouseDown(screen.getByTestId('media'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('视频预览', () => {
  it('视频默认不预载：只有「播放」按钮', () => {
    render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    expect(screen.getByRole('button', { name: '播放 demo.mp4' })).toBeTruthy();
    expect(acquireAttachmentUrl).not.toHaveBeenCalled();
  });

  it('点播放后才取字节，并在弹窗里渲染 <video controls>', async () => {
    let report: ((p: number | null) => void) | undefined;
    acquireAttachmentUrl.mockImplementationOnce(
      (_id: string, _name: string, cb: (p: number | null) => void) => {
        report = cb;
        return Promise.resolve('blob:video');
      },
    );

    render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    fireEvent.click(screen.getByRole('button', { name: '播放 demo.mp4' }));

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:video');
    expect(video?.hasAttribute('controls')).toBe(true);
    report?.(100);
  });

  it('关闭视频弹窗时释放 blob 引用（否则内存一直涨）', async () => {
    acquireAttachmentUrl.mockResolvedValueOnce('blob:video');
    render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: '播放 demo.mp4' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: '关闭预览（Esc）' }));
    await waitFor(() => expect(releaseAttachmentUrl).toHaveBeenCalledWith('a_v'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('加载失败时卡片上显示原因', async () => {
    acquireAttachmentUrl.mockRejectedValueOnce(new Error('404'));
    render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" />);
    fireEvent.click(screen.getByRole('button', { name: '播放 demo.mp4' }));
    await waitFor(() => expect(screen.getByText('404')).toBeTruthy());
  });
});

describe('视频缩略图', () => {
  it('有缩略图时渲染 <img>（不是 🎬 图标）', async () => {
    fetchAttachmentThumbnail.mockResolvedValueOnce('blob:thumb');
    const { container } = render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('blob:thumb');
    });
  });

  it('缩略图仍然**不**预载视频本体（只拉几十 KB 的图）', async () => {
    fetchAttachmentThumbnail.mockResolvedValueOnce('blob:thumb');
    render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    await waitFor(() => expect(fetchAttachmentThumbnail).toHaveBeenCalledWith('a_v'));
    expect(acquireAttachmentUrl).not.toHaveBeenCalled();
  });

  it('没有缩略图时退回纯文字卡片（不渲染坏图）', async () => {
    fetchAttachmentThumbnail.mockResolvedValueOnce(null);
    const { container } = render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    await waitFor(() => expect(fetchAttachmentThumbnail).toHaveBeenCalled());
    expect(container.querySelector('img')).toBeNull();
    // 播放按钮还在
    expect(screen.getByRole('button', { name: '播放 demo.mp4' })).toBeTruthy();
  });

  it('缩略图取失败时不报错，卡片照常显示', async () => {
    fetchAttachmentThumbnail.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(<VideoBlockView attachmentId="a_v" filename="demo.mp4" size={2048} />);
    await waitFor(() => expect(fetchAttachmentThumbnail).toHaveBeenCalled());
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: '播放 demo.mp4' })).toBeTruthy();
  });
});

describe('消息里的视频块', () => {
  function msg(block: Message['content'][number]): Message {
    return {
      id: 'm_v',
      conv_id: 'c_1',
      seq: 1,
      sender: { id: 'u_b', kind: 'human', display_name: '小明' },
      content: [block],
      reply_to: null,
      state: 'final',
      interrupted: false,
      created_at: 1,
      revoked_at: null,
    };
  }

  it('文件名是 .mp4 的 file 块渲染成视频卡片', () => {
    render(
      <MessageBubble
        message={msg({ type: 'file', attachment_id: 'a_v', filename: 'clip.mp4', size: 1024 })}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
      />,
    );
    expect(screen.getByRole('button', { name: '播放 clip.mp4' })).toBeTruthy();
  });

  it('普通文件仍是文件卡片（不是视频）', () => {
    render(
      <MessageBubble
        message={msg({ type: 'file', attachment_id: 'a_f', filename: 'report.pdf', size: 1024 })}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
      />,
    );
    expect(screen.getByRole('button', { name: '下载 report.pdf' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '播放 report.pdf' })).toBeNull();
  });
});

describe('已读双勾', () => {
  const base: Message = {
    id: 'm_r',
    conv_id: 'c_1',
    seq: 10,
    sender: { id: 'u_self', kind: 'human', display_name: '我' },
    content: [{ type: 'text', text: '我的消息' }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: 1,
    revoked_at: null,
  };

  it('对方没读时显示单勾', () => {
    render(
      <MessageBubble
        message={base}
        isSelf
        streamingText={undefined}
        showSender={false}
        onRevoke={() => {}}
        canRevoke={false}
        readSeq={3}
      />,
    );
    expect(screen.getByLabelText('已送达，未读').textContent).toContain('✓');
  });

  it('对方读到这条之后显示双勾', () => {
    render(
      <MessageBubble
        message={base}
        isSelf
        streamingText={undefined}
        showSender={false}
        onRevoke={() => {}}
        canRevoke={false}
        readSeq={10}
      />,
    );
    expect(screen.getByLabelText('对方已读').textContent).toContain('✓✓');
  });

  it('别人的消息不显示勾', () => {
    render(
      <MessageBubble
        message={{ ...base, sender: { id: 'u_b', kind: 'human', display_name: '小明' } }}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
        readSeq={10}
      />,
    );
    expect(screen.queryByLabelText('对方已读')).toBeNull();
    expect(screen.queryByLabelText('已送达，未读')).toBeNull();
  });
});

describe('弹窗必须是独立浮层（不随消息滚动）', () => {
  it('Modal 通过 portal 挂到 body，而不是留在渲染它的容器里', () => {
    const { container } = render(
      <div data-testid="message-list">
        <MediaViewer {...viewerProps()}>
          <img alt="预览" />
        </MediaViewer>
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    // 不在"消息列表"容器里
    expect(container.contains(dialog)).toBe(false);
    // 但确实挂在 body 上（能正常显示与查询）
    expect(document.body.contains(dialog)).toBe(true);
  });

  it('滚动容器里的弹窗位置不受容器影响（结构上已脱离）', () => {
    render(
      <div data-testid="scroller" style={{ contain: 'strict', overflow: 'auto', height: 100 }}>
        <MediaViewer {...viewerProps()}>
          <img alt="预览" />
        </MediaViewer>
      </div>,
    );
    const dialog = screen.getByRole('dialog');
    // 祖先链里没有那个带 contain:strict 的滚动容器
    let node: HTMLElement | null = dialog.parentElement;
    let foundScroller = false;
    while (node !== null) {
      if (node.dataset['testid'] === 'scroller') foundScroller = true;
      node = node.parentElement;
    }
    expect(foundScroller).toBe(false);
  });
});

describe('表情回应（协议扩展 §2）', () => {
  const reactions = [
    { emoji: '👍', user_ids: ['u_a', 'u_b'] },
    { emoji: '🎉', user_ids: ['u_b'] },
  ];

  it('显示每个表情与人数，自己点过的高亮并标 aria-pressed', () => {
    render(<ReactionBar reactions={reactions} selfId="u_a" onToggle={() => {}} />);
    const thumbs = screen.getByRole('button', { name: /👍 2 人（含我）/ });
    expect(thumbs.getAttribute('aria-pressed')).toBe('true');
    const party = screen.getByRole('button', { name: /🎉 1 人/ });
    expect(party.getAttribute('aria-pressed')).toBe('false');
  });

  it('点 chip 触发切换（服务端按 (消息,人,emoji) 去重）', () => {
    const onToggle = vi.fn();
    render(<ReactionBar reactions={reactions} selfId="u_a" onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: /👍/ }));
    expect(onToggle).toHaveBeenCalledWith('👍');
  });

  it('点「＋」展开面板，选表情后收起并触发', () => {
    const onToggle = vi.fn();
    render(<ReactionBar reactions={[]} selfId="u_a" onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: '添加表情回应' }));
    const pick = screen.getByRole('button', { name: '回应 ❤️' });
    fireEvent.click(pick);
    expect(onToggle).toHaveBeenCalledWith('❤️');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('没有回应时只显示「＋」', () => {
    render(<ReactionBar reactions={undefined} selfId="u_a" onToggle={() => {}} />);
    expect(screen.getByRole('button', { name: '添加表情回应' })).toBeTruthy();
  });
});

describe('编辑消息 UI（协议扩展 §3）', () => {
  const msg: Message = {
    id: 'm_edit',
    conv_id: 'c_1',
    seq: 3,
    sender: { id: 'u_self', kind: 'human', display_name: '我' },
    content: [{ type: 'text', text: '原始内容' }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: 1,
    revoked_at: null,
    edited_at: null,
  };

  function props(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
    return {
      convId: 'c_1',
      convTitle: '群',
      announcement: '',
      messages: [msg],
      streaming: {},
      selfId: 'u_self',
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

  it('自己的消息右键菜单里有「编辑」', async () => {
    render(<ChatWindow {...props({ onEdit: async () => {} })} />);
    fireEvent.contextMenu(screen.getByRole('article'));
    expect(await screen.findByRole('menuitem', { name: '编辑' })).toBeTruthy();
  });

  it('别人的消息没有「编辑」', async () => {
    render(
      <ChatWindow
        {...props({
          messages: [{ ...msg, sender: { id: 'u_other', kind: 'human', display_name: '别人' } }],
          onEdit: async () => {},
        })}
      />,
    );
    fireEvent.contextMenu(screen.getByRole('article'));
    await screen.findByRole('menuitem', { name: '复制文本' });
    expect(screen.queryByRole('menuitem', { name: '编辑' })).toBeNull();
  });

  it('点「编辑」后输入框回填原文，Enter 保存调用 onEdit', async () => {
    const onEdit = vi.fn(async () => {});
    render(<ChatWindow {...props({ onEdit })} />);

    fireEvent.contextMenu(screen.getByRole('article'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));

    const ta = screen.getByLabelText('消息输入') as HTMLTextAreaElement;
    expect(ta.value).toBe('原始内容');
    expect(screen.getByText(/正在编辑这条消息/)).toBeTruthy();

    fireEvent.change(ta, { target: { value: '改过的内容' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith('m_edit', '改过的内容'));
    // 保存后退出编辑态
    await waitFor(() => expect(screen.queryByText(/正在编辑这条消息/)).toBeNull());
  });

  it('Esc 取消编辑，不发请求', async () => {
    const onEdit = vi.fn(async () => {});
    render(<ChatWindow {...props({ onEdit })} />);
    fireEvent.contextMenu(screen.getByRole('article'));
    fireEvent.click(await screen.findByRole('menuitem', { name: '编辑' }));

    const ta = screen.getByLabelText('消息输入');
    fireEvent.keyDown(ta, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/正在编辑这条消息/)).toBeNull());
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('已编辑的消息显示「已编辑」标记', () => {
    render(
      <ChatWindow
        {...props({ messages: [{ ...msg, edited_at: 1_700_000_000_000 }] })}
      />,
    );
    expect(screen.getByText(/已编辑/)).toBeTruthy();
  });
});

describe('置顶横幅（协议扩展 §4）', () => {
  const pinnedMsg: Message = {
    id: 'm_pin',
    conv_id: 'c_1',
    seq: 2,
    sender: { id: 'u_other', kind: 'human', display_name: '小明' },
    content: [{ type: 'text', text: '重要通知' }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: 1,
    revoked_at: null,
  };

  function props(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
    return {
      convId: 'c_1',
      convTitle: '群',
      announcement: '',
      messages: [pinnedMsg],
      streaming: {},
      selfId: 'u_self',
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

  it('有置顶时显示横幅与发送者 + 内容摘要', () => {
    render(<ChatWindow {...props({ pinnedMessageId: 'm_pin' })} />);
    expect(screen.getByText(/置顶：/)).toBeTruthy();
    expect(screen.getByText(/小明：重要通知/)).toBeTruthy();
  });

  it('没有置顶时不显示横幅', () => {
    render(<ChatWindow {...props({ pinnedMessageId: null })} />);
    expect(screen.queryByText(/置顶：/)).toBeNull();
  });

  it('置顶的消息已被删除时横幅给出说明', () => {
    render(<ChatWindow {...props({ pinnedMessageId: 'm_gone' })} />);
    expect(screen.getByText(/消息已删除/)).toBeTruthy();
  });

  it('只有传了 onUnpin 才显示取消按钮', () => {
    const { unmount } = render(<ChatWindow {...props({ pinnedMessageId: 'm_pin' })} />);
    expect(screen.queryByLabelText('取消置顶')).toBeNull();
    unmount();
    render(<ChatWindow {...props({ pinnedMessageId: 'm_pin', onUnpin: () => {} })} />);
    expect(screen.getByLabelText('取消置顶')).toBeTruthy();
  });
});
