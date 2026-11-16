import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentLinkError } from '@agentlink/protocol';
import type { AppServices } from '../services/index.js';
import { findUserById, listAgents, setUserDisabled, findUserByUsername } from '../db/queries.js';
import { newId, nowMs } from '../ids.js';
import { insertAudit } from '../db/queries.js';
import { hashPassword } from '../auth/crypto.js';
import { toUserSummary } from '../services/conversations.js';
import { sendError } from './errors.js';

/**
 * 认证与管理 HTTP 面（实现计划 M1）。
 *
 *   POST /api/auth/login
 *   POST /api/auth/refresh
 *   POST /api/auth/register       （v1 自用：第一个用户可以自助注册）
 *   GET  /api/auth/me
 *   POST /api/admin/agents
 *   POST /api/admin/agents/:id/rotate-token
 *   POST /api/admin/agents/:id/disable
 *   GET  /api/admin/agents
 *   GET  /api/admin/users
 *   GET  /api/admin/audit
 */

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

const RefreshBody = z.object({
  refresh_token: z.string().min(1),
});

const RegisterBody = z.object({
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, '只允许字母数字与 _ . -'),
  display_name: z.string().min(1).max(64),
  password: z.string().min(8).max(200),
});

const CreateAgentBody = z.object({
  username: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, '只允许字母数字与 _ . -'),
  display_name: z.string().min(1).max(64),
  model: z.string().max(64).optional(),
});

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AgentLinkError('VALIDATION_FAILED', '请求体不合法', {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    });
  }
  return parsed.data;
}

/** 从 Authorization 头取 Bearer token 并认证。 */
async function requireUser(
  services: AppServices,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ userId: string; kind: 'human' | 'agent' }> {
  const raw = headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header || !header.startsWith('Bearer ')) {
    throw new AgentLinkError('AUTH_REQUIRED', '缺少 Authorization: Bearer <token>');
  }
  const token = header.slice('Bearer '.length).trim();
  if (token === '') throw new AgentLinkError('AUTH_REQUIRED', 'token 为空');
  const identity = await services.auth.authenticate(token);
  return { userId: identity.userId, kind: identity.kind };
}

/** 管理动作只允许人类（v1 自用；agent 不参与管理面）。 */
async function requireHumanAdmin(
  services: AppServices,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ userId: string }> {
  const who = await requireUser(services, headers);
  if (who.kind !== 'human') {
    throw new AgentLinkError('PERM_DENIED', '只有人类账号能调用管理接口', { action: 'admin' });
  }
  return { userId: who.userId };
}

export async function authRoutes(app: FastifyInstance, services: AppServices): Promise<void> {
  app.post('/api/auth/login', async (req, reply) => {
    try {
      const body = parseBody(LoginBody, req.body);
      const tokens = await services.auth.login(body.username, body.password);
      return reply.send(tokens);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/refresh', async (req, reply) => {
    try {
      const body = parseBody(RefreshBody, req.body);
      const tokens = await services.auth.refresh(body.refresh_token);
      return reply.send(tokens);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/auth/register', async (req, reply) => {
    try {
      const body = parseBody(RegisterBody, req.body);
      const user = await services.auth.registerHuman({
        username: body.username,
        displayName: body.display_name,
        password: body.password,
      });
      const tokens = await services.auth.issueTokenPair(user.id, 'human');
      return reply.code(201).send({ user: toUserSummary(user), ...tokens });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/auth/me', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const user = findUserById(services.dbc.db, who.userId);
      if (!user) throw new AgentLinkError('AUTH_INVALID', '账号不存在');
      return reply.send({
        user: toUserSummary(user),
        kind: user.kind,
        username: user.username,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- 管理面 ----

  app.post('/api/admin/agents', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const body = parseBody(CreateAgentBody, req.body);
      const { user, token } = services.auth.createAgent({
        username: body.username,
        displayName: body.display_name,
        ownerUserId: admin.userId,
        ...(body.model === undefined ? {} : { model: body.model }),
      });
      // token 只此一次返回（数据模型 §5）
      return reply.code(201).send({
        agent: {
          id: user.id,
          username: user.username,
          display_name: user.displayName,
          kind: user.kind,
          disabled: user.disabled === 1,
        },
        token,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/agents/:id/rotate-token', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const { token } = services.auth.rotateAgentToken(req.params.id, admin.userId);
      // 旧 token 立即失效：断开该 agent 的所有 WS 连接（数据模型 §5）
      const closed = services.gateway.closeUserConnections(req.params.id, 1008, 'token rotated');
      return reply.send({ token, connections_closed: closed });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/agents/:id/disable', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const user = findUserById(services.dbc.db, req.params.id);
      if (!user || user.kind !== 'agent') {
        throw new AgentLinkError('NOT_FOUND', 'agent 不存在', { what: 'user' });
      }
      setUserDisabled(services.dbc.db, user.id, true);
      services.auth.revokeUserTokens(user.id);
      const closed = services.gateway.closeUserConnections(user.id, 1008, 'agent disabled');
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'agent.disable',
        targetType: 'agent',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true, connections_closed: closed });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/agents/:id/enable', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const user = findUserById(services.dbc.db, req.params.id);
      if (!user || user.kind !== 'agent') {
        throw new AgentLinkError('NOT_FOUND', 'agent 不存在', { what: 'user' });
      }
      setUserDisabled(services.dbc.db, user.id, false);
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'agent.enable',
        targetType: 'agent',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/admin/agents', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const rows = listAgents(services.dbc.db, 'default');
      return reply.send({
        agents: rows.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.displayName,
          model: u.model,
          disabled: u.disabled === 1,
          created_at: u.createdAt,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/admin/users', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const rows = listAgents(services.dbc.db, 'default');
      const humans = services.dbc.db
        ? (await import('../db/queries.js')).listHumans(services.dbc.db, 'default')
        : [];
      return reply.send({
        humans: humans.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.displayName,
          created_at: u.createdAt,
        })),
        agents: rows.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.displayName,
          disabled: u.disabled === 1,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/admin/audit', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const q = req.query as { limit?: string; cursor?: string };
      const limit = Math.min(Number(q.limit ?? '50') || 50, 200);
      const { listAudit } = await import('../db/queries.js');
      const { rows, hasMore } = listAudit(services.dbc.db, 'default', limit, q.cursor);
      return reply.send({
        items: rows.map((r) => ({
          id: r.id,
          actor_id: r.actorId,
          action: r.action,
          target_type: r.targetType,
          target_id: r.targetId,
          detail: JSON.parse(r.detail) as unknown,
          created_at: r.createdAt,
        })),
        has_more: hasMore,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export { requireUser, requireHumanAdmin };
export { findUserByUsername, hashPassword };
