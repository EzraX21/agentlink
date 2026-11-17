import { useEffect, useRef } from 'react';
import type { Message } from '@agentlink/protocol';

/**
 * 消息右键菜单（对齐 TG 桌面版的基础操作：复制、引用回复、撤回）。
 *
 * 用 fixed 定位到鼠标位置；点击别处或按 Esc 关闭。
 * 菜单项按"当前用户能不能做"裁剪 —— 撤回他人消息只有 admin/owner 才有。
 */
export interface ContextMenuTarget {
  message: Message;
  x: number;
  y: number;
}

export function MessageContextMenu({
  target,
  canRevoke,
  onClose,
  onReply,
  onRevoke,
  onCopy,
  onJumpToQuote,
  canEdit,
  onEdit,
}: {
  target: ContextMenuTarget;
  canRevoke: boolean;
  /** 是否是自己的消息（只有自己能编辑）。 */
  canEdit?: boolean | undefined;
  onEdit?: ((message: Message) => void) | undefined;
  onClose: () => void;
  onReply: (message: Message) => void;
  onRevoke: (messageId: string) => void;
  onCopy: (text: string) => void;
  onJumpToQuote: (messageId: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const msg = target.message;
  const text = msg.content
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : '[文件]'))
    .join('\n');
  const revoked = msg.state === 'revoked';

  // 避免菜单超出右/下边界
  const style: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(target.x, window.innerWidth - 180),
    top: Math.min(target.y, window.innerHeight - 200),
    zIndex: 70,
    minWidth: 168,
    background: 'var(--al-bg-sidebar)',
    border: '1px solid var(--al-border)',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgb(0 0 0 / 22%)',
    padding: 4,
  };

  return (
    <div ref={ref} style={style} role="menu">
      {!revoked && (
        <Item
          label="复制文本"
          onClick={() => {
            onCopy(text);
            onClose();
          }}
        />
      )}
      {!revoked && (
        <Item
          label="引用回复"
          onClick={() => {
            onReply(msg);
            onClose();
          }}
        />
      )}
      {msg.reply_to !== null && (
        <Item
          label="跳到被引用的消息"
          onClick={() => {
            onJumpToQuote(msg.reply_to as string);
            onClose();
          }}
        />
      )}
      {!revoked && canEdit === true && onEdit !== undefined && (
        <Item
          label="编辑"
          onClick={() => {
            onEdit(msg);
            onClose();
          }}
        />
      )}
      {!revoked && canRevoke && (
        <Item
          label="撤回"
          danger
          onClick={() => {
            onRevoke(msg.id);
            onClose();
          }}
        />
      )}
      {revoked && <div className="al-muted px-2 py-1 text-xs">已撤回</div>}
    </div>
  );
}

function Item({
  label,
  onClick,
  danger,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full rounded px-2 py-1.5 text-left text-[13px] hover:bg-[var(--al-bg-hover)]"
      style={danger === true ? { color: 'var(--al-danger)' } : undefined}
    >
      {label}
    </button>
  );
}