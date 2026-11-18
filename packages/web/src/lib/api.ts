import type { Conversation, Member, Message, SearchHit } from '@agentlink/protocol';

/**
 * HTTP 控制面（协议 §1：登录、历史、搜索、上传走 HTTP）。
 * 只有这些用 TanStack Query；实时消息走 WS。
 */

import { apiUrl } from './endpoint.js';

const TOKEN_KEY = 'agentlink.access_token';

function authHeader(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...authHeader(),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const json = text === '' ? null : (JSON.parse(text) as unknown);
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
    throw new Error(err?.message ?? `${method} ${path} 失败 (${res.status})`);
  }
  return json as T;
}

export interface AdminHuman {
  id: string;
  username: string;
  display_name: string;
  is_admin: boolean;
  disabled: boolean;
  created_at: number;
}

export interface AdminAgent {
  id: string;
  username: string;
  display_name: string;
  model: string | null;
  disabled: boolean;
  owner_user_id: string | null;
  created_at: number;
}

export interface AdminConv {
  id: string;
  kind: 'group' | 'dm';
  title: string;
  createdBy: string;
  createdAt: number;
  memberCount: number;
  messageCount: number;
}

export interface AdminMember {
  user_id: string;
  username: string;
  display_name: string;
  kind: 'human' | 'agent';
  role: 'owner' | 'admin' | 'member';
  muted_until: number;
  joined_at: number;
}

export interface AdminAuditRow {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: unknown;
  created_at: number;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export const api = {
  login: (username: string, password: string) =>
    req<LoginResponse>('POST', '/api/auth/login', { username, password }),

  register: (username: string, displayName: string, password: string) =>
    req<LoginResponse & { user: { id: string } }>('POST', '/api/auth/register', {
      username,
      display_name: displayName,
      password,
    }),

  me: () =>
    req<{
      user: { id: string; display_name: string };
      kind: string;
      username: string;
      is_admin: boolean;
    }>('GET', '/api/auth/me'),

  // ---- 管理页 ----

  stats: () =>
    req<{
      humans: number;
      agents: number;
      admins: number;
      disabledAgents: number;
      disabledHumans: number;
      convs: number;
      messages: number;
      events: number;
    }>('GET', '/api/admin/stats'),

  users: () =>
    req<{
      humans: AdminHuman[];
      agents: AdminAgent[];
    }>('GET', '/api/admin/users'),

  createUser: (input: {
    username: string;
    displayName: string;
    password: string;
    isAdmin?: boolean;
  }) =>
    req<{ user: { id: string; display_name: string }; username: string; is_admin: boolean }>(
      'POST',
      '/api/admin/users',
      {
        username: input.username,
        display_name: input.displayName,
        password: input.password,
        ...(input.isAdmin === undefined ? {} : { is_admin: input.isAdmin }),
      },
    ),

  setUserDisabled: (id: string, disabled: boolean) =>
    req<{ ok: boolean; connections_closed?: number }>(
      'POST',
      `/api/admin/users/${id}/${disabled ? 'disable' : 'enable'}`,
    ),

  setUserAdmin: (id: string, granted: boolean) =>
    req<{ ok: boolean; is_admin: boolean }>('POST', `/api/admin/users/${id}/admin`, {
      granted,
    }),

  createAgent: (username: string, displayName: string, model?: string) =>
    req<{ agent: { id: string; display_name: string }; token: string }>(
      'POST',
      '/api/admin/agents',
      { username, display_name: displayName, ...(model === undefined ? {} : { model }) },
    ),

  rotateAgentToken: (id: string) =>
    req<{ token: string; connections_closed: number }>(
      'POST',
      `/api/admin/agents/${id}/rotate-token`,
    ),

  /** 检索（协议 §5.7 的 search.messages 走 WS，但历史/搜索也在 HTTP 控制面上提供一份更省事的入口）。 */
  search: (query: {
    q: string;
    convId?: string;
    fromUserId?: string;
    before?: number;
    after?: number;
    limit?: number;
  }) => {
    const params = new URLSearchParams({ q: query.q });
    if (query.convId !== undefined) params.set('conv_id', query.convId);
    if (query.fromUserId !== undefined) params.set('from_user_id', query.fromUserId);
    if (query.before !== undefined) params.set('before', String(query.before));
    if (query.after !== undefined) params.set('after', String(query.after));
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    return req<{ hits: SearchHit[] }>('GET', `/api/search?${params.toString()}`);
  },

  convs: () => req<{ items: AdminConv[] }>('GET', '/api/admin/convs'),

  convMembers: (convId: string) =>
    req<{ conv: { id: string; kind: string; title: string }; members: AdminMember[] }>(
      'GET',
      `/api/admin/convs/${convId}/members`,
    ),

  addConvMembers: (convId: string, userIds: string[]) =>
    req<{ added: number; members: Array<{ id: string; display_name: string }> }>(
      'POST',
      `/api/admin/convs/${convId}/members`,
      { user_ids: userIds },
    ),

  removeConvMember: (convId: string, userId: string) =>
    req<{ ok: boolean }>('POST', `/api/admin/convs/${convId}/members/${userId}/remove`),

  audit: (query: { action?: string; actorId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.action !== undefined && query.action !== '') params.set('action', query.action);
    if (query.actorId !== undefined && query.actorId !== '') params.set('actor_id', query.actorId);
    params.set('limit', String(query.limit ?? 200));
    return req<{ items: AdminAuditRow[]; actions: string[] }>(
      'GET',
      `/api/admin/audit?${params.toString()}`,
    );
  },



};

/** 历史分页的响应形状（与 history.fetch 一致）。 */
export interface HistoryPage {
  messages: Message[];
  has_more: boolean;
}

export type { Conversation, Member, Message };
