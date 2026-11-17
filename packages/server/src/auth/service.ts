import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import {
  hasAnyAdmin,
  findUserById,
  findUserByUsername,
  insertRefreshToken,
  findRefreshToken,
  consumeRefreshToken,
  revokeAllRefreshTokensForUser,
  insertUser,
  insertAudit,
  updateUserTokenHash,
  findUsersByIds,
} from '../db/queries.js';
import type { UserRow } from '../db/schema.js';
import {
  buildAgentToken,
  generateAgentSecret,
  hashAgentSecret,
  hashPassword,
  parseAgentToken,
  safeEqualHex,
  verifyPassword,
} from './crypto.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from './jwt.js';
import { newId, newUserId, nowMs } from '../ids.js';
import { AgentLinkError } from '@agentlink/protocol';

/**
 * 认证与会话（实现计划 M1）。
 *
 * 人类：用户名 + 口令（argon2id）→ access 15m + refresh 30d，refresh 轮换。
 * Agent：长期 Bearer Token，格式 `ag_<user_id>_<secret>`，库里只存 hash。
 */

export interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
  readonly token_type: 'Bearer';
}

export interface AuthenticatedIdentity {
  readonly userId: string;
  readonly kind: 'human' | 'agent';
  readonly tenantId: string;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  async login(username: string, password: string): Promise<TokenPair> {
    const user = findUserByUsername(this.db, 'default', username);
    // 用户不存在与口令错误返回同一个错误码，避免用户名枚举
    if (!user || user.kind !== 'human' || !user.passwordHash) {
      throw new AgentLinkError('AUTH_INVALID', '用户名或口令错误');
    }
    if (user.disabled === 1) {
      throw new AgentLinkError('PERM_DENIED', '账号已停用');
    }
    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      throw new AgentLinkError('AUTH_INVALID', '用户名或口令错误');
    }
    return this.issueTokenPair(user.id, 'human');
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const verified = await verifyRefreshToken(this.config, refreshToken);
    if (!verified.ok) {
      throw new AgentLinkError(
        verified.reason === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
        verified.reason === 'expired' ? 'refresh token 已过期' : 'refresh token 无效',
      );
    }
    const { sub, jti } = verified.claims;
    const row = findRefreshToken(this.db, jti);
    if (!row || row.revokedAt !== null || row.expiresAt < nowMs()) {
      // 已轮换/已吊销的 token 再被使用：拒绝。不做"全家吊销"的过激处理，
      // 因为并发刷新（多标签页）是正常场景，见 DECISIONS。
      throw new AgentLinkError('AUTH_INVALID', 'refresh token 已失效');
    }
    const user = findUserById(this.db, sub);
    if (!user || user.kind !== 'human' || user.disabled === 1) {
      throw new AgentLinkError('AUTH_INVALID', '账号不可用');
    }

