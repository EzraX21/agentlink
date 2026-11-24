import { useState } from 'react';
import { apiUrl } from '../lib/endpoint.js';
import { loadTokens } from '../lib/client.js';

/**
 * 首次使用的引导向导。
 *
 * 为什么需要：一键启动的容器会把管理员账号和随机密码打在日志里，
 * 用户 `docker logs` 拿到账号后，面对的是五个分区、一堆表格的管理页 ——
 * 不知道该先做什么。向导把"必须要做的几件事"按顺序摆出来。
 *
 * 每一步的状态都来自服务端真实数据（`/api/admin/setup`），不是本地记的
 * 勾選 —— 用户在别处做了某一步，这里要能反映出来。
 */
interface SetupSteps {
  password_changed: boolean;
  has_agent: boolean;
  has_group: boolean;
}

interface Props {
  steps: SetupSteps;
  /** 服务端地址（就是当前页面地址），用于展示给用户抄进客户端。 */
  serverUrl: string;
  onDone: () => void;
}

type StepKey = 'password' | 'agent' | 'group' | 'client';

export function SetupWizard({ steps, serverUrl, onDone }: Props): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [agentName, setAgentName] = useState('助手');
  const [agentUsername, setAgentUsername] = useState('assistant');
  const [agentToken, setAgentToken] = useState<string | null>(null);

  const done: Record<StepKey, boolean> = {
    password: steps.password_changed,
    agent: steps.has_agent,
    group: steps.has_group,
    // 下载客户端没有服务端状态，纯提示，不算"未完成"
    client: true,
  };
  const remaining = (['password', 'agent', 'group'] as StepKey[]).filter((k) => !done[k]).length;

  async function changePassword(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/auth/password'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${loadTokens().access ?? ''}`,
        },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `改密码失败（HTTP ${res.status}）`);
      setNotice('密码已修改。请用新密码重新登录。');
      setOldPassword('');
      setNewPassword('');
      // 密码变了，旧 token 还能用（JWT 无状态），但引导状态要刷新
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '改密码失败');
    } finally {
      setBusy(false);
    }
  }

  async function createAgent(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/admin/agents'), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${loadTokens().access ?? ''}`,
        },
        body: JSON.stringify({ username: agentUsername, display_name: agentName }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: { message?: string };
      };
      if (!res.ok) throw new Error(body.error?.message ?? `建 Agent 失败（HTTP ${res.status}）`);
      setAgentToken(body.token ?? null);
      setNotice('Agent 已创建。token 只显示这一次，记得复制走。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '建 Agent 失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="al-chat-bg grid min-h-0 flex-1 place-items-start overflow-auto p-4">
      <div className="mx-auto w-full max-w-2xl space-y-3">
        <div className="al-card">
          <div className="text-lg font-semibold">欢迎使用 AgentLink</div>
          <div className="al-muted mt-1 text-xs">
            还有 {remaining} 项建议完成。做完这些你就可以开始聊天了。
          </div>
        </div>

        {notice !== null && (
          <div className="al-card" style={{ borderColor: 'var(--al-ok)' }}>
            <div className="text-sm">{notice}</div>
          </div>
        )}
        {error !== null && (
          <div className="al-card" style={{ borderColor: 'var(--al-danger)' }}>
            <div className="text-sm" style={{ color: 'var(--al-danger)' }}>
              {error}
            </div>
          </div>
        )}

        {/* 1. 改密码 */}
        <Step index={1} title="改掉初始密码" done={done.password}>
          <div className="al-muted mb-2 text-xs">
            初始密码在容器的启动日志里（<code>docker logs agentlink</code>）。
            现在就改掉，别让它留在日志里。
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="al-input"
              type="password"
              placeholder="当前密码"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
            />
            <input
              className="al-input"
              type="password"
              placeholder="新密码（≥8 位）"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="al-btn shrink-0"
              disabled={busy || oldPassword === '' || newPassword.length < 8}
              onClick={() => void changePassword()}
            >
              改密码
            </button>
          </div>
        </Step>

        {/* 2. 建 Agent */}
        <Step index={2} title="创建一个 Agent（可选）" done={done.agent}>
          <div className="al-muted mb-2 text-xs">
            Agent 是能收发消息的机器人账号，与人类同权。不给它建也能用 ——
            纯人类聊天不需要 agent。
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className="al-input"
              placeholder="显示名，如 助手"
              value={agentName}
              onChange={(e) => setAgentName(e.target.value)}
            />
            <input
              className="al-input"
              placeholder="用户名（英文，用于 @）"
              value={agentUsername}
              onChange={(e) => setAgentUsername(e.target.value)}
            />
            <button
              className="al-btn shrink-0"
              disabled={busy || agentName === '' || agentUsername === ''}
              onClick={() => void createAgent()}
            >
              创建 Agent
            </button>
          </div>
          {agentToken !== null && (
            <div className="mt-2">
              <div className="al-muted text-xs">token（只显示一次）：</div>
              <code className="mt-1 block break-all rounded p-2 text-xs" style={{ background: 'var(--al-bg-alt)' }}>
                {agentToken}
              </code>
            </div>
          )}
        </Step>

        {/* 3. 建群 */}
        <Step index={3} title="建一个群（可选）" done={done.group}>
          <div className="al-muted mb-2 text-xs">
            群在**桌面客户端**里建（菜单「会话 → 建群…」）。Web 只做管理，
            不提供聊天界面。所以你装好客户端之后再来做这一步也行。
          </div>
        </Step>

        {/* 4. 装客户端 */}
        <Step index={4} title="装上桌面客户端" done>
          <div className="al-muted mb-2 text-xs">
            聊天在 Qt 桌面客户端里进行。首次启动时把下面这个地址填进去，
            然后用刚才的账号登录。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded px-2 py-1 text-xs" style={{ background: 'var(--al-bg-alt)' }}>
              {serverUrl}
            </code>
            <a
              className="al-btn-ghost text-xs"
              href="https://github.com/EzraX21/agentlink-desktop/releases"
              target="_blank"
              rel="noreferrer"
            >
              下载客户端 →
            </a>
          </div>
        </Step>

        <div className="flex justify-end">
          <button className="al-btn" onClick={onDone}>
            进入管理页
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({
  index,
  title,
  done,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(!done);
  return (
    <div className="al-card">
      <button
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px]"
          style={{
            background: done ? 'var(--al-ok)' : 'var(--al-border)',
            color: done ? '#fff' : 'inherit',
          }}
        >
          {done ? '✓' : index}
        </span>
        <span className="text-sm font-semibold">{title}</span>
        <span className="al-muted ml-auto text-xs">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
