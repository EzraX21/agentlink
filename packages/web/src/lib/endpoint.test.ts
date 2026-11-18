import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

/**
 * 前后端分离的关键：所有请求地址都从这里出。
 *
 * 这些用例锁的是"两种部署形态下地址怎么算"——
 * 同源要相对路径，分离要拼 base，wss 要跟随 https。
 * 写错的表现是"某些功能跨域失败"，很难从现象反推，所以必须有单测。
 */

describe('endpoint：同源模式', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('API_BASE 为空，apiUrl 返回相对路径', async () => {
    const { API_BASE, IS_SPLIT, apiUrl } = await import('./endpoint.js');
    expect(API_BASE).toBe('');
    expect(IS_SPLIT).toBe(false);
    expect(apiUrl('/api/auth/login')).toBe('/api/auth/login');
  });

  it('wsUrl 用当前 host，协议跟随页面', async () => {
    const { wsUrl } = await import('./endpoint.js');
    expect(wsUrl()).toMatch(/^ws:\/\/.+\/ws$/);
  });

  it('apiUrl 拒绝不以 / 开头的路径（防止拼出诡异地址）', async () => {
    const { apiUrl } = await import('./endpoint.js');
    expect(() => apiUrl('api/x')).toThrow();
  });
});

describe('endpoint：分离模式', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE', 'https://api.example.com/');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('去掉末尾斜杠，apiUrl 拼出完整地址', async () => {
    const { API_BASE, IS_SPLIT, apiUrl } = await import('./endpoint.js');
    expect(API_BASE).toBe('https://api.example.com');
    expect(IS_SPLIT).toBe(true);
    expect(apiUrl('/api/agent/self')).toBe('https://api.example.com/api/agent/self');
  });

  it('https 的 base → wss（否则浏览器会拦）', async () => {
    const { wsUrl } = await import('./endpoint.js');
    expect(wsUrl()).toBe('wss://api.example.com/ws');
  });
});

describe('endpoint：分离模式但 base 是 http', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:3000');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('用 ws 而不是 wss', async () => {
    const { wsUrl } = await import('./endpoint.js');
    expect(wsUrl()).toBe('ws://127.0.0.1:3000/ws');
  });
});
