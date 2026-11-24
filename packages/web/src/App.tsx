import { useCallback, useEffect, useState } from 'react';
import { AdminPage } from './pages/AdminPage.js';
import { LoginView } from './components/LoginView.js';
import { SetupWizard } from './components/SetupWizard.js';
import { clearTokens, loadTokens } from './lib/client.js';
import { apiUrl } from './lib/endpoint.js';
import { navigate, useRoute } from './lib/router.js';

/**
 * AgentLink 的 Web 端：**只**是管理后台。
 *
 * 架构（用户定的）：聊天功能在 Qt 桌面客户端（EzraX21/agentlink-desktop）里，
 * Web 只保留管理面板 —— 账号 / Agent / 群组 / 审计日志。
 *
 * 所以这里登录后**直接进管理页**，没有会话列表、没有聊天窗口。
 */

interface SetupState {
  first_run: boolean;
  steps: { password_changed: boolean; has_agent: boolean; has_group: boolean };
}

export function App(): React.JSX.Element {
  const [authed, setAuthed] = useState<boolean>(() => loadTokens().access !== null);
  const [selfId, setSelfId] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [setup, setSetup] = useState<SetupState | null>(null);
  // 管理页的分区来自 hash 路由（#/admin/users 这种）。
  // 之前这里写死 section="overview"，点了侧栏也没反应 —— 因为 AdminPage
  // 导航是改 hash，而 App 根本没读 hash。
  const route = useRoute();

  // Web 端没有聊天页，`#/` 是个无效路径（老书签/登录后落地）。
  // 登录态就绪时把它挪到 `#/admin`，否则侧栏点任何一个分区都会先回到概览。
  useEffect(() => {
    if (!authed) return;
    if (!window.location.hash.startsWith('#/admin')) navigate('#/admin');
  }, [authed]);
  // 用户点过"跳过/进入管理页"之后不再弹向导（本次会话内）
  const [setupDismissed, setSetupDismissed] = useState(false);

  // 首次使用的引导状态：只在管理员身上查（非管理员进不了 setup 接口）
  const loadSetup = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/admin/setup'), {
        headers: { authorization: `Bearer ${loadTokens().access ?? ''}` },
      });
      if (!res.ok) return;
      setSetup((await res.json()) as SetupState);
    } catch {
      /* 拿不到就当没有引导 */
    }
  }, []);

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
        if (data.is_admin === true) await loadSetup();
      } catch {
        /* 忽略：管理页本身会显示错误 */
      }
    })();
  }, [authed, loadSetup]);

  const logout = useCallback(() => {
    clearTokens();
    setAuthed(false);
    setSelfId('');
    setIsAdmin(false);
    setSetup(null);
    setSetupDismissed(false);
  }, []);

  if (!authed) {
    return <LoginView onDone={() => setAuthed(true)} />;
  }

  // 首次使用：先走引导，别让人一上来面对五个分区的表格
  if (isAdmin && setup !== null && setup.first_run && !setupDismissed) {
    return (
      <SetupWizard
        steps={setup.steps}
        serverUrl={window.location.origin}
        onDone={() => {
          setSetupDismissed(true);
          void loadSetup();
        }}
      />
    );
  }

  return (
    <AdminPage
      selfId={selfId}
      isAdmin={isAdmin}
      section={route.name === 'admin' ? route.section : 'overview'}
      onBack={logout}
    />
  );
}
