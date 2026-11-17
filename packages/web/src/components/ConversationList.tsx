import type { Conversation, Message } from '@agentlink/protocol';
import { avatarColor, formatDay, initials } from '../lib/format.js';
import { orderByPinned } from '../lib/localState.js';
import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  convs: Conversation[];
  activeConvId: string | null;
  messages: Record<string, Message[]>;
  onSelect: (id: string) => void;
  onNewGroup: () => void;
  selfName: string;
  onLogout: () => void;
  /** 打开全局搜索面板。 */
  onOpenSearch: () => void;
  /** conv_id → 未读条数。 */
  unread: Record<string, number>;
  /** 置顶的 conv_id 列表（本地偏好）。 */
  pinned: string[];
  onTogglePin: (convId: string) => void;
  /** 标记已读（清本地未读）。 */
  onMarkRead: (convId: string) => void;
  /** 侧栏宽度（拖拽调整）。 */
  width: number;
}

/** 左侧会话列表（需求确认书 §10.3：左侧会话列表 + 右侧聊天窗）。 */
/** 未读角标（noUncheckedIndexedAccess 下不要直接下标取值）。 */
function UnreadBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span
      className="shrink-0 rounded-full px-1.5 text-[10px] font-medium text-white"
      style={{ background: 'var(--al-primary)' }}
      aria-label={`${count} 条未读`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function ConversationList({
  convs,
  activeConvId,
  messages,
  onSelect,
  onNewGroup,
  selfName,
  onLogout,
  onOpenSearch,
  unread,
  pinned,
  onTogglePin,
  onMarkRead,
  width,
}: Props): React.JSX.Element {
  const [menu, setMenu] = useState<{ conv: Conversation; x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // 键盘导航：roving tabindex（列表里只有一个可 Tab 焦点，↑↓ 在项之间移动）
  const [focusIndex, setFocusIndex] = useState(0);
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const ordered = orderByPinned(convs, pinned);

  useEffect(() => {
    // 会话列表变化时把焦点索引夹回范围
    setFocusIndex((i) => Math.min(Math.max(0, i), Math.max(0, ordered.length - 1)));
  }, [ordered.length]);

  const focusItem = useCallback(
    (index: number) => {
      if (ordered.length === 0) return;
      const next = Math.min(Math.max(0, index), ordered.length - 1);
      setFocusIndex(next);
      itemRefs.current[next]?.focus();
    },
    [ordered.length],
  );

  /** 列表级键盘：↑↓ Home End 移动焦点，Enter/空格由项自己处理。 */
  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          focusItem(focusIndex + 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          focusItem(focusIndex - 1);
          break;
        case 'Home':
          e.preventDefault();
          focusItem(0);
          break;
        case 'End':
          e.preventDefault();
          focusItem(ordered.length - 1);
          break;
        default:
          break;
      }
    },
    [focusIndex, focusItem, ordered.length],
  );
  return (
    <aside className="al-sidebar flex flex-col" style={{ width }}>
      <header className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: '1px solid var(--al-border)' }}>
        <button className="al-btn-ghost" onClick={onNewGroup} title="建群">
          ＋
        </button>
        <input
          className="al-input cursor-pointer"
          placeholder="搜索消息"
          readOnly
          onClick={onOpenSearch}
          onFocus={onOpenSearch}
        />
      </header>

      <div
        className="flex-1 overflow-y-auto py-1"
        role="list"
        aria-label="会话列表"
        onKeyDown={onListKeyDown}
      >
        {convs.length === 0 && (
          <div className="al-muted p-6 text-center text-xs">
            还没有会话。
            <br />
            点左上角 ＋ 建一个群。
          </div>
        )}
        {ordered.map((conv, index) => {
          const list = messages[conv.id] ?? [];
          const last = list[list.length - 1];
          const preview =
            last === undefined
              ? conv.announcement !== ''
                ? conv.announcement
                : '暂无消息'
              : last.state === 'revoked'
                ? '消息已撤回'
                : (last.content.find((b) => b.type === 'text')?.text ?? '[附件]');
          return (
            <div
              key={conv.id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              className="al-conv-item"
              data-active={conv.id === activeConvId}
              role="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-current={conv.id === activeConvId}
              onFocus={() => setFocusIndex(index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(conv.id);
                }
              }}
              onClick={() => onSelect(conv.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ conv, x: e.clientX, y: e.clientY });
              }}
            >
              <div className="al-avatar" style={{ background: avatarColor(conv.id) }}>
                {initials(conv.title || '群')}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">
                    {pinned.includes(conv.id) && <span title="已置顶">📌 </span>}
                    {conv.title || '(无标题)'}
                  </span>
                  <span className="al-muted shrink-0 text-[11px]">
                    {last === undefined ? '' : formatDay(last.created_at)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="al-muted truncate text-xs">{preview}</span>
                  <UnreadBadge count={unread[conv.id] ?? 0} />
                </div>
              </div>
              <button
                className="al-muted shrink-0 self-center px-1 text-[11px] opacity-0 hover:opacity-100 group-hover:opacity-100"
                title={pinned.includes(conv.id) ? '取消置顶' : '置顶'}
                onClick={(e) => {
                  e.stopPropagation();
                  onTogglePin(conv.id);
                }}
              >
                📌
              </button>
            </div>
          );
        })}
      </div>

      {menu !== null && (
        <div
          className="fixed inset-0 z-[75]"
          onMouseDown={() => setMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(null);
          }}
        >
          <div
            className="absolute rounded-lg p-1 text-[13px]"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 160),
              minWidth: 180,
              background: 'var(--al-bg-sidebar)',
              border: '1px solid var(--al-border)',
              boxShadow: '0 8px 24px rgb(0 0 0 / 22%)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--al-bg-hover)]"
              onClick={() => {
                onTogglePin(menu.conv.id);
                setMenu(null);
              }}
            >
              {pinned.includes(menu.conv.id) ? '取消置顶' : '置顶'}
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--al-bg-hover)]"
              disabled={(unread[menu.conv.id] ?? 0) === 0}
              onClick={() => {
                onMarkRead(menu.conv.id);
                setMenu(null);
              }}
            >
              标记为已读
            </button>
            <button
              className="block w-full rounded px-2 py-1.5 text-left hover:bg-[var(--al-bg-hover)]"
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(menu.conv.id)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => undefined);
                setMenu(null);
              }}
            >
              复制会话 ID
            </button>
          </div>
        </div>
      )}

      {copied && (
        <div
          className="fixed bottom-20 left-1/2 z-[80] -translate-x-1/2 rounded-full px-3 py-1.5 text-xs text-white"
          style={{ background: 'rgb(0 0 0 / 72%)' }}
          role="status"
        >
          已复制会话 ID
        </div>
      )}

      <footer
        className="flex items-center justify-between px-3 py-2 text-xs"
        style={{ borderTop: '1px solid var(--al-border)' }}
      >
        <span className="truncate">{selfName}</span>
        <button className="al-muted" onClick={onLogout}>
          退出
        </button>
      </footer>
    </aside>
  );
}
