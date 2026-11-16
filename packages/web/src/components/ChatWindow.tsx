import type { Member, Message } from '@agentlink/protocol';
import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageBubble } from './MessageBubble.js';

interface Props {
  convTitle: string;
  messages: Message[];
  streaming: Record<string, { text: string }>;
  selfId: string;
  members: Member[];
  onSend: (text: string) => void;
  onRevoke: (messageId: string) => void;
  onInterrupt: (messageId: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onToggleMembers: () => void;
  canRevokeOthers: boolean;
}

/**
 * 聊天窗：虚拟滚动 + 向上加载历史 + 流式渲染（实现计划 M6）。
 *
 * 虚拟滚动用 `@tanstack/react-virtual`：1000 条消息也要能滚。
 */
export function ChatWindow({
  convTitle,
  messages,
  streaming,
  selfId,
  members,
  onSend,
  onRevoke,
  onInterrupt,
  onLoadMore,
  hasMore,
  loadingMore,
  onToggleMembers,
  canRevokeOthers,
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [atBottom, setAtBottom] = useState(true);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
  });

  // 新消息到达时：本来在底部就跟随，否则不动（避免打断用户翻历史）
  useEffect(() => {
    if (atBottom && messages.length > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [messages.length, atBottom, virtualizer]);

  // 流式文本变化时也跟随（逐字增长的观感）
  const streamingCount = Object.keys(streaming).length;
  useEffect(() => {
    if (atBottom && streamingCount > 0) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    }
  }, [streamingCount, streaming, atBottom, messages.length, virtualizer]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (el.scrollTop < 120 && hasMore && !loadingMore) {
      onLoadMore();
    }
  }

  function submit(): void {
    const text = draft.trim();
    if (text === '') return;
    onSend(text);
    setDraft('');
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <header
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--al-border)', background: 'var(--al-bg-sidebar)' }}
      >
        <div className="min-w-0">
          <div className="truncate font-semibold">{convTitle}</div>
          <div className="al-muted text-[11px]">{members.length} 位成员</div>
        </div>
        <button className="al-btn-ghost" onClick={onToggleMembers}>
          成员
        </button>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="al-chat-bg flex-1 overflow-y-auto"
        style={{ contain: 'strict' }}
      >
        {loadingMore && <div className="al-muted py-2 text-center text-xs">加载历史…</div>}
        {!hasMore && messages.length > 0 && (
          <div className="al-muted py-2 text-center text-xs">已到最早一条</div>
        )}

        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const msg = messages[row.index];
            if (msg === undefined) return null;
            const prev = messages[row.index - 1];
            const showSender =
              prev === undefined ||
              prev.sender.id !== msg.sender.id ||
              msg.created_at - prev.created_at > 5 * 60 * 1000;
            const isSelf = msg.sender.id === selfId;
            return (
              <div
                key={msg.id}
                data-index={row.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <MessageBubble
                  message={msg}
                  isSelf={isSelf}
                  streamingText={streaming[msg.id]?.text}
                  showSender={showSender}
                  onRevoke={onRevoke}
                  onInterrupt={onInterrupt}
                  canRevoke={isSelf || canRevokeOthers}
                />
              </div>
            );
          })}
        </div>
      </div>

      <footer className="px-3 py-2.5" style={{ borderTop: '1px solid var(--al-border)' }}>
        <div className="flex items-end gap-2">
          <button className="al-btn-ghost" title="附件（M7）" disabled>
            📎
          </button>
          <textarea
            className="al-input resize-none"
            rows={1}
            placeholder="写消息…（Enter 发送，Shift+Enter 换行）"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            style={{ maxHeight: 140 }}
          />
          <button className="al-btn" onClick={submit} disabled={draft.trim() === ''}>
            发送
          </button>
        </div>
      </footer>
    </section>
  );
}