    const next = await this.issueTokenPair(user.id, 'human');
    // 用新 jti 标记旧的已轮换
    const nextJti = await this.#jtiOf(next.refresh_token);
    consumeRefreshToken(this.db, jti, nextJti);
    return next;
  }

  async #jtiOf(token: string): Promise<string> {
    const v = await verifyRefreshToken(this.config, token);
    return v.ok ? v.claims.jti : 'unknown';
  }

  async issueTokenPair(userId: string, kind: 'human' | 'agent'): Promise<TokenPair> {
    const access = await signAccessToken(this.config, {
      sub: userId,
      kind,
      tenant_id: 'default',
    });
    const refresh = await signRefreshToken(this.config, userId);
    insertRefreshToken(this.db, {
      jti: refresh.jti,
      userId,
      expiresAt: refresh.expiresAtMs,
      createdAt: nowMs(),
    });
    return {
      access_token: access.token,
      refresh_token: refresh.token,
      expires_in: access.expiresInSec,
      token_type: 'Bearer',
    };
  }

  /** WS 首帧 auth / HTTP Bearer 共用。 */
  async authenticate(token: string): Promise<AuthenticatedIdentity> {
    const agent = parseAgentToken(token);
    if (agent) {
      return this.authenticateAgent(agent.userId, agent.secret);
    }
    const verified = await verifyAccessTokenSafe(this.config, token);
    if (!verified.ok) {
      throw new AgentLinkError(
        verified.reason === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
        verified.reason === 'expired' ? 'token 已过期' : 'token 无效',
      );
    }
    const user = findUserById(this.db, verified.claims.sub);
    if (!user || user.disabled === 1) {
      throw new AgentLinkError('AUTH_INVALID', '账号不可用');
    }
    return { userId: user.id, kind: user.kind, tenantId: user.tenantId };
  }

  private authenticateAgent(userId: string, secret: string): AuthenticatedIdentity {
    const user = findUserById(this.db, userId);
    if (!user || user.kind !== 'agent' || !user.tokenHash) {
      throw new AgentLinkError('AUTH_INVALID', 'agent token 无效');
    }
    if (user.disabled === 1) {
      throw new AgentLinkError('PERM_DENIED', 'agent 已停用');
    }
    const expected = hashAgentSecret(secret, this.config.agentTokenPepper);
    if (!safeEqualHex(expected, user.tokenHash)) {
      throw new AgentLinkError('AUTH_INVALID', 'agent token 无效');
    }
    return { userId: user.id, kind: 'agent', tenantId: user.tenantId };
  }

  /** 管理员建 agent（M1）。token 只此一次返回。 */
  createAgent(input: {
    username: string;
    displayName: string;
    ownerUserId: string;
    model?: string;
  }): { user: UserRow; token: string } {
    const existing = findUserByUsername(this.db, 'default', input.username);
    if (existing) {
      throw new AgentLinkError('CONFLICT', `用户名 ${input.username} 已存在`);
    }
    const id = newUserId();
    const secret = generateAgentSecret();
    insertUser(this.db, {
      id,
      tenantId: 'default',
      kind: 'agent',
      username: input.username,
      displayName: input.displayName,
      tokenHash: hashAgentSecret(secret, this.config.agentTokenPepper),
      model: input.model ?? null,
      ownerUserId: input.ownerUserId,
      createdAt: nowMs(),
    });
    const user = findUserById(this.db, id);
    if (!user) throw new AgentLinkError('CONFLICT', 'agent 创建失败');
    insertAudit(this.db, {
      id: newId('e'),
      tenantId: 'default',
      actorId: input.ownerUserId,
      action: 'agent.create',
      targetType: 'agent',
      targetId: id,
      detail: JSON.stringify({ username: input.username }),
      createdAt: nowMs(),
    });
    return { user, token: buildAgentToken(id, secret) };
  }

  rotateAgentToken(agentId: string, actorId: string): { token: string } {
    const user = findUserById(this.db, agentId);
    if (!user || user.kind !== 'agent') {
      throw new AgentLinkError('NOT_FOUND', 'agent 不存在', { what: 'user' });
    }
    const secret = generateAgentSecret();
    updateUserTokenHash(this.db, agentId, hashAgentSecret(secret, this.config.agentTokenPepper));
    insertAudit(this.db, {
      id: newId('e'),
      tenantId: 'default',
      actorId,
      action: 'agent.rotate_token',
      targetType: 'agent',
      targetId: agentId,
      detail: '{}',
      createdAt: nowMs(),
    });
    return { token: buildAgentToken(agentId, secret) };
  }

  /** 停用 agent 时把它的 refresh token 一并作废（agent 通常没有，稳妥起见）。 */
  revokeUserTokens(userId: string): void {
    revokeAllRefreshTokensForUser(this.db, userId);
  }

  async registerHuman(input: {
    username: string;
    displayName: string;
    password: string;
  }): Promise<UserRow> {
    const existing = findUserByUsername(this.db, 'default', input.username);
    if (existing) {
      throw new AgentLinkError('CONFLICT', `用户名 ${input.username} 已存在`);
    }
    const id = newUserId();
    insertUser(this.db, {
      id,
      tenantId: 'default',
      kind: 'human',
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      // 第一个人类账号自动成为管理员：否则新库上没人能打开管理页（先有鸡还是先有蛋）
      isAdmin: hasAnyAdmin(this.db) ? 0 : 1,
      createdAt: nowMs(),
    });
    const user = findUserById(this.db, id);
    if (!user) throw new AgentLinkError('CONFLICT', '注册失败');
    return user;
  }

  /** 管理员在管理页里建人类账号（与自助注册同路径，但不自动授予管理员）。 */
  async createHumanByAdmin(input: {
    username: string;
    displayName: string;
    password: string;
    isAdmin?: boolean;
  }): Promise<UserRow> {
    const existing = findUserByUsername(this.db, 'default', input.username);
    if (existing) {
      throw new AgentLinkError('CONFLICT', `用户名 ${input.username} 已存在`);
    }
    const id = newUserId();
    insertUser(this.db, {
      id,
      tenantId: 'default',
      kind: 'human',
      username: input.username,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      isAdmin: input.isAdmin === true ? 1 : 0,
      createdAt: nowMs(),
    });
    const user = findUserById(this.db, id);
    if (!user) throw new AgentLinkError('CONFLICT', '创建账号失败');
    return user;
  }

  usersByIds(ids: readonly string[]): UserRow[] {
    return findUsersByIds(this.db, ids);
  }
}

async function verifyAccessTokenSafe(
  config: Config,
  token: string,
): Promise<{ ok: true; claims: { sub: string; kind: 'human' | 'agent' } } | { ok: false; reason: 'expired' | 'invalid' }> {
  const { verifyAccessToken } = await import('./jwt.js');
  const r = await verifyAccessToken(config, token);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, claims: { sub: r.claims.sub, kind: r.claims.kind } };
}
