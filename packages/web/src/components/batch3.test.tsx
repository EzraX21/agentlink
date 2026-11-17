import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { tokenizeRichText, richTextToPlain } from '../lib/richtext.js';
import { RichText } from './RichText.js';
import { ChatWindow } from './ChatWindow.js';
import type { Message } from '@agentlink/protocol';

/**
 * 第 2 批续（仍不动协议）：正文富文本、上传进度、会话内搜索。
 */

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: vi.fn(async () => 'blob:mock'),
  releaseAttachmentUrl: vi.fn(),
  uploadAttachment: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
  isImageMime: () => false,
  guessMimeFromName: () => 'application/octet-stream',
}));

const searchMock = vi.fn(async () => ({
  hits: [
    { message_id: 'm2', conv_id: 'c1', seq: 2, sender_id: 'u_b', excerpt: '含 <mark>周报</mark> 的那条', created_at: 1 },
  ],
}));

vi.mock('../lib/api.js', () => ({
  api: {
    search: (...args: unknown[]) => searchMock(...(args as [])),
  },
}));

describe('正文富文本', () => {
  it('识别 URL 并拒绝 javascript: 伪协议', () => {
    const segs = tokenizeRichText('看 https://example.com/a 和 www.foo.cn');
    const urls = segs.filter((s) => s.kind === 'url');
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatchObject({ href: 'https://example.com/a' });
    expect(urls[1]).toMatchObject({ href: 'https://www.foo.cn' });

    // javascript: 不会被当成可点链接
    const evil = tokenizeRichText('点我 javascript:alert(1)');
    expect(evil.every((s) => s.kind !== 'url')).toBe(true);
  });

  it('URL 结尾的中文句号不算进链接', () => {
    const segs = tokenizeRichText('见 https://a.com。');
    const url = segs.find((s) => s.kind === 'url');
    expect(url?.text).toBe('https://a.com');
  });

  it('识别行内代码与代码块与粗体', () => {
    const segs = tokenizeRichText('用 `pnpm build` 打包\n```js\nconst a = 1;\n```\n**注意**');
    expect(segs.some((s) => s.kind === 'code' && s.text === 'pnpm build')).toBe(true);
    expect(segs.some((s) => s.kind === 'codeblock' && s.text.includes('const a = 1;'))).toBe(true);
    expect(segs.some((s) => s.kind === 'bold' && s.text === '注意')).toBe(true);
  });

  it('纯文本化保留内容（复制用）', () => {
    const segs = tokenizeRichText('**粗** 和 `码`');
    expect(richTextToPlain(segs)).toBe('粗 和 码');
  });

  it('渲染时不把 HTML 当标记（XSS）', () => {
    const { container } = render(
      <RichText text={'<img src=x onerror=alert(1)> 和 https://ok.com'} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    // 正常链接仍然是 <a>
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://ok.com');
  });

  it('外链带 rel=noopener（防 window.opener 劫持）', () => {
    const { container } = render(<RichText text={'https://x.com'} />);
    expect(container.querySelector('a')?.getAttribute('rel')).toContain('noopener');
  });
});

function msg(id: string, text: string, seq = 1): Message {
  return {
    id,
    conv_id: 'c1',
    seq,
    sender: { id: 'u_b', kind: 'human', display_name: '小明' },
    content: [{ type: 'text', text }],
    reply_to: null,
    state: 'final',
    interrupted: false,
    created_at: Date.now(),
    revoked_at: null,
  };
}

function props(overrides: Partial<React.ComponentProps<typeof ChatWindow>> = {}) {
  return {
    convId: 'c1',
    convTitle: '测试群',
    announcement: '',
    messages: [msg('m1', '第一条')],
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

describe('会话内搜索', () => {
  it('🔍 打开搜索条，输入后按会话调用 api.search，并显示 1/1', async () => {
    searchMock.mockClear();
    render(<ChatWindow {...props()} />);
    fireEvent.click(screen.getByTitle(/在会话内搜索/));
    fireEvent.change(screen.getByPlaceholderText('在这个会话里搜索…'), {
      target: { value: '周报' },
    });

    await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy(), { timeout: 2000 });
    // 搜索必须限定在当前会话
    expect(searchMock).toHaveBeenCalledTimes(1);
    const arg = (searchMock.mock.calls[0] as unknown[])[0] as { convId?: string; q?: string };
    expect(arg.convId).toBe('c1');
    expect(arg.q).toBe('周报');
    // 命中片段用 <mark> 高亮
    expect(document.querySelector('mark')?.textContent).toBe('周报');
  });

  it('点 ↓ 跳到下一条命中（通过 onJumpToMessage 回调）', async () => {
    const onJumpToMessage = vi.fn();
    render(<ChatWindow {...props({ onJumpToMessage })} />);
    fireEvent.click(screen.getByTitle(/在会话内搜索/));
    fireEvent.change(screen.getByPlaceholderText('在这个会话里搜索…'), {
      target: { value: '周报' },
    });
    await waitFor(() => expect(screen.getByText('1/1')).toBeTruthy(), { timeout: 2000 });

    fireEvent.click(screen.getByTitle('下一条'));
    await waitFor(() =>
      expect(onJumpToMessage).toHaveBeenCalledWith('c1', 'm2', 2),
    );
  });
});

describe('上传进度', () => {
  it('上传过程中显示百分比，完成后消失', async () => {
    let report: ((p: number | null) => void) | undefined;
    const onSendAttachment = vi.fn(
      (_file: File, _reply?: string, onProgress?: (p: number | null) => void) =>
        new Promise<void>((resolve) => {
          report = onProgress;
          // 用 setTimeout 让测试有机会观察到中间态
          setTimeout(() => {
            onProgress?.(100);
            resolve();
          }, 50);
        }),
    );

    render(<ChatWindow {...props({ onSendAttachment })} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'big.bin', { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    // 中途上报 42%
    await waitFor(() => expect(report).toBeDefined());
    report?.(42);
    await waitFor(() => expect(screen.getByText('42%')).toBeTruthy());
    // 结束后进度条消失
    await waitFor(() => expect(screen.queryByText(/\d+%/)).toBeNull(), { timeout: 2000 });
  });
});
