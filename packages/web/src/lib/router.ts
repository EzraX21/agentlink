import { useEffect, useState } from 'react';

/**
 * 极简 hash 路由。
 *
 * 为什么不引 react-router：管理页只需要"聊天"与"管理"两个顶层视图，
 * 引一个路由库会多一层依赖与配置，收益为零（需求确认书 §8.2 的选型偏好：
 * 能不加就不加）。
 *
 * 路由形态：
 *   #/                      聊天
 *   #/admin                 管理页（默认落到概览）
 *   #/admin/users           账号
 *   #/admin/agents          Agent
 *   #/admin/groups          群组
 *   #/admin/audit           审计
 */

export type Route =
  | { name: 'chat' }
  | { name: 'admin'; section: AdminSection };

export type AdminSection = 'overview' | 'users' | 'agents' | 'groups' | 'audit';

const ADMIN_SECTIONS: readonly AdminSection[] = ['overview', 'users', 'agents', 'groups', 'audit'];

function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, '');
  if (!raw.startsWith('/admin')) return { name: 'chat' };
  const parts = raw.split('/').filter((p) => p !== '');
  const section = parts[1];
  if (section !== undefined && (ADMIN_SECTIONS as readonly string[]).includes(section)) {
    return { name: 'admin', section: section as AdminSection };
  }
  return { name: 'admin', section: 'overview' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path.slice(1) : path;
}

export function adminPath(section: AdminSection): string {
  return section === 'overview' ? '#/admin' : `#/admin/${section}`;
}

export { ADMIN_SECTIONS };
