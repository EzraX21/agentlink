import type { Member, Message } from '@agentlink/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MessageBubble } from './MessageBubble.js';
import { MessageContextMenu, type ContextMenuTarget } from './MessageContextMenu.js';
import { clearDraft, loadDraft, saveDraft } from '../lib/localState.js';
import { api } from '../lib/api.js';
import { Excerpt } from './SearchPanel.js';

interface Props {
  convId: string;
  convTitle: string;
  announcement: string;
  messages: Message[];
  streaming: Record<string, { text: string }>;
  selfId: string;
  members: Member[];
  /** 发送文本；replyTo 为被引用消息 id（协议 §5.3 的 reply_to）。 */
  onSend: (text: string, replyTo?: string) => void;
  /** 上传附件并作为消息发出；onProgress 用于进度条（XHR 才能拿到上传进度）。 */
  onSendAttachment: (
    file: File,
    replyTo?: string,
    onProgress?: (percent: number | null) => void,
  ) => Promise<void>;
  /** 会话内搜索命中后跳到那一条（由 App 负责按 seq 拉历史）。 */
  onJumpToMessage: (convId: string, messageId: string, seq: number) => void;
  onRevoke: (messageId: string) => void;
  onInterrupt: (messageId: string) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onToggleMembers: () => void;
  canRevokeOthers: boolean;
  /** 从搜索结果跳过来时要高亮的消息。 */
  highlightMessageId?: string | null;
}

/** 虚拟列表里的一行：日期分隔线 或 一条消息。 */
type Row =
  | { kind: 'date'; key: string; label: string }
  | {
      kind: 'msg';
      key: string;
      message: Message;
      showSender: boolean;
      quote: { author: string; text: string } | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  if (dayKey(ms) === dayKey(today.getTime())) return '今天';
  if (dayKey(ms) === dayKey(today.getTime() - DAY_MS)) return '昨天';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 一段消息的纯文本摘要（引用块、复制用）。 */
function plainText(msg: Message): string {
  return msg.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : `[文件: ${b.filename ?? '文件'}]`))
    .join(' ');
}

/**
 * 聊天窗：虚拟滚动 + 向上加载历史 + 流式渲染 + 日期分隔 + 引用回复 + 右键菜单。
 */
