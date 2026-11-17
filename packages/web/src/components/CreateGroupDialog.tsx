import { useState } from 'react';

/**
 * 新建群组对话框。
 *
 * 单独存在（不属于管理页）的原因：协议 §5.2 的 conv.create 对**任何登录用户**开放，
 * 不要求管理员。管理页里的建群是给管理员用的跨群视角，普通用户在会话列表点 ＋
 * 也要能建群。两处复用同一个 WS 调用。
 */
export function CreateGroupDialog({
  onClose,
  onCreate,
  knownUserIds,
}: {
  onClose: () => void;
  onCreate: (title: string, memberIds: string[]) => Promise<string>;
  /** 可选：给个候选用户列表（管理页里已经拉到的人）。 */
  knownUserIds?: Array<{ id: string; label: string }>;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [memberIds, setMemberIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: 'rgb(0 0 0 / 45%)' }}
      onClick={onClose}
    >
      <div className="al-card w-[420px]" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">新建群组</h2>
          <button className="al-muted" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="al-muted mb-1 block text-xs" htmlFor="new-group-title">
          群名
        </label>
        <input
          id="new-group-title"
          className="al-input mb-3"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：项目讨论"
          autoFocus
        />

        <label className="al-muted mb-1 block text-xs" htmlFor="new-group-members">
          成员 user_id（逗号或换行分隔，可留空）
        </label>
        <textarea
          id="new-group-members"
          className="al-input mb-2"
          rows={3}
          value={memberIds}
          onChange={(e) => setMemberIds(e.target.value)}
          placeholder="u_01J..."
        />

        {knownUserIds !== undefined && knownUserIds.length > 0 && (
          <select
            className="al-input mb-3"
            value=""
            onChange={(e) => {
              if (e.target.value === '') return;
              setMemberIds(memberIds === '' ? e.target.value : `${memberIds},${e.target.value}`);
            }}
          >
            <option value="">从已知用户里加一个…</option>
            {knownUserIds.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label} — {u.id}
              </option>
            ))}
          </select>
        )}

        {error !== null && (
          <div className="mb-2 text-xs" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="al-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="al-btn"
            disabled={busy || title.trim() === ''}
            onClick={() => {
              setBusy(true);
              setError(null);
              const ids = memberIds
                .split(/[\s,]+/)
                .map((s) => s.trim())
                .filter((s) => s !== '');
              void onCreate(title.trim(), ids)
                .then(() => onClose())
                .catch((err: unknown) => {
                  setError(err instanceof Error ? err.message : '建群失败');
                })
                .finally(() => setBusy(false));
            }}
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}