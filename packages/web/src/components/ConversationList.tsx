import type { Conversation, Message } from '@agentlink/protocol';
import { avatarColor, formatDay, initials } from '../lib/format.js';

interface Props {
  convs: Conversation[];
  activeConvId: string | null;
  messages: Record<string, Message[]>;
  onSelect: (id: string) => void;
  onNewGroup: () => void;
  selfName: string;
  onLogout: () => void;
}

/** 左侧会话列表（需求确认书 §10.3：左侧会话列表 + 右侧聊天窗）。 */
export function ConversationList({
  convs,
  activeConvId,
  messages,
  onSelect,
  onNewGroup,
  selfName,
  onLogout,
}: Props): React.JSX.Element {
  return (
    <aside className="al-sidebar flex w-[300px] flex-col">
      <header className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: '1px solid var(--al-border)' }}>
        <button className="al-btn-ghost" onClick={onNewGroup} title="建群">
          ＋
        </button>
        <input className="al-input" placeholder="搜索（M8 接检索）" disabled style={{ opacity: 0.6 }} />
      </header>

      <div className="flex-1 overflow-y-auto py-1">
        {convs.length === 0 && (
          <div className="al-muted p-6 text-center text-xs">
            还没有会话。
            <br />
            点左上角 ＋ 建一个群。
          </div>
        )}
        {convs.map((conv) => {
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
              className="al-conv-item"
              data-active={conv.id === activeConvId}
              onClick={() => onSelect(conv.id)}
            >
              <div className="al-avatar" style={{ background: avatarColor(conv.id) }}>
                {initials(conv.title || '群')}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate font-medium">{conv.title || '(无标题)'}</span>
                  <span className="al-muted shrink-0 text-[11px]">
                    {last === undefined ? '' : formatDay(last.created_at)}
                  </span>
                </div>
                <div className="al-muted truncate text-xs">{preview}</div>
              </div>
            </div>
          );
        })}
      </div>

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
