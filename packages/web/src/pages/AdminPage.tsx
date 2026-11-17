import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  type AdminAgent,
  type AdminAuditRow,
  type AdminConv,
  type AdminHuman,
  type AdminMember,
} from '../lib/api.js';
import { adminPath, navigate, type AdminSection } from '../lib/router.js';
import { Excerpt } from '../components/Excerpt.js';
import { avatarColor, formatDay, initials } from '../lib/format.js';

/**
 * Web 管理页（需求确认书 §5：WebUI 管理面板：建群、账号与 Agent 管理、审计日志）。
 *
 * 五块：概览 / 账号 / Agent / 群组 / 审计。
 *
 * 准入：服务端强制 `is_admin`（迁移 0003）。本页只负责在非管理员时给出清楚的拒绝，
 * 不靠前端隐藏按钮当权限。
 */

interface Props {
  selfId: string;
  isAdmin: boolean;
  section: AdminSection;
  onBack: () => void;
  /** 建群走 WS 的 conv.create（协议 §5.2），由 App 注入（它持有连接）。 */
  onCreateGroup: (title: string) => Promise<string>;
}

const SECTION_TITLES: Record<AdminSection, string> = {
  overview: '概览',
  users: '账号',
  agents: 'Agent',
  groups: '群组',
  audit: '审计日志',
};

export function AdminPage({
  selfId,
  isAdmin,
  section,
  onBack,
  onCreateGroup,
}: Props): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!isAdmin) {
    return (
      <div className="al-chat-bg grid h-full place-items-center">
        <div className="al-card max-w-[420px] text-center">
          <div className="mb-2 text-lg font-semibold">需要管理员权限</div>
          <p className="al-muted mb-4 text-xs">
            你的账号不是管理员。管理页可以建/停用账号与 Agent、查看所有群组与审计日志，
            因此只对管理员开放。
            <br />
            如果这是刚部署的新实例，注册的<strong>第一个</strong>账号会自动成为管理员。
          </p>
          <button className="al-btn" onClick={onBack}>
            回到聊天
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <aside className="al-sidebar flex w-[210px] flex-col">
        <header className="px-3 py-3" style={{ borderBottom: '1px solid var(--al-border)' }}>
          <div className="text-sm font-semibold">管理</div>
          <div className="al-muted text-[11px]">AgentLink</div>
        </header>
        <nav className="flex-1 py-1">
          <NavItem to={adminPath('overview')} active={section === 'overview'} label="概览" />
          <NavItem to={adminPath('users')} active={section === 'users'} label="账号" />
          <NavItem to={adminPath('agents')} active={section === 'agents'} label="Agent" />
          <NavItem to={adminPath('groups')} active={section === 'groups'} label="群组" />
          <NavItem to={adminPath('audit')} active={section === 'audit'} label="审计日志" />
        </nav>
        <footer className="p-2" style={{ borderTop: '1px solid var(--al-border)' }}>
          <button className="al-btn-ghost w-full" onClick={onBack}>
            ← 回到聊天
          </button>
        </footer>
      </aside>

      <section className="al-chat-bg flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header
          className="sticky top-0 z-10 flex items-center justify-between px-5 py-3"
          style={{ background: 'var(--al-bg-sidebar)', borderBottom: '1px solid var(--al-border)' }}
        >
          <h1 className="text-base font-semibold">{SECTION_TITLES[section]}</h1>
          {notice !== null && <span className="al-muted text-xs">{notice}</span>}
        </header>

        <div className="p-4">
          {error !== null && (
            <div
              className="mb-3 rounded-lg px-3 py-2 text-xs text-white"
              style={{ background: 'var(--al-danger)' }}
              role="alert"
              onClick={() => setError(null)}
            >
              {error}
            </div>
          )}

          {section === 'overview' && <OverviewSection onError={setError} />}
          {section === 'users' && (
            <UsersSection
              selfId={selfId}
              onError={setError}
              onNotice={setNotice}
            />
          )}
          {section === 'agents' && <AgentsSection onError={setError} onNotice={setNotice} />}
          {section === 'groups' && (
            <GroupsSection
              onError={setError}
              onNotice={setNotice}
              onCreateGroup={onCreateGroup}
            />
          )}
          {section === 'audit' && <AuditSection onError={setError} />}
        </div>
      </section>
    </div>
  );
}

