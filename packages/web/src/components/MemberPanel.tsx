import { useState } from 'react';
import type { Member } from '@agentlink/protocol';
import { avatarColor, initials } from '../lib/format.js';

interface Props {
  members: Member[];
  selfId: string;
  myRole: 'owner' | 'admin' | 'member';
  onKick: (userId: string) => void;
  onMute: (userId: string, minutes: number) => void;
  onSetRole: (userId: string, role: 'admin' | 'member') => void;
  onInvite: () => void;
  onClose: () => void;
}

/** 成员面板（实现计划 M6：含管理操作）。 */
export function MemberPanel({
  members,
  selfId,
  myRole,
  onKick,
  onMute,
  onSetRole,
  onInvite,
  onClose,
}: Props): React.JSX.Element {
  const canManage = myRole === 'owner' || myRole === 'admin';
  const isOwner = myRole === 'owner';
  const [filter, setFilter] = useState('');
  const visible = members.filter((m) => {
    const q = filter.trim().toLowerCase();
    if (q === '') return true;
    return (
      m.user.display_name.toLowerCase().includes(q) ||
      m.user.id.toLowerCase().includes(q)
    );
  });

  return (
    <aside className="al-panel flex w-[260px] flex-col">
      <header
        className="flex items-center justify-between px-3 py-2.5"
        style={{ borderBottom: '1px solid var(--al-border)' }}
      >
        <span className="font-semibold">成员 {members.length}</span>
        <button className="al-muted" onClick={onClose} title="关闭">
          ✕
        </button>
      </header>

      <div className="px-2 pt-2">
        <input
          className="al-input text-xs"
          placeholder="搜索成员…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {filter.trim() !== '' && visible.length === 0 && (
          <div className="al-muted p-2 text-center text-xs">没有匹配的成员</div>
        )}
        {visible.map((m) => {
          const isSelf = m.user_id === selfId;
          const muted = m.muted_until > Date.now();
          return (
            <div key={m.user_id} className="rounded-lg p-2 hover:bg-[var(--al-bg-hover)]">
              <div className="flex items-center gap-2">
                <div className="al-avatar" style={{ background: avatarColor(m.user_id) }}>
                  {initials(m.user.display_name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span className="truncate text-[13px] font-medium">
                      {m.user.display_name}
                      {isSelf && <span className="al-muted"> (我)</span>}
                    </span>
                    {m.is_agent && <span className="al-badge">agent</span>}
                  </div>
                  <div className="al-muted text-[11px]">
                    {m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '成员'}
                    {muted && ' · 禁言中'}
                  </div>
                </div>
              </div>

              {canManage && !isSelf && m.role !== 'owner' && (
                <div className="mt-1 flex flex-wrap gap-1.5 pl-10 text-[11px]">
                  <button className="al-btn-ghost !px-1.5 !py-0.5" onClick={() => onKick(m.user_id)}>
                    踢出
                  </button>
                  <button
                    className="al-btn-ghost !px-1.5 !py-0.5"
                    onClick={() => onMute(m.user_id, muted ? 0 : 10)}
                  >
                    {muted ? '解除禁言' : '禁言 10 分钟'}
                  </button>
                  {isOwner && (
                    <button
                      className="al-btn-ghost !px-1.5 !py-0.5"
                      onClick={() => onSetRole(m.user_id, m.role === 'admin' ? 'member' : 'admin')}
                    >
                      {m.role === 'admin' ? '降为成员' : '设为管理员'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {canManage && (
        <footer className="p-2" style={{ borderTop: '1px solid var(--al-border)' }}>
          <button className="al-btn w-full" onClick={onInvite}>
            邀请成员
          </button>
        </footer>
      )}
    </aside>
  );
}
