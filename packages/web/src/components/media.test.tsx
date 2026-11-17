import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Message } from '@agentlink/protocol';
import { MessageBubble } from './MessageBubble.js';
import { SearchPanel } from './SearchPanel.js';

/**
 * 附件渲染 + 搜索结果渲染。
 *
 * 附件不能直接用 <img src="/api/...">（要带 Authorization 头，见 lib/attachments.ts），
 * 所以这里 mock 掉取字节的入口，验证的是"块 → 组件"的渲染逻辑。
 */

vi.mock('../lib/attachments.js', () => ({
  acquireAttachmentUrl: vi.fn(async (id: string) => `blob:mock-${id}`),
  releaseAttachmentUrl: vi.fn(),
  uploadAttachment: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
  isImageMime: () => true,
  guessMimeFromName: () => 'application/octet-stream',
}));

vi.mock('../lib/api.js', () => ({
  api: {
    search: vi.fn(async () => ({
      hits: [
        {
          message_id: 'm1',
          conv_id: 'c1',
          seq: 3,
          sender_id: 'u1',
          excerpt: '周报什么时候交，<mark>周报</mark>要写详细',
          created_at: 1_700_000_000_000,
        },
        {
          message_id: 'm2',
          conv_id: 'c1',
          seq: 4,
          sender_id: 'u1',
          // 恶意消息原文：不能被当成 HTML 执行
          excerpt: '<img src=x onerror=alert(1)> 也含 <mark>周报</mark>',
          created_at: 1_700_000_001_000,
        },
      ],
    })),
    convs: vi.fn(async () => ({ items: [{ id: 'c1', title: '测试群' }] })),
  },
}));

const baseMsg = (content: Message['content']): Message => ({
  id: 'm1',
  conv_id: 'c1',
  seq: 1,
  sender: { id: 'u1', kind: 'human', display_name: '小明' },
  content,
  reply_to: null,
  state: 'final',
  interrupted: false,
  created_at: 1_700_000_000_000,
  revoked_at: null,
});

describe('附件块渲染', () => {
  it('图片块渲染成 <img>（而不是 [image] 文字）', async () => {
    const { container } = render(
      <MessageBubble
        message={baseMsg([{ type: 'image', attachment_id: 'a_1' }])}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
      />,
    );
    await waitFor(() => {
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('blob:mock-a_1');
    });
  });

  it('文件块渲染成文件名 + 下载链接', async () => {
    render(
      <MessageBubble
        message={baseMsg([
          { type: 'file', attachment_id: 'a_2', filename: 'report.pdf', size: 2048 },
        ])}
        isSelf={false}
        streamingText={undefined}
        showSender
        onRevoke={() => {}}
        canRevoke={false}
      />,
    );
    expect(screen.getByText('report.pdf')).toBeTruthy();
    expect(screen.getByText('2048 B')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: '下载' })).toBeTruthy();
    });
  });

  it('文本 + 图片混排时两者都在', async () => {
    const { container } = render(
      <MessageBubble
        message={baseMsg([
          { type: 'text', text: '看这个' },
          { type: 'image', attachment_id: 'a_3' },
        ])}
        isSelf
        streamingText={undefined}
        showSender={false}
        onRevoke={() => {}}
        canRevoke
      />,
    );
    expect(screen.getByText('看这个')).toBeTruthy();
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
  });

  it('流式消息只渲染文本，不尝试加载附件', () => {
    const { container } = render(
      <MessageBubble
        message={{ ...baseMsg([]), state: 'streaming', seq: null }}
        isSelf={false}
        streamingText="正在生成"
        showSender
        onRevoke={() => {}}
        canRevoke={false}
      />,
    );
    expect(screen.getByText('正在生成')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('搜索结果渲染', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('命中词用 <mark> 渲染，且恶意消息不会被当成 HTML', async () => {
    const { container } = render(<SearchPanel onPick={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/搜索消息/);

    // 用 fireEvent 触发 React 的 onChange（原生 dispatchEvent 不会走 React 合成事件）
    fireEvent.change(input, { target: { value: '周报' } });

    await waitFor(() => expect(container.querySelectorAll('mark').length).toBeGreaterThan(0));

    // 关键：excerpt 里的 <img onerror> 必须以**纯文本**出现，不能变成真的 img 元素
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    // 而 <mark> 是我们要的，数量应等于两条命中
    expect(container.querySelectorAll('mark').length).toBe(2);
  });
});