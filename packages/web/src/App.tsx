import { useCallback, useEffect, useState } from 'react';
import { AdminPage } from './pages/AdminPage.js';
import { LoginView } from './components/LoginView.js';
import { clearTokens, loadTokens } from './lib/client.js';
import { apiUrl } from './lib/endpoint.js';

/**
 * AgentLink 的 Web 端：**只**是管理后台。
 *
 * 架构（用户定的）：聊天功能在 Qt 桌面客户端（EzraX21/agentlink-desktop）里，
 * Web 只保留管理面板 —— 账号 / Agent / 群组 / 审计日志。
 *
 * 所以这里登录后**直接进管理页**，没有会话列表、没有聊天窗口。
 */

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(() => loadTokens().access !== null);
  const [selfId, setSelfId] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  // 取自己的身份与管理员标记（管理页要用 isAdmin 决定能不能操作）
  useEffect(() => {
    if (!authed) return;
    void (async () => {
      try {
        const me = await fetch(apiUrl('/api/auth/me'), {
          headers: { authorization: `Bearer ${loadTokens().access ?? ''}` },
        });
        if (!me.ok) {
          if (me.status === 401) logout();
          return;
        }
        const data = (await me.json()) as {
          user: { id: string; display_name: string };
          kind: 'human' | 'agent';
          is_admin?: boolean;
        };
        setSelfId(data.user.id);
        setIsAdmin(data.is_admin === true);
      } catch {
        /* 忽略：管理页本身会显示错误 */
      }
    })();
  }, [authed]);

  const logout = useCallback(() => {
    clearTokens();
    setAuthed(false);
    setSelfId('');
    setIsAdmin(false);
  }, []);

  if (!authed) {
    return <LoginView onDone={() => setAuthed(true)} />;
  }

  return (
    <AdminPage
      selfId={selfId}
      isAdmin={isAdmin}
      section="overview"
      onBack={logout}
    />
  );
}
