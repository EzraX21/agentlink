import { useState } from 'react';
import type { Conversation } from '@agentlink/protocol';
import { Modal } from './Modal.js';

/**
 * 转发选择器（协议扩展 §6）。
 *
 * 列出"我所在的会话"，选一个就把消息转发过去（复制内容到目标会话）。
 * 用 Modal 外壳，与群信息等对话框同一套外观。
 */
export function ForwardDialog({
  convs,
  currentConvId,
  onClose,
  onPick,
}: {
  convs: readonly Conversation[];
  currentConvId: string;
  onClose: () => void;
  onPick: (convId: string) => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <Modal title="转发到" onClose={onClose}>
      <div className="w-[380px]">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">转发到</h2>
          <button className="al-muted" onClick={onClose} title="关闭" aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="max-h-[46vh] overflow-y-auto" role="list" aria-label="选择会话">
          {convs.map((c) => (
            <button
              key={c.id}
              className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-[var(--al-bg-hover)]"
              disabled={busy !== null}
              onClick={() => {
                setBusy(c.id);
                setError(null);
                void onPick(c.id)
                  .then(() => setDone(true))
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : '转发失败');
                  })
                  .finally(() => setBusy(null));
              }}
            >
              <span className="min-w-0 truncate">{c.title}</span>
              <span className="al-muted shrink-0 text-[11px]">
                {c.id === currentConvId ? '当前会话' : c.kind === 'group' ? '群' : '单聊'}
                {busy === c.id ? ' · 转发中…' : ''}
              </span>
            </button>
          ))}
        </div>

        {error !== null && (
          <div className="mt-2 text-xs" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}
        {done && (
          <div className="mt-2 text-xs" style={{ color: 'var(--al-primary)' }}>
            已转发
          </div>
        )}
      </div>
    </Modal>
  );
}
