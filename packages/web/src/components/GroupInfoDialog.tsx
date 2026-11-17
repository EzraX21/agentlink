import { useId, useState } from 'react';
import { Modal } from './Modal.js';

/**
 * 群信息编辑（群名 + 公告）。
 *
 * 走协议 §5.2 的 `group.update`（服务端已实现，权限要求 owner/admin，
 * 见协议 §10 权限矩阵）。保存成功后服务端会推 `group.update` 事件，
 * 所以所有成员的界面都会立刻更新，不需要刷新。
 */
export function GroupInfoDialog({
  initialTitle,
  initialAnnouncement,
  canEdit,
  onClose,
  onSave,
}: {
  initialTitle: string;
  initialAnnouncement: string;
  canEdit: boolean;
  onClose: () => void;
  onSave: (patch: { title?: string; announcement?: string }) => Promise<void>;
}): React.JSX.Element {
  const [title, setTitle] = useState(initialTitle);
  const [announcement, setAnnouncement] = useState(initialAnnouncement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const dirty =
    title !== initialTitle || announcement !== initialAnnouncement;

  return (
    <Modal title="群信息" onClose={onClose} labelledBy={titleId}>
      <div className="w-[480px]">
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold">
            群信息
          </h2>
          <button className="al-muted" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>

        {!canEdit && (
          <div
            className="al-muted mb-3 rounded-lg px-2 py-1.5 text-xs"
            style={{ background: 'var(--al-bg-hover)' }}
          >
            只有群主和管理员能修改群名与公告（协议 §10 权限矩阵）。
          </div>
        )}

        <label className="al-muted mb-1 block text-xs" htmlFor="group-title">
          群名
        </label>
        <input
          id="group-title"
          className="al-input mb-3"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={!canEdit}
          maxLength={128}
        />

        <label className="al-muted mb-1 block text-xs" htmlFor="group-announcement">
          群公告（{announcement.length}/4000）
        </label>
        <textarea
          id="group-announcement"
          className="al-input mb-3"
          rows={4}
          value={announcement}
          onChange={(e) => setAnnouncement(e.target.value)}
          disabled={!canEdit}
          maxLength={4000}
          placeholder="写点什么让成员一眼看到，例如：周报每周五交"
        />

        {error !== null && (
          <div className="mb-2 text-xs" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button className="al-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          {canEdit && (
            <button
              className="al-btn"
              disabled={busy || !dirty || title.trim() === ''}
              onClick={() => {
                setBusy(true);
                setError(null);
                const patch: { title?: string; announcement?: string } = {};
                if (title !== initialTitle) patch.title = title.trim();
                if (announcement !== initialAnnouncement) patch.announcement = announcement;
                void onSave(patch)
                  .then(() => onClose())
                  .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : '保存失败');
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? '保存中…' : '保存'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}