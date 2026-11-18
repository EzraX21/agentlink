import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { registerCors } from './cors.js';

/**
 * CORS 白名单：分离部署时的准入。
 *
 * 这里用真的 Fastify 实例 + 真的 HTTP 请求来验，而不是 mock reply ——
 * CORS 的坑几乎都在"头有没有真的发出去"上。
 */

async function build(origins: string[]) {
  const app = Fastify({ logger: false });
  await registerCors(app, origins);
  app.get('/api/ping', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('registerCors', () => {
  let app: Awaited<ReturnType<typeof build>> | null = null;
  afterEach(async () => {
    if (app !== null) await app.close();
    app = null;
  });

  it('没配来源时一个 CORS 头都不加（同源部署）', async () => {
    app = await build([]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('白名单命中：回显该来源并带 vary: Origin', async () => {
    app = await build(['https://app.example.com']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { origin: 'https://app.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    expect(res.headers['vary']).toBe('Origin');
    expect(res.statusCode).toBe(200);
  });

  it('非白名单来源：拿不到 CORS 头（浏览器会拦）', async () => {
    app = await build(['https://app.example.com']);
    const res = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('预检 OPTIONS 直接 204，并放行必要的方法与头', async () => {
    app = await build(['https://app.example.com']);
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/agent/messages',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
    const allowHeaders = String(res.headers['access-control-allow-headers']);
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
    // 分离部署要用的两个自定义头
    expect(allowHeaders).toContain('x-agentlink-conv');
    expect(allowHeaders).toContain('mcp-session-id');
  });

  it('绝不返回通配符（带 Authorization 时通配符等于泄露 token）', async () => {
    app = await build(['https://app.example.com']);
    for (const method of ['GET', 'OPTIONS'] as const) {
      const res = await app.inject({
        method,
        url: '/api/ping',
        headers: { origin: 'https://app.example.com' },
      });
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('多个来源各自回显自己', async () => {
    app = await build(['https://a.example.com', 'https://b.example.com']);
    const a = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { origin: 'https://a.example.com' },
    });
    const b = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { origin: 'https://b.example.com' },
    });
    expect(a.headers['access-control-allow-origin']).toBe('https://a.example.com');
    expect(b.headers['access-control-allow-origin']).toBe('https://b.example.com');
  });
});
