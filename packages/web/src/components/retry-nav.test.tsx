import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message } from '@agentlink/protocol';
import { FileBlockView, ImageBlockView } from './AttachmentBlocks.js';
import { ChatWindow } from './ChatWindow.js';

/**
 * 第 11 轮：失败可重试（上传/下载/图片）+ 气泡之间 ↑↓ 导航。
 *
 * 这些是"出错之后"的体验：只显示一行红字而不给重试，用户只能重新选一遍文件
 * 或刷新页面 —— 大文件尤其烦。
 */

const downloadAttachment = vi.fn();
const acquireAttachmentUrl = vi.fn();

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: (...args: unknown[]) => acquireAttachmentUrl(...args),
  releaseAttachmentUrl: vi.fn(),
  uploadAttachment: vi.fn(),
  downloadAttachment: (...args: unknown[]) => downloadAttachment(...args),
  formatBytes: (n: number) => `${n} B`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

beforeEach(() => {
  downloadAttachment.mockReset();
  acquireAttachmentUrl.mockReset();
  localStorage.clear();
});

describe('下载失败可重试', () => {
  it('失败后按钮变成「重试」，再点一次会重新下载', async () => {
    downloadAttachment.mockRejectedValueOnce(new Error('网络断了'));
    render(<FileBlockView attachmentId="a_1" filename="report.pdf" size={100} />);

    fireEvent.click(screen.getByRole('button', { name: '下载 report.pdf' }));
    await waitFor(() => expect(screen.getByText('网络断了')).toBeTruthy());
    const retry = screen.getByRole('button', { name: '重试下载 report.pdf' });
    expect(retry.textContent).toContain('重试');

    // 第二次成功
    downloadAttachment.mockResolvedValueOnce(undefined);
    fireEvent.click(retry);
    await waitFor(() => expect(downloadAttachment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('网络断了')).toBeNull());
  });

  it('下载过程中显示百分比与 progressbar 语义', async () => {
    let report: ((p: number | null) => void) | undefined;
    downloadAttachment.mockImplementationOnce(
      (_id: string, _name: string, opts: { onProgress?: (p: number | null) => void }) =>
        new Promise<void>((resolve) => {
          report = opts.onProgress;
          setTimeout(resolve, 80);
        }),
    );

    render(<FileBlockView attachmentId="a_2" filename="big.bin" size={1024} />);
    fireEvent.click(screen.getByRole('button', { name: '下载 big.bin' }));

    await waitFor(() => expect(report).toBeDefined());
    report?.(41);
    await waitFor(() => expect(screen.getByText('下载中 41%')).toBeTruthy());
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
  });
});

describe('图片加载失败可重试', () => {
  it('失败显示重试按钮，点击后重新取图', async () => {
    acquireAttachmentUrl.mockRejectedValueOnce(new Error('403'));
    render(<ImageBlockView attachmentId="a_3" filename="pic.png" />);
    await waitFor(() => expect(screen.getByText(/图片加载失败：403/)).toBeTruthy());

    acquireAttachmentUrl.mockResolvedValueOnce('blob:ok');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() =>
      expect(document.querySelector('img')?.getAttribute('src')).toBe('blob:ok'),
    );
    expect(acquireAttachmentUrl).toHaveBeenCalledTimes(2);
  });
});

describe('上传失败可重试', () => {
  const convId = 'c_01M7JD0000000000000000000A';
  const msg: Message = {
    id: 'm1',
    conv_id: convId,
    seq: 1,
    sender: { id: 'u_b', kind: 'human', display_name: '小明' },
    content: [{ type: 'text', text: '一条消息' }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: 1,
    revoked_at: null,
  };

  function props(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
    return {
      convId,
      convTitle: '测试群',
      announcement: '',
      messages: [msg],
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

  it('上传失败后出现「重试（N）」，点了会用同一个文件重发', async () => {
    const onSendAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error('文件超过 20 MiB，无法上传'))
      .mockResolvedValueOnce(undefined);

    render(<ChatWindow {...props({ onSendAttachment })} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'huge.bin', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('重试（1）')).toBeTruthy());
    fireEvent.click(screen.getByText('重试（1）'));
    await waitFor(() => expect(onSendAttachment).toHaveBeenCalledTimes(2));
    // 第二次仍然传的是同一个文件（不用用户重新选）
    expect(onSendAttachment.mock.calls[1]?.[0]).toBe(file);
  });

  it('点「忽略」清掉错误提示', async () => {
    const onSendAttachment = vi.fn().mockRejectedValueOnce(new Error('上传失败'));
    render(<ChatWindow {...props({ onSendAttachment })} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      value: [new File(['x'], 'a.bin')],
      configurable: true,
    });
    fireEvent.change(input);

    await waitFor(() => expect(screen.getByText('忽略')).toBeTruthy());
    fireEvent.click(screen.getByText('忽略'));
    await waitFor(() => expect(screen.queryByText('上传失败')).toBeNull());
  });
});

describe('气泡之间 ↑↓ 导航', () => {
  const convId = 'c_01M7JD0000000000000000000A';
  function mkMsg(i: number): Message {
    return {
      id: `m${i}`,
      conv_id: convId,
      seq: i,
      sender: { id: 'u_b', kind: 'human', display_name: '小明' },
      content: [{ type: 'text', text: `第 ${i} 条` }],
      reply_to: null,
      state: 'final',
      interrupted: false,
      created_at: 1_700_000_000_000 + i * 1000,
      revoked_at: null,
    };
  }

  it('聚焦中间的气泡后，↓ 到下一个、↑ 回上一个', async () => {
    render(
      <ChatWindow
        convId={convId}
        convTitle="测试群"
        announcement=""
        messages={[mkMsg(1), mkMsg(2), mkMsg(3)]}
        streaming={{}}
        selfId="u_a"
        members={[]}
        onSend={vi.fn()}
        onSendAttachment={vi.fn(async () => {})}
        onJumpToMessage={vi.fn()}
        onRevoke={vi.fn()}
        onInterrupt={vi.fn()}
        onLoadMore={vi.fn()}
        hasMore={false}
        loadingMore={false}
        onToggleMembers={vi.fn()}
        canRevokeOthers={false}
        highlightMessageId={null}
      />,
    );

    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(3));
    const bubbles = screen.getAllByRole('article');
    const log = screen.getByRole('log');

    bubbles[1]?.focus();
    expect(document.activeElement).toBe(bubbles[1]);

    fireEvent.keyDown(log, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(bubbles[2]);

    fireEvent.keyDown(log, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(bubbles[1]);
  });
});