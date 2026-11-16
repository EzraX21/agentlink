import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import type { Config } from '../config.js';
import { newTokenJti } from '../ids.js';

/**
 * JWT 签发与校验（需求确认书 §8.2：jose）。
 *
 * - access token：15m，用于 WS 首帧 auth 与 HTTP Bearer
 * - refresh token：30d，轮换，旧 token 立即失效（M1 验收要求）
 *
 * token **只出现在帧体 / HTTP body**，不进 URL（协议 §2.4）。
 */

export interface AccessClaims {
  readonly sub: string;
  readonly kind: 'human' | 'agent';
  readonly tenant_id: string;
  readonly typ: 'access';
}

export interface RefreshClaims {
  readonly sub: string;
  readonly jti: string;
  readonly typ: 'refresh';
}

const ISSUER = 'agentlink';
const AUDIENCE = 'agentlink.v1';

function secretKey(config: Config): Uint8Array {
  return new TextEncoder().encode(config.jwtSecret);
}

export async function signAccessToken(
  config: Config,
  claims: Omit<AccessClaims, 'typ'>,
): Promise<{ token: string; expiresInSec: number }> {
  const key = secretKey(config);
  const token = await new SignJWT({
    kind: claims.kind,
    tenant_id: claims.tenant_id,
    typ: 'access',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.accessTokenTtl)
    .sign(key);
  return { token, expiresInSec: ttlToSeconds(config.accessTokenTtl) };
}

export async function signRefreshToken(
  config: Config,
  userId: string,
): Promise<{ token: string; jti: string; expiresAtMs: number }> {
  const key = secretKey(config);
  const jti = newTokenJti();
  const token = await new SignJWT({ typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setJti(jti)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.refreshTokenTtl)
    .sign(key);
  const expiresAtMs = Date.now() + ttlToSeconds(config.refreshTokenTtl) * 1000;
  return { token, jti, expiresAtMs };
}

export type VerifyResult<T> =
  | { ok: true; claims: T }
  | { ok: false; reason: 'expired' | 'invalid' };

export async function verifyAccessToken(
  config: Config,
  token: string,
): Promise<VerifyResult<AccessClaims>> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    const kind = payload.kind;
    if (kind !== 'human' && kind !== 'agent') return { ok: false, reason: 'invalid' };
    return {
      ok: true,
      claims: {
        sub: payload.sub,
        kind,
        tenant_id: typeof payload.tenant_id === 'string' ? payload.tenant_id : 'default',
        typ: 'access',
      },
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

export async function verifyRefreshToken(
  config: Config,
  token: string,
): Promise<VerifyResult<RefreshClaims>> {
  try {
    const { payload } = await jwtVerify(token, secretKey(config), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, claims: { sub: payload.sub, jti: payload.jti, typ: 'refresh' } };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}

/** `15m` / `30d` / `3600` → 秒。 */
export function ttlToSeconds(ttl: string): number {
  const m = /^(\d+)([smhd])?$/.exec(ttl.trim());
  if (!m) return 900;
  const n = Number(m[1]);
  switch (m[2]) {
    case 'd':
      return n * 86_400;
    case 'h':
      return n * 3_600;
    case 'm':
      return n * 60;
    default:
      return n;
  }
}
