import { useState } from 'react';
import type { ContentBlock, Message } from '@agentlink/protocol';
import { avatarColor, formatTime, initials } from '../lib/format.js';
import { FileBlockView, ImageBlockView, VideoBlockView } from './AttachmentBlocks.js';
import { ReactionBar } from './ReactionBar.js';
import { RichText } from './RichText.js';

interface Props {
  message: Message;
  isSelf: boolean;
  /** 流式消息的实时文本（内存里的真值），undefined 表示不是流式。 */
  streamingText: string | undefined;
  showSender: boolean;
  onRevoke: (messageId: string) => void;
  onInterrupt?: (messageId: string) => void;
  canRevoke: boolean;
  /** 被引用消息的摘要文本（reply_to 指向的那条）；null 表示无引用。 */
  quote?: { author: string; text: string } | null;
  /** 右键 / 长按弹出菜单。 */
  onContextMenu?: (e: React.MouseEvent, message: Message) => void;
  /** 点引用块跳到被引用消息。 */
  onJumpToQuote?: (messageId: string) => void;
  /** 高亮（从搜索结果跳过来时用）。 */
  highlighted?: boolean;
  /** 还在离线发件箱里（尚未送达服务端）。 */
  pending?: boolean;
  /** 键盘：在气泡上按 Enter/空格打开操作菜单（焦点位置由调用方算）。 */
  onOpenMenuByKeyboard?: (message: Message, element: HTMLElement) => void;
  /** 对方（群里是"全员"）读到的最大 seq，用来画 ✓ / ✓✓。 */
  readSeq?: number;
  /** 切换某个表情回应（协议扩展 §2）。不给就不显示回应栏。 */
  onToggleReaction?: ((message: Message, emoji: string) => void) | undefined;
  /** 自己的用户 id（判断"我点过这个表情没有"）。 */
  selfId?: string | undefined;
}

/**
 * 消息气泡（需求确认书 §10.3：自己的右侧主题色、他人左侧浅底，含头像/昵称/时间）。
 * 支持三种内容块（文本 / 图片 / 文件）、引用回复、流式光标、撤回态。
 */
