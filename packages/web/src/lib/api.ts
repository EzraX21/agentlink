import type { Conversation, Member, Message } from '@agentlink/protocol';

/**
 * HTTP 控制面（协议 §1：登录、历史、搜索、上传走 HTTP）。
 * 只有这些用 TanStack Query；实时消息走 WS。
 */

const TOKEN_KEY = 'agentlink.access_token';

function authHeader(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token === null ? {} : { authorization: `Bearer ${token}` };
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
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

  me: () => req<{ user: { id: string; display_name: string }; kind: string }>('GET', '/api/auth/me'),

  agents: () =>
    req<{ agents: Array<{ id: string; username: string; display_name: string; disabled: boolean }> }>(
      'GET',
      '/api/admin/agents',
    ),

  createAgent: (username: string, displayName: string, model?: string) =>
    req<{ agent: { id: string; display_name: string }; token: string }>(
      'POST',
      '/api/admin/agents',
      { username, display_name: displayName, ...(model === undefined ? {} : { model }) },
    ),

  disableAgent: (id: string) =>
    req<{ ok: boolean; connections_closed: number }>('POST', `/api/admin/agents/${id}/disable`),

  enableAgent: (id: string) => req<{ ok: boolean }>('POST', `/api/admin/agents/${id}/enable`),

  audit: (limit = 50) =>
    req<{
      items: Array<{
        id: string;
        actor_id: string;
        action: string;
        target_type: string;
        target_id: string;
        detail: unknown;
        created_at: number;
      }>;
      has_more: boolean;
    }>('GET', `/api/admin/audit?limit=${limit}`),
};

/** 历史分页的响应形状（与 history.fetch 一致）。 */
export interface HistoryPage {
  messages: Message[];
  has_more: boolean;
}

export type { Conversation, Member, Message };
