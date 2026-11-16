import type { Message } from '@agentlink/protocol';
import { avatarColor, formatTime, initials } from '../lib/format.js';

interface Props {
  message: Message;
  isSelf: boolean;
  /** 流式消息的实时文本（内存里的真值），undefined 表示不是流式。 */
  streamingText: string | undefined;
  showSender: boolean;
  onRevoke: (messageId: string) => void;
  onInterrupt?: (messageId: string) => void;
  canRevoke: boolean;
}

/**
 * 消息气泡（需求确认书 §10.3）。
 * 自己的消息右侧主题色，他人左侧浅底；含头像、时间、昵称。
 * 流式消息逐字增长（`al-streaming` 的光标）。
 */
export function MessageBubble({
  message,
  isSelf,
  streamingText,
  showSender,
  onRevoke,
  onInterrupt,
  canRevoke,
}: Props): React.JSX.Element {
  const revoked = message.state === 'revoked';
  const streaming = message.state === 'streaming';
  const text = streaming
    ? (streamingText ?? message.content.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    : message.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');

  return (
    <div className={`flex gap-2 px-4 py-1 ${isSelf ? 'flex-row-reverse' : ''}`}>
      <div className="w-[34px] shrink-0">
        {showSender && (
          <div
            className="al-avatar"
            style={{ background: avatarColor(message.sender.id), width: 34, height: 34, fontSize: 13 }}
            title={message.sender.display_name}
          >
            {initials(message.sender.display_name)}
          </div>
        )}
      </div>

      <div className={`flex min-w-0 flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
        {showSender && (
          <div className="mb-0.5 flex items-center gap-1.5 text-[12px]">
            <span className="font-medium" style={{ color: avatarColor(message.sender.id) }}>
              {message.sender.display_name}
            </span>
            {message.sender.kind === 'agent' && <span className="al-badge">agent</span>}
          </div>
        )}

        <div className={`al-bubble ${isSelf ? 'al-bubble-self' : 'al-bubble-other'}`}>
          {revoked ? (
            <span className="al-muted italic">消息已撤回</span>
          ) : (
            <span className={streaming ? 'al-streaming' : ''}>{text}</span>
          )}
          <span className="al-muted ml-2 align-bottom text-[11px]">
            {formatTime(message.created_at)}
            {message.interrupted && ' · 已打断'}
          </span>
        </div>

        <div className="mt-0.5 flex gap-2 text-[11px] opacity-0 transition-opacity hover:opacity-100">
          {!revoked && canRevoke && (
            <button className="al-muted" onClick={() => onRevoke(message.id)}>
              撤回
            </button>
          )}
          {streaming && !isSelf && onInterrupt !== undefined && (
            <button className="al-muted" onClick={() => onInterrupt(message.id)}>
              打断
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