export function MessageBubble({
  message,
  isSelf,
  streamingText,
  showSender,
  onRevoke,
  onInterrupt,
  canRevoke,
  quote,
  onContextMenu,
  onJumpToQuote,
  highlighted,
  pending,
  onOpenMenuByKeyboard,
  readSeq,
  onToggleReaction,
  selfId,
}: Props): React.JSX.Element {
  const revoked = message.state === 'revoked';
  const streaming = message.state === 'streaming';
  const blocks: ContentBlock[] = message.content;
  // 同一消息里可能有多张图：灯箱支持上/下张（TG 也是这样）
  const [zoomIndex, setZoomIndex] = useState<number | null>(null);
  const imageIndexes = blocks
    .map((b, i) => (b.type === 'image' ? i : -1))
    .filter((i) => i >= 0);
  const zoomPos = zoomIndex === null ? -1 : imageIndexes.indexOf(zoomIndex);
  const streamingTextOnly =
    streamingText ?? message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');

  return (
    <div
      className={`flex gap-2 px-4 py-1 ${isSelf ? 'flex-row-reverse' : ''}`}
      onContextMenu={(e) => {
        if (onContextMenu !== undefined) {
          e.preventDefault();
          onContextMenu(e, message);
        }
      }}
      data-message-id={message.id}
      // 键盘可达：气泡能聚焦，Enter/空格等价于右键（打开操作菜单）
      tabIndex={onOpenMenuByKeyboard === undefined ? -1 : 0}
      role="article"
      aria-label={`${message.sender.display_name}：${message.content
        .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '图片' : '文件'))
        .join(' ')
        .slice(0, 80)}`}
      onKeyDown={(e) => {
        if (onOpenMenuByKeyboard === undefined) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenMenuByKeyboard(message, e.currentTarget);
        }
      }}
    >
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

        <div
          className={`al-bubble ${isSelf ? 'al-bubble-self' : 'al-bubble-other'}`}
          style={
            highlighted === true
              ? { outline: '2px solid var(--al-primary)', outlineOffset: 2 }
              : undefined
          }
        >
          {quote !== null && quote !== undefined && !revoked && (
            <button
              type="button"
              className="mb-1 block w-full max-w-full border-l-2 pl-2 text-left text-[12px]"
              style={{ borderColor: 'var(--al-primary)', opacity: 0.85 }}
              onClick={() => {
                if (message.reply_to !== null && onJumpToQuote !== undefined) {
                  onJumpToQuote(message.reply_to);
                }
              }}
              title="跳到被引用的消息"
            >
              <span className="font-medium" style={{ color: 'var(--al-primary)' }}>
                {quote.author}
              </span>
              <span className="al-muted block truncate">{quote.text}</span>
            </button>
          )}

          {revoked ? (
            <span className="al-muted italic">消息已撤回</span>
          ) : streaming ? (
            <span className="al-streaming">{streamingTextOnly}</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              {blocks.map((block, i) => {
                if (block.type === 'text') {
                  // URL / 行内代码 / 代码块 / 粗体；只产出文本节点，不拼 HTML
                  return (
                    <span key={i}>
                      <RichText text={block.text} />
                    </span>
                  );
                }
                if (block.type === 'image') {
                  return (
                    <ImageBlockView
                      key={i}
                      attachmentId={block.attachment_id}
                      filename={undefined}
                      width={block.width}
                      height={block.height}
                      zoomed={zoomIndex === i}
                      onZoom={() => setZoomIndex(i)}
                      onCloseZoom={() => setZoomIndex(null)}
                      position={
                        imageIndexes.length > 1
                          ? { index: zoomPos + 1, total: imageIndexes.length }
                          : null
                      }
                      onPrev={
                        imageIndexes.length > 1
                          ? () => {
                              const prev = imageIndexes[(zoomPos - 1 + imageIndexes.length) % imageIndexes.length];
                              if (prev !== undefined) setZoomIndex(prev);
                            }
                          : undefined
                      }
                      onNext={
                        imageIndexes.length > 1
                          ? () => {
                              const next = imageIndexes[(zoomPos + 1) % imageIndexes.length];
                              if (next !== undefined) setZoomIndex(next);
                            }
                          : undefined
                      }
                    />
                  );
                }
                // 协议只有 image / file 两种块（没有 video 类型），
                // 所以"是不是视频"只能按文件名判断 —— 不新增协议字段。
                const looksLikeVideo = /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(block.filename ?? '');
                if (looksLikeVideo) {
                  return (
                    <VideoBlockView
                      key={i}
                      attachmentId={block.attachment_id}
                      filename={block.filename}
                      size={block.size}
                    />
                  );
                }
                return (
                  <FileBlockView
                    key={i}
                    attachmentId={block.attachment_id}
                    filename={block.filename}
                    size={block.size}
                  />
                );
              })}
            </div>
          )}
          <span className="al-muted ml-2 align-bottom text-[11px]">
            {formatTime(message.created_at)}
            {message.interrupted && ' · 已打断'}
            {message.edited_at !== undefined && message.edited_at !== null && ' · 已编辑'}
            {pending === true && (
              <span title="尚未送达服务器，连接恢复后会自动重发" style={{ opacity: 0.8 }}>
                {' '}
                · 待发送 ⏳
              </span>
            )}
            {isSelf && pending !== true && typeof message.seq === 'number' && (
              <span
                title={
                  readSeq !== undefined && readSeq >= message.seq ? '对方已读' : '已送达，对方还没读'
                }
                style={{ opacity: 0.85 }}
                aria-label={
                  readSeq !== undefined && readSeq >= message.seq ? '对方已读' : '已送达，未读'
                }
              >
                {' '}
                {readSeq !== undefined && readSeq >= message.seq ? '✓✓' : '✓'}
              </span>
            )}
          </span>
        </div>

        {/* 表情回应：撤回的消息不显示（服务端撤回时已清空） */}
        {!revoked && onToggleReaction !== undefined && (
          <ReactionBar
            reactions={message.reactions}
            selfId={selfId ?? ''}
            onToggle={(emoji) => onToggleReaction(message, emoji)}
          />
        )}

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