function NavItem({
  to,
  active,
  label,
}: {
  to: string;
  active: boolean;
  label: string;
}): React.JSX.Element {
  return (
    <a
      href={to}
      className="al-conv-item"
      data-active={active}
      style={{ paddingTop: 7, paddingBottom: 7 }}
    >
      <span className="text-[13px]">{label}</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// 概览
// ---------------------------------------------------------------------------

function OverviewSection({ onError }: { onError: (m: string) => void }): React.JSX.Element {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [recent, setRecent] = useState<AdminAuditRow[]>([]);

  const reload = useCallback(() => {
    void api.stats().then(setStats).catch((e: Error) => onError(e.message));
    void api
      .audit({ limit: 6 })
      .then((r) => setRecent(r.items))
      .catch(() => undefined);
  }, [onError]);

  useEffect(() => reload(), [reload]);

  const cards: Array<{ label: string; value: number; hint?: string }> = stats === null
    ? []
    : [
        { label: '人类账号', value: stats.humans, hint: `${stats.admins} 位管理员` },
        { label: 'Agent', value: stats.agents, hint: `${stats.disabledAgents} 个已停用` },
        { label: '会话', value: stats.convs },
        { label: '消息', value: stats.messages },
        { label: '事件（可补发）', value: stats.events, hint: '保留 30 天' },
        {
          label: '已停用账号',
          value: stats.disabledHumans + stats.disabledAgents,
          hint: `人类 ${stats.disabledHumans} / Agent ${stats.disabledAgents}`,
        },
      ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="al-card">
            <div className="al-muted text-[11px]">{c.label}</div>
            <div className="text-2xl font-semibold">{c.value}</div>
            {c.hint !== undefined && <div className="al-muted text-[11px]">{c.hint}</div>}
          </div>
        ))}
        {stats === null && <div className="al-muted text-xs">加载中…</div>}
      </div>

      <div className="al-card">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold">最近操作</span>
          <button className="al-muted text-xs" onClick={() => navigate(adminPath('audit'))}>
            查看全部 →
          </button>
        </div>
        {recent.length === 0 && <div className="al-muted text-xs">还没有审计记录</div>}
        {recent.map((r) => (
          <div
            key={r.id}
            className="flex items-center justify-between border-b py-1.5 text-xs last:border-b-0"
            style={{ borderColor: 'var(--al-border)' }}
          >
            <span>
              <code>{r.action}</code> <span className="al-muted">→ {r.target_id}</span>
            </span>
            <span className="al-muted shrink-0">{formatDay(r.created_at)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 账号（人类）
// ---------------------------------------------------------------------------

function UsersSection({
  selfId,
  onError,
  onNotice,
}: {
  selfId: string;
  onError: (m: string) => void;
  onNotice: (m: string | null) => void;
}): React.JSX.Element {
  const [humans, setHumans] = useState<AdminHuman[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', isAdmin: false });

  const reload = useCallback(() => {
    void api
      .users()
      .then((r) => setHumans(r.humans))
      .catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(() => reload(), [reload]);

  async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true);
    onError('');
    try {
      await fn();
      onNotice(ok);
      reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="al-card">
        <div className="mb-2 text-sm font-semibold">新建人类账号</div>
        <div className="grid gap-2 md:grid-cols-4">
          <input
            className="al-input"
            placeholder="用户名"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            className="al-input"
            placeholder="显示名"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
          <input
            className="al-input"
            type="password"
            placeholder="初始口令（≥8 位）"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          <button
            className="al-btn"
            disabled={busy || form.username === '' || form.password.length < 8}
            onClick={() => {
              void act(
                () =>
                  api.createUser({
                    username: form.username,
                    displayName: form.displayName || form.username,
                    password: form.password,
                    isAdmin: form.isAdmin,
                  }),
                `已创建账号 ${form.username}`,
              ).then(() => setForm({ username: '', displayName: '', password: '', isAdmin: false }));
            }}
          >
            创建
          </button>
        </div>
        <label className="al-muted mt-2 flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={form.isAdmin}
            onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })}
          />
          直接授予管理员
        </label>
      </div>

      <div className="al-card overflow-x-auto">
        <div className="mb-2 text-sm font-semibold">全部人类账号（{humans.length}）</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="al-muted text-left">
              <th className="py-1">账号</th>
              <th className="py-1">显示名</th>
              <th className="py-1">角色</th>
              <th className="py-1">状态</th>
              <th className="py-1">创建时间</th>
              <th className="py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {humans.map((u) => (
              <tr key={u.id} className="border-t" style={{ borderColor: 'var(--al-border)' }}>
                <td className="py-1.5">
                  <code>{u.username}</code>
                  {u.id === selfId && <span className="al-badge ml-1">我</span>}
                </td>
                <td className="py-1.5">
                  <span className="mr-1.5 inline-grid h-5 w-5 place-items-center rounded-full text-[10px] text-white"
                    style={{ background: avatarColor(u.id) }}
                  >
                    {initials(u.display_name)}
                  </span>
                  {u.display_name}
                </td>
                <td className="py-1.5">{u.is_admin ? '管理员' : '普通用户'}</td>
                <td className="py-1.5">
                  {u.disabled ? (
                    <span style={{ color: 'var(--al-danger)' }}>已停用</span>
                  ) : (
                    '正常'
                  )}
                </td>
                <td className="al-muted py-1.5">{formatDay(u.created_at)}</td>
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      className="al-btn-ghost !px-1.5 !py-0.5"
                      disabled={busy || u.id === selfId}
                      onClick={() => {
                        void act(
                          () => api.setUserAdmin(u.id, !u.is_admin),
                          u.is_admin ? '已撤销管理员' : '已授予管理员',
                        );
                      }}
                    >
                      {u.is_admin ? '撤销管理员' : '设为管理员'}
                    </button>
                    <button
                      className="al-btn-ghost !px-1.5 !py-0.5"
                      disabled={busy || u.id === selfId}
                      onClick={() => {
                        void act(
                          () => api.setUserDisabled(u.id, !u.disabled),
                          u.disabled ? '已启用（可重新登录）' : '已停用（连接立即断开）',
                        );
                      }}
                    >
                      {u.disabled ? '启用' : '停用'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {humans.length === 0 && (
              <tr>
                <td className="al-muted py-2" colSpan={6}>
                  还没有账号
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

function AgentsSection({
  onError,
  onNotice,
}: {
  onError: (m: string) => void;
  onNotice: (m: string | null) => void;
}): React.JSX.Element {
  const [agents, setAgents] = useState<AdminAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', model: '' });
  const [newToken, setNewToken] = useState<{ username: string; token: string } | null>(null);

  const reload = useCallback(() => {
    void api
      .users()
      .then((r) => setAgents(r.agents))
      .catch((e: Error) => onError(e.message));
  }, [onError]);

  useEffect(() => reload(), [reload]);

  async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      onNotice(ok);
      reload();
    } catch (err) {
      onError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="al-card">
        <div className="mb-2 text-sm font-semibold">新建 Agent</div>
        <div className="grid gap-2 md:grid-cols-4">
          <input
            className="al-input"
            placeholder="用户名（英文，用于 @）"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
          <input
            className="al-input"
            placeholder="显示名"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
          />
          <input
            className="al-input"
            placeholder="模型（可选，仅展示）"
            value={form.model}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          />
          <button
            className="al-btn"
            disabled={busy || form.username === ''}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  const r = await api.createAgent(
                    form.username,
                    form.displayName || form.username,
                    form.model === '' ? undefined : form.model,
                  );
                  // token 只此一次返回（数据模型 §5），必须当场展示
                  setNewToken({ username: form.username, token: r.token });
                  onNotice('Agent 已创建，token 只显示这一次');
                  setForm({ username: '', displayName: '', model: '' });
                  reload();
                } catch (err) {
                  onError(err instanceof Error ? err.message : '创建失败');
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            创建
          </button>
        </div>

        {newToken !== null && (
          <div className="mt-2 rounded-lg p-2 text-xs" style={{ background: 'var(--al-bg-hover)' }}>
            <div className="al-muted mb-1">
              {newToken.username} 的 token（只此一次，立刻保存；关掉就再也拿不到）
            </div>
            <code className="break-all">{newToken.token}</code>
            <div className="mt-1">
              <button className="al-muted" onClick={() => setNewToken(null)}>
                已保存，隐藏
              </button>
            </div>
            <div className="al-muted mt-1">
              用法：<code>AGENTLINK_TOKEN=... node examples/echo-agent/index.mjs</code>
            </div>
          </div>
        )}
      </div>

      <div className="al-card overflow-x-auto">
        <div className="mb-2 text-sm font-semibold">全部 Agent（{agents.length}）</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="al-muted text-left">
              <th className="py-1">用户名</th>
              <th className="py-1">显示名</th>
              <th className="py-1">模型</th>
              <th className="py-1">状态</th>
              <th className="py-1">操作</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-t" style={{ borderColor: 'var(--al-border)' }}>
                <td className="py-1.5">
                  <code>@{a.username}</code>
                </td>
                <td className="py-1.5">{a.display_name}</td>
                <td className="al-muted py-1.5">{a.model ?? '—'}</td>
                <td className="py-1.5">
                  {a.disabled ? (
                    <span style={{ color: 'var(--al-danger)' }}>已停用</span>
                  ) : (
                    '正常'
                  )}
                </td>
                <td className="py-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      className="al-btn-ghost !px-1.5 !py-0.5"
                      disabled={busy || a.disabled}
                      onClick={() => {
                        void (async () => {
                          setBusy(true);
                          try {
                            const r = await api.rotateAgentToken(a.id);
                            setNewToken({ username: a.username, token: r.token });
                            onNotice(`已轮换 @${a.username} 的 token（旧连接已断开）`);
                            reload();
                          } catch (err) {
                            onError(err instanceof Error ? err.message : '轮换失败');
                          } finally {
                            setBusy(false);
                          }
                        })();
                      }}
                    >
                      轮换 token
                    </button>
                    <button
                      className="al-btn-ghost !px-1.5 !py-0.5"
                      disabled={busy}
                      onClick={() => {
                        void act(
                          () => api.setUserDisabled(a.id, !a.disabled),
                          a.disabled ? '已启用' : '已停用（连接立即断开）',
                        );
                      }}
                    >
                      {a.disabled ? '启用' : '停用'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td className="al-muted py-2" colSpan={5}>
                  还没有 Agent
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 群组
// ---------------------------------------------------------------------------

function GroupsSection({
  onError,
  onNotice,
  onCreateGroup,
}: {
  onError: (m: string) => void;
  onNotice: (m: string | null) => void;
  onCreateGroup: (title: string) => Promise<string>;
}): React.JSX.Element {
  const [convs, setConvs] = useState<AdminConv[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [allUsers, setAllUsers] = useState<Array<{ id: string; label: string }>>([]);
  const [addIds, setAddIds] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    void api
      .convs()
      .then((r) => setConvs(r.items))
      .catch((e: Error) => onError(e.message));
    void api
      .users()
      .then((r) =>
        setAllUsers([
          ...r.humans.map((u) => ({ id: u.id, label: `${u.display_name} (@${u.username})` })),
          ...r.agents.map((u) => ({ id: u.id, label: `[agent] ${u.display_name} (@${u.username})` })),
        ]),
      )
      .catch(() => undefined);
  }, [onError]);

  useEffect(() => reload(), [reload]);

  const reloadMembers = useCallback(
    (convId: string) => {
      void api
        .convMembers(convId)
        .then((r) => setMembers(r.members))
        .catch((e: Error) => onError(e.message));
    },
    [onError],
  );

  const selectedConv = useMemo(
    () => convs.find((c) => c.id === selected) ?? null,
    [convs, selected],
  );

  async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true);
    try {
      await fn();
      onNotice(ok);
      reload();
      if (selected !== null) reloadMembers(selected);
    } catch (err) {
      onError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="al-card">
        <div className="mb-2 text-sm font-semibold">全部会话（{convs.length}）</div>
        <div className="mb-2 max-h-[420px] overflow-y-auto">
          {convs.map((c) => (
            <button
              key={c.id}
              className="al-conv-item w-full text-left"
              data-active={c.id === selected}
              onClick={() => {
                setSelected(c.id);
                reloadMembers(c.id);
              }}
            >
              <div className="al-avatar" style={{ background: avatarColor(c.id) }}>
                {initials(c.title || '群')}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{c.title || '(无标题)'}</div>
                <div className="al-muted text-[11px]">
                  {c.memberCount} 人 · {c.messageCount} 条消息 · {c.kind}
                </div>
              </div>
            </button>
          ))}
          {convs.length === 0 && <div className="al-muted text-xs">还没有会话</div>}
        </div>
      </div>

      <div className="al-card">
        {selectedConv === null ? (
          <div className="al-muted text-xs">选左边一个会话查看成员</div>
        ) : (
          <>
            <div className="mb-1 text-sm font-semibold">{selectedConv.title || '(无标题)'}</div>
            <div className="al-muted mb-2 text-[11px]">
              {selectedConv.id} · 创建于 {formatDay(selectedConv.createdAt)} · 群主{' '}
              {members.find((m) => m.role === 'owner')?.display_name ?? '（未知）'}
            </div>

            <div className="mb-3 max-h-[260px] overflow-y-auto">
              {members.map((m) => (
                <div
                  key={m.user_id}
                  className="flex items-center justify-between border-b py-1.5 text-xs"
                  style={{ borderColor: 'var(--al-border)' }}
                >
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-grid h-5 w-5 place-items-center rounded-full text-[10px] text-white"
                      style={{ background: avatarColor(m.user_id) }}
                    >
                      {initials(m.display_name)}
                    </span>
                    {m.display_name}
                    <code className="al-muted">@{m.username}</code>
                    {m.kind === 'agent' && <span className="al-badge">agent</span>}
                    {m.role !== 'member' && <span className="al-badge">{m.role}</span>}
                  </span>
                  <button
                    className="al-btn-ghost !px-1.5 !py-0.5"
                    disabled={busy || m.role === 'owner'}
                    title={m.role === 'owner' ? '不能移除群主' : '移出该群'}
                    onClick={() => {
                      void act(
                        () => api.removeConvMember(selectedConv.id, m.user_id),
                        `已把 ${m.display_name} 移出该群`,
                      );
                    }}
                  >
                    移除
                  </button>
                </div>
              ))}
              {members.length === 0 && <div className="al-muted text-xs">加载中…</div>}
            </div>

            <div className="mb-1 text-xs font-medium">拉人进群</div>
            <div className="flex gap-2">
              <input
                className="al-input"
                placeholder="用户 ID，逗号分隔（可从下面复制）"
                value={addIds}
                onChange={(e) => setAddIds(e.target.value)}
              />
              <button
                className="al-btn shrink-0"
                disabled={busy || addIds.trim() === ''}
                onClick={() => {
                  const ids = addIds
                    .split(/[\s,]+/)
                    .map((s) => s.trim())
                    .filter((s) => s !== '');
                  void act(
                    () => api.addConvMembers(selectedConv.id, ids),
                    `已加入 ${ids.length} 个成员`,
                  ).then(() => setAddIds(''));
                }}
              >
                加入
              </button>
            </div>
            <select
              className="al-input mt-2"
              value=""
              onChange={(e) => {
                if (e.target.value !== '') {
                  setAddIds(addIds === '' ? e.target.value : `${addIds},${e.target.value}`);
                }
              }}
            >
              <option value="">从列表选一个用户…</option>
              {allUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label} — {u.id}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div className="al-card lg:col-span-2">
        <div className="mb-2 text-sm font-semibold">新建群组</div>
        <div className="flex gap-2">
          <input
            className="al-input"
            placeholder="群名"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            className="al-btn shrink-0"
            disabled={busy || title.trim() === ''}
            onClick={() => {
              void (async () => {
                setBusy(true);
                try {
                  // 建群走 WS op（协议 §5.2），成功后管理页重新拉列表
                  const created = await onCreateGroup(title.trim());
                  onNotice(`群「${title.trim()}」已创建`);
                  setTitle('');
                  reload();
                  setSelected(created);
                  reloadMembers(created);
                } catch (err) {
                  onError(err instanceof Error ? err.message : '建群失败');
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            创建
          </button>
        </div>
        <div className="al-muted mt-1 text-[11px]">
          建群用的是协议里的 conv.create（任何登录用户都能建群）。创建后你在该群是群主。
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

function AuditSection({ onError }: { onError: (m: string) => void }): React.JSX.Element {
  const [rows, setRows] = useState<AdminAuditRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [action, setAction] = useState('');
  const [actorId, setActorId] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  const reload = useCallback(() => {
    void api
      .audit({ action, actorId, limit: 200 })
      .then((r) => {
        setRows(r.items);
        setActions(r.actions);
      })
      .catch((e: Error) => onError(e.message));
  }, [action, actorId, onError]);

  useEffect(() => reload(), [reload]);

  useEffect(() => {
    void api
      .users()
      .then((r) => {
        const map: Record<string, string> = {};
        for (const u of r.humans) map[u.id] = u.display_name;
        for (const u of r.agents) map[u.id] = `[agent] ${u.display_name}`;
        setNames(map);
      })
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-3">
      <div className="al-card flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <span className="al-muted mb-1 block">动作</span>
          <select className="al-input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">全部动作</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          <span className="al-muted mb-1 block">操作者 user_id</span>
          <input
            className="al-input"
            placeholder="u_..."
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
          />
        </label>
        <button className="al-btn-ghost" onClick={() => reload()}>
          刷新
        </button>
        <span className="al-muted text-xs">共 {rows.length} 条（最近 200 条）</span>
      </div>

      <div className="al-card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="al-muted text-left">
              <th className="py-1">时间</th>
              <th className="py-1">动作</th>
              <th className="py-1">操作者</th>
              <th className="py-1">目标</th>
              <th className="py-1">细节</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t" style={{ borderColor: 'var(--al-border)' }}>
                <td className="al-muted py-1.5 whitespace-nowrap">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="py-1.5">
                  <code>{r.action}</code>
                </td>
                <td className="py-1.5">{names[r.actor_id] ?? r.actor_id}</td>
                <td className="py-1.5">
                  <span className="al-muted">{r.target_type}:</span> <code>{r.target_id}</code>
                </td>
                <td className="al-muted py-1.5">
                  {typeof r.detail === 'object' && r.detail !== null
                    ? JSON.stringify(r.detail)
                    : String(r.detail)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="al-muted py-2" colSpan={5}>
                  没有符合条件的审计记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}