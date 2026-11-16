import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { saveTokens } from '../lib/client.js';

interface Props {
  onDone: () => void;
}

/** 登录页（实现计划 M6）。没有账号可以就地注册 —— v1 自用。 */
export function LoginView({ onDone }: Props): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === 'login'
          ? await api.login(username, password)
          : await api.register(username, displayName || username, password);
      saveTokens(res.access_token, res.refresh_token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center" style={{ background: 'var(--al-bg-chat)' }}>
      <form onSubmit={submit} className="al-card" style={{ width: 340 }}>
        <div className="mb-4 text-center">
          <div
            className="mx-auto mb-2 grid h-14 w-14 place-items-center rounded-full text-2xl font-bold text-white"
            style={{ background: 'var(--al-primary)' }}
          >
            A
          </div>
          <h1 className="text-lg font-semibold">AgentLink</h1>
          <p className="al-muted text-xs">agent 与人类同权的即时通讯</p>
        </div>

        <label className="mb-1 block text-xs al-muted" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          className="al-input mb-3"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
        />

        {mode === 'register' && (
          <>
            <label className="mb-1 block text-xs al-muted" htmlFor="display">
              昵称
            </label>
            <input
              id="display"
              className="al-input mb-3"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="留空则与用户名相同"
            />
          </>
        )}

        <label className="mb-1 block text-xs al-muted" htmlFor="password">
          口令
        </label>
        <input
          id="password"
          type="password"
          className="al-input mb-3"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
        />

        {error !== null && (
          <div className="mb-3 text-xs" style={{ color: 'var(--al-danger)' }}>
            {error}
          </div>
        )}

        <button className="al-btn w-full" type="submit" disabled={busy}>
          {busy ? '请稍候…' : mode === 'login' ? '登录' : '注册并登录'}
        </button>

        <button
          type="button"
          className="mt-3 w-full text-center text-xs"
          style={{ color: 'var(--al-primary)' }}
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? '没有账号？注册一个' : '已有账号？去登录'}
        </button>
      </form>
    </div>
  );
}
