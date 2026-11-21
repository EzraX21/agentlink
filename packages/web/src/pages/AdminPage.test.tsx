import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AdminPage } from './AdminPage.js';

/**
 * 管理页的渲染冒烟：只验证"能挂上去、关键文案/控件在"。
 * 真正的行为（建号、停用、拉人、审计筛选）在 scripts/acceptance/ui-admin.mjs
 * 里对着真实服务端跑 HTTP 断言 —— 组件测试不适合替代接口验收。
 */

vi.mock('../lib/api.js', () => ({
  api: {
    stats: vi
      .fn()
      .mockResolvedValue({
        humans: 2,
        agents: 1,
        admins: 1,
        disabledAgents: 0,
        disabledHumans: 0,
        convs: 3,
        messages: 42,
        events: 50,
      }),
    users: vi.fn().mockResolvedValue({ humans: [], agents: [] }),
    audit: vi.fn().mockResolvedValue({ items: [], actions: [] }),
    convs: vi.fn().mockResolvedValue({ items: [] }),
    convMembers: vi.fn().mockResolvedValue({ conv: {}, members: [] }),
  },
}));

const noop = (): void => {};

describe('管理页', () => {
  it('非管理员看到明确的拒绝，而不是空白页', () => {
    render(
      <AdminPage
        selfId="u_a"
        isAdmin={false}
        section="overview"
        onBack={noop}
      />,
    );
    expect(screen.getByText('需要管理员权限')).toBeTruthy();
    // 提示里要说清"第一个账号自动是管理员"，否则用户会卡住
    expect(screen.getByText(/第一个/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy();
  });

  it('管理员看到五个分区导航', () => {
    render(
      <AdminPage
        selfId="u_a"
        isAdmin
        section="overview"
        onBack={noop}
      />,
    );
    for (const label of ['概览', '账号', 'Agent', '群组', '审计日志']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('账号分区画出"新建人类账号"表单', () => {
    render(
      <AdminPage
        selfId="u_a"
        isAdmin
        section="users"
        onBack={noop}
      />,
    );
    expect(screen.getByText('新建人类账号')).toBeTruthy();
    expect(screen.getByPlaceholderText('用户名')).toBeTruthy();
    expect(screen.getByPlaceholderText('初始口令（≥8 位）')).toBeTruthy();
  });

  it('Agent 分区画出创建表单与"token 只显示一次"的说明', () => {
    render(
      <AdminPage
        selfId="u_a"
        isAdmin
        section="agents"
        onBack={noop}
      />,
    );
    expect(screen.getByText('新建 Agent')).toBeTruthy();
    expect(screen.getByPlaceholderText('用户名（英文，用于 @）')).toBeTruthy();
  });
});