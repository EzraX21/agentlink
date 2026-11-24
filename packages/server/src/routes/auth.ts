import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentLinkError } from '@agentlink/protocol';
import type { AppServices } from '../services/index.js';
import {
  adminListConversations,
  adminListMembers,
  adminStats,
  findConversation,
  findUsersByIds,
  countActiveAdmins,
  findUserById,
  findUserByUsername,
  hasAnyAdmin,
  listAgents,
  listAuditActions,
  listAuditFiltered,
  listHumans,
  setUserAdmin,
  setUserDisabled,
  updateUserPassword,
} from '../db/queries.js';
import { newId, nowMs } from '../ids.js';
import { insertAudit } from '../db/queries.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
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

const ChangePasswordBody = z.object({
  old_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(200),
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

/**
 * 管理接口的准入：必须是**人类且是全局管理员**。
 *
 * 之前只检查 `kind === 'human'`，等于任何注册用户都能建 agent、停用 agent、读审计。
 * 管理页要成立就必须有准入概念，见迁移 0003 与 docs/DECISIONS.md。
 */
async function requireHumanAdmin(
  services: AppServices,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ userId: string }> {
  const who = await requireUser(services, headers);
  if (who.kind !== 'human') {
    throw new AgentLinkError('PERM_DENIED', '只有人类账号能调用管理接口', { action: 'admin' });
  }
  const user = findUserById(services.dbc.db, who.userId);
  if (!user || user.isAdmin !== 1) {
    throw new AgentLinkError('PERM_DENIED', '需要管理员权限', { action: 'admin' });
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
      return reply.code(201).send({
        user: toUserSummary(user),
        is_admin: user.isAdmin === 1,
        ...tokens,
      });
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
        // 前端据此决定要不要显示"管理"入口；真正的准入在服务端强制
        is_admin: user.isAdmin === 1,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * 改自己的密码。
   *
   * 首次启动自动建的管理员用的是随机密码（在启动日志里），所以"改密码"
   * 是引导向导的第一步 —— 这条接口就是给它用的。
   *
   * 要求旧密码：光有 token 就允许改密码，等于 token 泄露即可永久接管账号。
   */
  app.post('/api/auth/password', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const body = parseBody(ChangePasswordBody, req.body);
      const user = findUserById(services.dbc.db, who.userId);
      if (!user) throw new AgentLinkError('AUTH_INVALID', '账号不存在');
      if (user.kind !== 'human') {
        throw new AgentLinkError('PERM_DENIED', 'agent 不能改密码', { action: 'auth.password' });
      }

      // agent 的 passwordHash 是 null（它们用 token 认证），前面已经挡掉；
      // 这里再断言一次是为了让类型收敛，而不是靠"我确定"。
      if (user.passwordHash === null) {
        throw new AgentLinkError('AUTH_INVALID', '这个账号没有密码');
      }
      const ok = await verifyPassword(user.passwordHash, body.old_password);
      if (!ok) {
        throw new AgentLinkError('AUTH_INVALID', '旧密码不正确');
      }
      if (body.old_password === body.new_password) {
        throw new AgentLinkError('VALIDATION_FAILED', '新密码不能与旧密码相同', {
          issues: [{ path: 'new_password', message: '必须与旧密码不同' }],
        });
      }

      updateUserPassword(services.dbc.db, user.id, await hashPassword(body.new_password));
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: user.id,
        action: 'user.password.change',
        targetType: 'user',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  /**
   * 首次使用的引导状态。
   *
   * 前端拿它决定要不要弹向导。每一项都是"去查已有的真实状态"，不是
   * 单独存一份引导标记 —— 存标记会跟真实状态漂移（用户从别的入口做了
   * 某一步，标记还说他没做）。
   */
  app.get('/api/admin/setup', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const db = services.dbc.db;
      const stats = adminStats(db);
      // 改过密码 = 审计里有这条记录。启动时自动建的账号还没这条。
      const passwordChanged = listAuditFiltered(db, {
        tenantId: 'default',
        limit: 500,
        action: 'user.password.change',
      }).length > 0;

      const steps = {
        password_changed: passwordChanged,
        has_agent: stats.agents > 0,
        has_group: stats.convs > 0,
      };
      return reply.send({
        // 引导只在"还没做过任何一步"时弹。做过一步就不再打扰 ——
        // 否则每次进管理页都被向导挡一下，很烦。
        first_run: !passwordChanged && !steps.has_agent && !steps.has_group,
        steps,
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
      const agents = listAgents(services.dbc.db, 'default');
      const humans = listHumans(services.dbc.db, 'default');
      return reply.send({
        humans: humans.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.displayName,
          is_admin: u.isAdmin === 1,
          disabled: u.disabled === 1,
          created_at: u.createdAt,
        })),
        agents: agents.map((u) => ({
          id: u.id,
          username: u.username,
          display_name: u.displayName,
          model: u.model,
          disabled: u.disabled === 1,
          owner_user_id: u.ownerUserId,
          created_at: u.createdAt,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/api/admin/audit', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const q = req.query as { limit?: string; action?: string; actor_id?: string };
      const limit = Math.min(Number(q.limit ?? '100') || 100, 500);
      const rows = listAuditFiltered(services.dbc.db, {
        tenantId: 'default',
        limit,
        ...(q.action === undefined ? {} : { action: q.action }),
        ...(q.actor_id === undefined ? {} : { actorId: q.actor_id }),
      });
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
        actions: listAuditActions(services.dbc.db, 'default'),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- 概览 ----

  app.get('/api/admin/stats', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      return reply.send(adminStats(services.dbc.db));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- 账号管理（人类）----

  app.post('/api/admin/users', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const body = parseBody(
        z.object({
          username: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, '只允许字母数字与 _ . -'),
          display_name: z.string().min(1).max(64),
          password: z.string().min(8).max(200),
          is_admin: z.boolean().optional(),
        }),
        req.body,
      );
      const user = await services.auth.createHumanByAdmin({
        username: body.username,
        displayName: body.display_name,
        password: body.password,
        isAdmin: body.is_admin === true,
      });
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'user.create',
        targetType: 'user',
        targetId: user.id,
        detail: JSON.stringify({ username: user.username, is_admin: body.is_admin === true }),
        createdAt: nowMs(),
      });
      return reply.code(201).send({
        user: toUserSummary(user),
        username: user.username,
        is_admin: user.isAdmin === 1,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/disable', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const user = findUserById(services.dbc.db, req.params.id);
      if (!user || user.kind !== 'human') {
        throw new AgentLinkError('NOT_FOUND', '人类账号不存在', { what: 'user' });
      }
      if (user.id === admin.userId) {
        throw new AgentLinkError('PERM_DENIED', '不能停用自己', { action: 'user.disable' });
      }
      if (user.isAdmin === 1 && countActiveAdmins(services.dbc.db) <= 1) {
        throw new AgentLinkError('CONFLICT', '不能停用最后一个管理员');
      }
      setUserDisabled(services.dbc.db, user.id, true);
      services.auth.revokeUserTokens(user.id);
      const closed = services.gateway.closeUserConnections(user.id, 1008, 'account disabled');
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'user.disable',
        targetType: 'user',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true, connections_closed: closed });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/enable', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const user = findUserById(services.dbc.db, req.params.id);
      if (!user || user.kind !== 'human') {
        throw new AgentLinkError('NOT_FOUND', '人类账号不存在', { what: 'user' });
      }
      setUserDisabled(services.dbc.db, user.id, false);
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'user.enable',
        targetType: 'user',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/admin', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const body = parseBody(z.object({ granted: z.boolean() }), req.body);
      const user = findUserById(services.dbc.db, req.params.id);
      if (!user || user.kind !== 'human') {
        throw new AgentLinkError('NOT_FOUND', '人类账号不存在', { what: 'user' });
      }
      if (!body.granted) {
        if (user.id === admin.userId) {
          throw new AgentLinkError('PERM_DENIED', '不能撤销自己的管理员权限', {
            action: 'user.role.set',
          });
        }
        if (user.isAdmin === 1 && countActiveAdmins(services.dbc.db) <= 1) {
          throw new AgentLinkError('CONFLICT', '不能撤销最后一个管理员');
        }
      }
      setUserAdmin(services.dbc.db, user.id, body.granted);
      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: body.granted ? 'user.grant_admin' : 'user.revoke_admin',
        targetType: 'user',
        targetId: user.id,
        detail: '{}',
        createdAt: nowMs(),
      });
      return reply.send({ ok: true, is_admin: body.granted });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- 群组管理（跨会话视角，不要求调用者是群成员）----

  app.get('/api/admin/convs', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const q = req.query as { limit?: string };
      const limit = Math.min(Number(q.limit ?? '100') || 100, 500);
      return reply.send({ items: adminListConversations(services.dbc.db, limit) });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // ---- 群组成员管理（管理页跨群视角，不要求调用者是群成员）----

  app.get<{ Params: { id: string } }>('/api/admin/convs/:id/members', async (req, reply) => {
    try {
      await requireHumanAdmin(services, req.headers);
      const conv = findConversation(services.dbc.db, req.params.id);
      if (!conv) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });
      return reply.send({
        conv: { id: conv.id, kind: conv.kind, title: conv.title },
        members: adminListMembers(services.dbc.db, conv.id).map((m) => ({
          user_id: m.userId,
          username: m.username,
          display_name: m.displayName,
          kind: m.kind,
          role: m.role,
          muted_until: m.mutedUntil,
          joined_at: m.joinedAt,
        })),
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>('/api/admin/convs/:id/members', async (req, reply) => {
    try {
      const admin = await requireHumanAdmin(services, req.headers);
      const body = parseBody(
        z.object({ user_ids: z.array(z.string().min(1)).min(1).max(50) }),
        req.body,
      );
      const conv = findConversation(services.dbc.db, req.params.id);
      if (!conv) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });

      const users = findUsersByIds(services.dbc.db, body.user_ids);
      if (users.length !== body.user_ids.length) {
        const found = new Set(users.map((u) => u.id));
        throw new AgentLinkError(
          'NOT_FOUND',
          `用户不存在: ${body.user_ids.filter((id) => !found.has(id)).join(', ')}`,
          { what: 'user' },
        );
      }

      const at = nowMs();
      const added: Array<{ id: string; display_name: string }> = [];
      const { appendEvent, insertMembership, findMembership } = await import('../db/queries.js');
      services.dbc.raw.transaction(() => {
        for (const u of users) {
          if (findMembership(services.dbc.db, conv.id, u.id)) continue;
          insertMembership(services.dbc.db, {
            convId: conv.id,
            userId: u.id,
            role: 'member',
            isAgent: u.kind === 'agent' ? 1 : 0,
            mutedUntil: 0,
            joinedAt: at,
          });
          added.push({ id: u.id, display_name: u.displayName });
        }
        // 事件与成员写入同一事务（数据模型 §4 的同一条纪律）
        for (const a of added) {
          appendEvent(services.dbc.db, {
            tenantId: 'default',
            convId: conv.id,
            type: 'member.join',
            payload: JSON.stringify({ conv_id: conv.id, user_id: a.id }),
            createdAt: at,
          });
        }
      })();

      insertAudit(services.dbc.db, {
        id: newId('e'),
        tenantId: 'default',
        actorId: admin.userId,
        action: 'member.invite',
        targetType: 'group',
        targetId: conv.id,
        detail: JSON.stringify({ user_ids: added.map((a) => a.id), via: 'admin_console' }),
        createdAt: at,
      });
      return reply.send({ added: added.length, members: added });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string; userId: string } }>(
    '/api/admin/convs/:id/members/:userId/remove',
    async (req, reply) => {
      try {
        const admin = await requireHumanAdmin(services, req.headers);
        const conv = findConversation(services.dbc.db, req.params.id);
        if (!conv) throw new AgentLinkError('NOT_FOUND', '会话不存在', { what: 'conv' });
        const { deleteMembership, findMembership, appendEvent } = await import(
          '../db/queries.js'
        );
        const target = findMembership(services.dbc.db, conv.id, req.params.userId);
        if (!target) throw new AgentLinkError('NOT_FOUND', '该用户不在群里', { what: 'user' });
        if (target.role === 'owner') {
          throw new AgentLinkError('PERM_DENIED', '不能移除群主（先在群里转移群主）', {
            action: 'member.kick',
          });
        }
        const at = nowMs();
        services.dbc.raw.transaction(() => {
          deleteMembership(services.dbc.db, conv.id, req.params.userId);
          appendEvent(services.dbc.db, {
            tenantId: 'default',
            convId: conv.id,
            type: 'member.leave',
            payload: JSON.stringify({
              conv_id: conv.id,
              user_id: req.params.userId,
              reason: 'kicked',
            }),
            createdAt: at,
          });
        })();
        insertAudit(services.dbc.db, {
          id: newId('e'),
          tenantId: 'default',
          actorId: admin.userId,
          action: 'member.kick',
          targetType: 'user',
          targetId: req.params.userId,
          detail: JSON.stringify({ conv_id: conv.id, via: 'admin_console' }),
          createdAt: at,
        });
        return reply.send({ ok: true });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---- 引导信息：新库上"还没有管理员"时前端要能提示 ----

  app.get('/api/admin/bootstrap', async (req, reply) => {
    try {
      const who = await requireUser(services, req.headers);
      const user = findUserById(services.dbc.db, who.userId);
      return reply.send({
        needs_bootstrap_admin: !hasAnyAdmin(services.dbc.db),
        is_admin: user?.isAdmin === 1,
      });
    } catch (err) {
      return sendError(reply, err);
    }
  });
}

export { requireUser, requireHumanAdmin };
export { findUserByUsername, hashPassword };