export function ChatWindow({
  convId,
  convTitle,
  announcement,
  messages,
  streaming,
  selfId,
  members,
  onSend,
  onSendAttachment,
  onJumpToMessage,
  onRevoke,
  onInterrupt,
  onLoadMore,
  hasMore,
  loadingMore,
  onToggleMembers,
  canRevokeOthers,
  highlightMessageId,
}: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newWhileScrolledUp, setNewWhileScrolledUp] = useState(0);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<ContextMenuTarget | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [progress, setProgress] = useState<Array<{ name: string; percent: number | null }>>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<Array<{ message_id: string; seq: number; excerpt: string }>>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const [searching, setSearching] = useState(false);
  const [showAnnouncement, setShowAnnouncement] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevCountRef = useRef(messages.length);

  // 切换会话时换草稿
  useEffect(() => {
    setDraft(loadDraft(convId));
    setReplyTo(null);
    setNewWhileScrolledUp(0);
    setShowAnnouncement(true);
    prevCountRef.current = 0;
  }, [convId]);

  const draftKey = convId;

  // toast 2 秒后自动消失
  useEffect(() => {
    if (toast === null) return;
    const timer = window.setTimeout(() => setToast(null), 2000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 会话内搜索（250ms 去抖，限定当前会话）
  useEffect(() => {
    const q = searchQuery.trim();
    if (!searchOpen || q === '') {
      setSearchHits([]);
      setSearchIdx(0);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true);
      void api
        .search({ q, convId, limit: 50 })
        .then((r) => {
          setSearchHits(r.hits);
          setSearchIdx(0);
        })
        .catch(() => setSearchHits([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchQuery, convId, searchOpen]);

  const jumpToHit = useCallback(
    (index: number) => {
      const hit = searchHits[index];
      if (hit === undefined) return;
      setSearchIdx(index);
      onJumpToMessage(convId, hit.message_id, hit.seq);
    },
    [searchHits, convId, onJumpToMessage],
  );

  // 输入草稿自动保存（每 300ms 最多写一次）
  useEffect(() => {
    if (draftKey === '') return;
    const timer = window.setTimeout(() => saveDraft(draftKey, draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft, draftKey]);

  /** 把消息列表压成 日期行 + 消息行。 */
  const rows = useMemo<Row[]>(() => {
    const byId = new Map<string, Message>();
    for (const m of messages) byId.set(m.id, m);

    const out: Row[] = [];
    let lastDay = '';
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (msg === undefined) continue;
      const dk = dayKey(msg.created_at);
      if (dk !== lastDay) {
        lastDay = dk;
        out.push({ kind: 'date', key: `date-${dk}`, label: dayLabel(msg.created_at) });
      }
      const prev = messages[i - 1];
      const showSender =
        prev === undefined ||
        prev.sender.id !== msg.sender.id ||
        msg.created_at - prev.created_at > 5 * 60 * 1000 ||
        dayKey(prev.created_at) !== dk;

      let quote: { author: string; text: string } | null = null;
      if (msg.reply_to !== null) {
        const q = byId.get(msg.reply_to);
        quote =
          q === undefined
            ? { author: '引用', text: '（消息未加载）' }
            : { author: q.sender.display_name, text: plainText(q).slice(0, 120) };
      }
      out.push({ kind: 'msg', key: msg.id, message: msg, showSender, quote });
    }
    return out;
  }, [messages]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 60,
    overscan: 8,
  });

  const scrollToBottom = useCallback(
    (behavior: 'auto' | 'smooth' = 'auto') => {
      if (rows.length === 0) return;
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end', behavior });
      setAtBottom(true);
      setNewWhileScrolledUp(0);
    },
    [rows.length, virtualizer],
  );

  // 新消息到达：在底部就跟随，否则累计"未读数"
  useEffect(() => {
    const grew = messages.length - prevCountRef.current;
    prevCountRef.current = messages.length;
    if (grew <= 0) return;
    if (atBottom) {
      virtualizer.scrollToIndex(rows.length - 1, { align: 'end' });
    } else {
      setNewWhileScrolledUp((n) => n + grew);
    }
  }, [messages.length, atBottom, rows.length, virtualizer]);

  // 从搜索结果跳过来：滚到目标消息
  useEffect(() => {
    if (highlightMessageId === null || highlightMessageId === undefined) return;
    const idx = rows.findIndex((r) => r.kind === 'msg' && r.message.id === highlightMessageId);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
  }, [highlightMessageId, rows, virtualizer]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(bottom);
    if (bottom) setNewWhileScrolledUp(0);
    if (el.scrollTop < 120 && hasMore && !loadingMore) onLoadMore();
  }

  function submit(): void {
    const text = draft.trim();
    if (text === '') return;
    onSend(text, replyTo?.id);
    setDraft('');
    if (draftKey !== '') clearDraft(draftKey);
    setReplyTo(null);
  }

  async function sendFiles(files: FileList | File[]): Promise<void> {
    const list = [...files];
    if (list.length === 0) return;
    setUploadError(null);
    for (const file of list) {
      setUploading((n) => n + 1);
      setProgress((prev) => [...prev, { name: file.name, percent: 0 }]);
      try {
        await onSendAttachment(file, replyTo?.id, (percent) => {
          setProgress((prev) =>
            prev.map((pp) => (pp.name === file.name ? { ...pp, percent } : pp)),
          );
        });
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : '附件发送失败');
      } finally {
        setUploading((n) => n - 1);
        setProgress((prev) => prev.filter((pp) => pp.name !== file.name));
      }
    }
    setReplyTo(null);
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
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="al-btn-ghost"
            title="在会话内搜索（Ctrl+F）"
            onClick={() => {
              setSearchOpen((v) => !v);
              setSearchQuery('');
              setSearchHits([]);
            }}
          >
            🔍
          </button>
          <button className="al-btn-ghost" onClick={onToggleMembers}>
            成员
          </button>
        </div>
      </header>

      {searchOpen && (
        <div
          className="px-3 py-2 text-xs"
          style={{ borderBottom: '1px solid var(--al-border)', background: 'var(--al-bg-sidebar)' }}
        >
          <div className="flex items-center gap-2">
            <input
              className="al-input"
              placeholder="在这个会话里搜索…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  jumpToHit(searchIdx);
                }
                if (e.key === 'Escape') {
                  setSearchOpen(false);
                  e.stopPropagation();
                }
              }}
              autoFocus
            />
            <span className="al-muted shrink-0">
              {searching
                ? '搜索中…'
                : searchHits.length === 0
                  ? searchQuery.trim() === ''
                    ? ''
                    : '无命中'
                  : `${searchIdx + 1}/${searchHits.length}`}
            </span>
            <button
              className="al-btn-ghost !px-2 !py-0.5"
              disabled={searchHits.length === 0}
              title="上一条（Shift+Enter）"
              onClick={() => jumpToHit((searchIdx - 1 + searchHits.length) % searchHits.length)}
            >
              ↑
            </button>
            <button
              className="al-btn-ghost !px-2 !py-0.5"
              disabled={searchHits.length === 0}
              title="下一条"
              onClick={() => jumpToHit((searchIdx + 1) % searchHits.length)}
            >
              ↓
            </button>
            <button className="al-muted shrink-0" onClick={() => setSearchOpen(false)}>
              ✕
            </button>
          </div>
          {searchHits.length > 0 && searchHits[searchIdx] !== undefined && (
            <div className="al-muted mt-1 truncate">
              <Excerpt text={searchHits[searchIdx]?.excerpt ?? ''} />
            </div>
          )}
        </div>
      )}

      {announcement !== '' && showAnnouncement && (
        <div
          className="flex items-start gap-2 px-4 py-1.5 text-[12px]"
          style={{ background: 'var(--al-bg-active)' }}
        >
          <span className="shrink-0 font-medium">公告</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{announcement}</span>
          <button className="al-muted shrink-0" onClick={() => setShowAnnouncement(false)}>
            ✕
          </button>
        </div>
      )}

      <div className="relative flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="al-chat-bg h-full overflow-y-auto"
          style={{ contain: 'strict' }}
        >
          {loadingMore && <div className="al-muted py-2 text-center text-xs">加载历史…</div>}
          {!hasMore && messages.length > 0 && (
            <div className="al-muted py-2 text-center text-xs">已到最早一条</div>
          )}

          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = rows[row.index];
              if (item === undefined) return null;
              return (
                <div
                  key={item.key}
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
                  {item.kind === 'date' ? (
                    <div className="my-2 text-center">
                      <span
                        className="al-badge"
                        style={{ background: 'var(--al-bg-sidebar)', padding: '2px 10px' }}
                      >
                        {item.label}
                      </span>
                    </div>
                  ) : (
                    <MessageBubble
                      message={item.message}
                      isSelf={item.message.sender.id === selfId}
                      streamingText={streaming[item.message.id]?.text}
                      showSender={item.showSender}
                      onRevoke={onRevoke}
                      onInterrupt={onInterrupt}
                      canRevoke={
                        item.message.sender.id === selfId || canRevokeOthers
                      }
                      quote={item.quote}
                      highlighted={item.message.id === highlightMessageId}
                      onJumpToQuote={(id) => {
                        const idx = rows.findIndex(
                          (r) => r.kind === 'msg' && r.message.id === id,
                        );
                        if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
                      }}
                      onContextMenu={(e, message) => {
                        setMenu({ message, x: e.clientX, y: e.clientY });
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {!atBottom && (
          <button
            className="al-btn absolute bottom-3 right-4 flex items-center gap-1.5 !rounded-full !px-3 !py-1.5 text-xs shadow-lg"
            onClick={() => scrollToBottom('smooth')}
          >
            {newWhileScrolledUp > 0 ? `${newWhileScrolledUp} 条新消息 ↓` : '↓ 回到底部'}
          </button>
        )}
      </div>

      <footer
        className="px-3 py-2.5"
        style={{
          borderTop: '1px solid var(--al-border)',
          background: dragging ? 'var(--al-bg-hover)' : undefined,
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (e.dataTransfer.files.length > 0) {
            e.preventDefault();
            setDragging(false);
            void sendFiles(e.dataTransfer.files);
          }
        }}
      >
        {replyTo !== null && (
          <div
            className="mb-1.5 flex items-start gap-2 rounded-lg px-2 py-1 text-[12px]"
            style={{ background: 'var(--al-bg-hover)' }}
          >
            <div className="min-w-0 flex-1 border-l-2 pl-2" style={{ borderColor: 'var(--al-primary)' }}>
              <div className="font-medium" style={{ color: 'var(--al-primary)' }}>
                回复 {replyTo.sender.display_name}
              </div>
              <div className="al-muted truncate">{plainText(replyTo)}</div>
            </div>
            <button className="al-muted shrink-0" onClick={() => setReplyTo(null)} title="取消引用">
              ✕
            </button>
          </div>
        )}

        {progress.length > 0 && (
          <div className="mb-1.5 space-y-1">
            {progress.map((p) => (
              <div key={p.name} className="text-[11px]">
                <div className="al-muted mb-0.5 flex justify-between">
                  <span className="truncate">{p.name}</span>
                  <span className="shrink-0">{p.percent === null ? '上传中…' : `${p.percent}%`}</span>
                </div>
                <div
                  style={{
                    height: 3,
                    background: 'var(--al-border)',
                    borderRadius: 2,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      width: p.percent === null ? '35%' : `${p.percent}%`,
                      height: '100%',
                      background: 'var(--al-primary)',
                      transition: 'width 120ms linear',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {uploadError !== null && (
          <div className="mb-1 text-[11px]" style={{ color: 'var(--al-danger)' }}>
            {uploadError}
          </div>
        )}
        {dragging && <div className="al-muted mb-1 text-[11px]">松手即发送</div>}

        <div className="flex items-end gap-2">
          <button
            className="al-btn-ghost"
            title="附件（点击选择，也可以拖进来或直接粘贴）"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading > 0}
          >
            {uploading > 0 ? '⏳' : '📎'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files !== null) void sendFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <textarea
            ref={textareaRef}
            className="al-input resize-none"
            rows={1}
            placeholder={
              replyTo !== null
                ? `回复 ${replyTo.sender.display_name}…（Enter 发送，Esc 取消引用）`
                : '写消息…（Enter 发送，Shift+Enter 换行）'
            }
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              // 输入框随内容增高（上限 140px，见 style.maxHeight）
              const el = e.currentTarget;
              el.style.height = 'auto';
              el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && replyTo !== null) {
                setReplyTo(null);
                e.stopPropagation();
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            style={{ maxHeight: 140 }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length > 0) {
                e.preventDefault();
                void sendFiles(files);
              }
            }}
          />
          <button className="al-btn" onClick={submit} disabled={draft.trim() === ''}>
            发送
          </button>
        </div>
      </footer>

      {toast !== null && (
        <div
          className="fixed bottom-20 left-1/2 z-[80] -translate-x-1/2 rounded-full px-3 py-1.5 text-xs text-white"
          style={{ background: 'rgb(0 0 0 / 72%)' }}
          role="status"
        >
          {toast}
        </div>
      )}

      {menu !== null && (
        <MessageContextMenu
          target={menu}
          canRevoke={
            menu.message.sender.id === selfId || canRevokeOthers
          }
          onClose={() => setMenu(null)}
          onReply={(m) => {
            setReplyTo(m);
            textareaRef.current?.focus();
          }}
          onRevoke={onRevoke}
          onCopy={(text) => {
            void navigator.clipboard
              ?.writeText(text)
              .then(() => setToast('已复制'))
              .catch(() => setToast('复制失败（浏览器不允许）'));
          }}
          onJumpToQuote={(id) => {
            const idx = rows.findIndex((r) => r.kind === 'msg' && r.message.id === id);
            if (idx >= 0) virtualizer.scrollToIndex(idx, { align: 'center' });
          }}
        />
      )}
    </section>
  );
}

