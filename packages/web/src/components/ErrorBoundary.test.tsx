import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary.js';

/**
 * 错误边界：渲染期异常不能白屏。
 *
 * 为什么值得单独测：React 的默认行为是"卸载整棵树"，一旦某个消息组件抛错，
 * 用户连"回到登录"都点不到。这里验证兜底 UI 与"重试"路径。
 */

function Boom({ shouldThrow }: { shouldThrow: boolean }): React.JSX.Element {
  if (shouldThrow) throw new Error('渲染炸了');
  return <div>一切正常</div>;
}

beforeEach(() => {
  // React 会把错误打到 console.error，测试里静音，避免刷屏
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('子组件抛错时显示兜底 UI，而不是白屏', () => {
    render(
      <ErrorBoundary area="聊天区">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('界面出错了')).toBeTruthy();
    expect(screen.getByText(/出错位置：聊天区/)).toBeTruthy();
    // 明确告诉用户数据不会丢（否则他们会以为消息没了）
    expect(screen.getByText(/消息不会因为界面出错而丢失/)).toBeTruthy();
  });

  it('提供重试与重新加载两条出路', () => {
    render(
      <ErrorBoundary area="聊天区">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载页面' })).toBeTruthy();
  });

  it('错误详情可展开查看（便于反馈问题）', () => {
    render(
      <ErrorBoundary area="聊天区">
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('错误详情')).toBeTruthy();
    expect(screen.getByText(/渲染炸了/)).toBeTruthy();
  });

  it('没有错误时原样渲染子组件', () => {
    render(
      <ErrorBoundary area="聊天区">
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('一切正常')).toBeTruthy();
    expect(screen.queryByText('界面出错了')).toBeNull();
  });

  it('支持自定义回退 UI', () => {
    render(
      <ErrorBoundary area="聊天区" fallback={(err) => <div>自定义：{err.message}</div>}>
        <Boom shouldThrow />
      </ErrorBoundary>,
    );
    expect(screen.getByText('自定义：渲染炸了')).toBeTruthy();
  });
});