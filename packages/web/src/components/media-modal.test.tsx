import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MediaViewer } from './MediaViewer.js';
import { VideoBlockView } from './AttachmentBlocks.js';
import { MessageBubble } from './MessageBubble.js';
import type { Message } from '@agentlink/protocol';

/**
 * 媒体预览弹窗：图片与视频共用一套弹窗语义。
 *
 * 之前图片是一个自定义的 fixed 遮罩（没有 dialog 语义、Esc/方向键靠元素上的
 * onKeyDown，焦点不在上面就不生效）；视频干脆不能预览，只能下载。
 */

const acquireAttachmentUrl = vi.fn();
const releaseAttachmentUrl = vi.fn();

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: (...args: unknown[]) => acquireAttachmentUrl(...args),
  releaseAttachmentUrl: (...args: unknown[]) => releaseAttachmentUrl(...args),
  uploadAttachment: vi.fn(),
  downloadAttachment: vi.fn(),
  formatBytes: (n: number) => `${Math.round(n / 1024)} KB`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

beforeEach(() => {
  acquireAttachmentUrl.mockReset();
  releaseAttachmentUrl.mockReset();
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
