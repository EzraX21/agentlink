import { useState } from 'react';
import { api } from '../lib/api.js';

interface Props {
  onClose: () => void;
  /** 真正建群（走 WS 的 conv.create），成功后由上层切到该会话。 */
  onCreateGroup: (title: string, memberIds: string[]) => Promise<string>;
}

/**
 * 管理面板（实现计划 M6 / 验收 5：WebUI 能建群、拉人、停用 agent，操作立即生效）。
 */
export function AdminPanel({ onClose, onCreateGroup }: Props): React.JSX.Element {
  const [tab, setTab] = useState<'group' | 'agents' | 'audit'>('group');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 建群
  const [memberIdsText, setMemberIdsText] = useState('');
  // agent 管理
  const [agentName, setAgentName] = useState('');
  const [agentDisplay, setAgentDisplay] = useState('');
  const [newAgentToken, setNewAgentToken] = useState<string | null>(null);
  const [agents, setAgents] = useState<
    Array<{ id: string; username: string; display_name: string; disabled: boolean }>
  >([]);
  // 审计
  const [audit, setAudit] = useState<
    Array<{ id: string; actor_id: string; action: string; target_id: string; created_at: number }>
  >([]);

  async function run<T>(fn: () => Promise<T>, okMsg: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      setNotice(okMsg);
      return r;
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function loadAgents(): Promise<void> {
    const r = await run(() => api.agents(), '已刷新 agent 列表');
    if (r) setAgents(r.agents);
  }

  async function loadAudit(): Promise<void> {
    const r = await run(() => api.audit(50), '已刷新审计日志');
    if (r) setAudit(r.items);
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: 'rgb(0 0 0 / 45%)' }}
      onClick={onClose}
    >
      <div
        className="al-card max-h-[80vh] w-[560px] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">管理</h2>
          <button className="al-muted" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="mb-3 flex gap-2 text-xs">
          {(['group', 'agents', 'audit'] as const).map((t) => (
            <button
              key={t}
              className="al-btn-ghost"
              style={
                tab === t
                  ? { background: 'var(--al-bg-active)', borderColor: 'var(--al-primary)' }
                  : undefined
              }
              onClick={() => {
                setTab(t);
                if (t === 'agents') void loadAgents();
                if (t === 'audit') void loadAudit();
              }}
            >
              {t === 'group' ? '建群' : t === 'agents' ? 'Agent' : '审计日志'}
            </button>
          ))}
        </div>

        {error !== null && (
          <div className="mb-2 text-xs" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}
        {notice !== null && <div className="al-muted mb-2 text-xs">{notice}</div>}

        {tab === 'group' && (
          <div className="space-y-2">
            <label className="block text-xs al-muted" htmlFor="gtitle">
              群名
            </label>
            <input
              id="gtitle"
              className="al-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：项目讨论"
            />
            <label className="block text-xs al-muted" htmlFor="gmembers">
              成员 ID（逗号或换行分隔，可留空）
            </label>
            <textarea
              id="gmembers"
              className="al-input"
              rows={3}
              value={memberIdsText}
              onChange={(e) => setMemberIdsText(e.target.value)}
              placeholder="u_01J... 每行一个"
            />
            <button
              className="al-btn"
              disabled={busy || title.trim() === ''}
              onClick={() => {
                const ids = memberIdsText
                  .split(/[\s,]+/)
                  .map((s) => s.trim())
                  .filter((s) => s !== '');
                void (async () => {
                  const convId = await run(
                    () => onCreateGroup(title.trim(), ids),
                    '群已创建',
                  );
                  if (convId !== null) {
                    setTitle('');
                    setMemberIdsText('');
                    onClose();
                  }
                })();
              }}
            >
              创建
            </button>
          </div>
        )}

        {tab === 'agents' && (
          <div className="space-y-3">
            <div className="space-y-2">
              <input
                className="al-input"
                placeholder="agent 用户名（英文）"
                value={agentName}
                onChange={(e) => setAgentName(e.target.value)}
              />
              <input
                className="al-input"
                placeholder="显示名"
                value={agentDisplay}
                onChange={(e) => setAgentDisplay(e.target.value)}
              />
              <button
                className="al-btn"
                disabled={busy || agentName === ''}
                onClick={() => {
                  void (async () => {
                    const r = await run(
                      () => api.createAgent(agentName, agentDisplay || agentName),
                      'agent 已创建，token 只显示这一次',
                    );
                    if (r) {
                      setNewAgentToken(r.token);
                      setAgentName('');
                      setAgentDisplay('');
                      await loadAgents();
                    }
                  })();
                }}
              >
                新建 agent
              </button>
            </div>

            {newAgentToken !== null && (
              <div className="rounded-lg p-2 text-xs" style={{ background: 'var(--al-bg-hover)' }}>
                <div className="al-muted mb-1">token（只此一次，请立刻保存）</div>
                <code className="break-all">{newAgentToken}</code>
              </div>
            )}

            <div className="space-y-1">
              {agents.map((a) => (
                <div key={a.id} className="flex items-center justify-between rounded p-1.5 text-xs">
                  <span>
                    {a.display_name} <span className="al-muted">@{a.username}</span>
                    {a.disabled && <span className="al-badge ml-1">已停用</span>}
                  </span>
                  <button
                    className="al-btn-ghost !px-1.5 !py-0.5"
                    disabled={busy}
                    onClick={() => {
                      void (async () => {
                        await run(
                          () =>
                            a.disabled ? api.enableAgent(a.id) : api.disableAgent(a.id),
                          a.disabled ? '已启用' : '已停用（连接立即断开）',
                        );
                        await loadAgents();
                      })();
                    }}
                  >
                    {a.disabled ? '启用' : '停用'}
                  </button>
                </div>
              ))}
              {agents.length === 0 && <div className="al-muted text-xs">还没有 agent</div>}
            </div>
          </div>
        )}

        {tab === 'audit' && (
          <div className="space-y-1 text-xs">
            {audit.length === 0 && <div className="al-muted">没有审计记录</div>}
            {audit.map((row) => (
              <div key={row.id} className="flex justify-between gap-2 border-b py-1" style={{ borderColor: 'var(--al-border)' }}>
                <span>
                  <code>{row.action}</code> <span className="al-muted">→ {row.target_id}</span>
                </span>
                <span className="al-muted shrink-0">
                  {new Date(row.created_at).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
