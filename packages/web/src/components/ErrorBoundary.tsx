import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 错误边界：渲染期异常不再白屏。
 *
 * 为什么必须有：聊天界面里任何一个组件抛错（比如某条消息的内容形状异常、
 * 某个附件解码失败），React 默认会把**整棵组件树卸掉** —— 用户看到全白页面，
 * 连"回退到登录"都点不到。这里兜住并给三条出路：
 *   1. 重试（重置边界，重新挂载子树）
 *   2. 重新加载（整页刷新，回到干净状态）
 *   3. 看到错误详情（折叠显示，便于反馈问题）
 *
 * 注意：错误边界**抓不到**事件处理器、异步回调、WS 消息里的异常 ——
 * 那些要靠 store 里的形状防御（见 lib/store.ts 的 isRenderableMessage）。
 */
interface Props {
  readonly children: ReactNode;
  /** 出错时的上下文说明，例如"聊天区"。 */
  readonly area?: string;
  /** 自定义回退 UI（可选）。 */
  readonly fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 生产环境这里应发到上报服务；本项目没有，就打到控制台便于排查
    console.error('[ErrorBoundary]', this.props.area ?? '(未标注)', error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    if (this.props.fallback !== undefined) return this.props.fallback(error, this.retry);

    return (
      <div className="grid h-full place-items-center p-6" style={{ background: 'var(--al-bg)' }}>
        <div className="al-card max-w-[520px]">
          <div className="mb-1 text-base font-semibold" style={{ color: 'var(--al-danger)' }}>
            界面出错了
          </div>
          <p className="al-muted mb-3 text-xs">
            出错位置：{this.props.area ?? '未知'}
            <br />
            你的消息不会因为界面出错而丢失（数据在服务端）。
          </p>

          <div className="mb-3 flex gap-2">
            <button className="al-btn" onClick={this.retry}>
              重试
            </button>
            <button className="al-btn-ghost" onClick={this.reload}>
              重新加载页面
            </button>
          </div>

          <details className="text-xs">
            <summary className="al-muted cursor-pointer">错误详情</summary>
            <pre className="mt-1 overflow-x-auto rounded p-2" style={{ background: 'var(--al-bg-hover)' }}>
              {error.name}: {error.message}
              {error.stack === undefined ? '' : `\n\n${error.stack.split('\n').slice(0, 6).join('\n')}`}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}