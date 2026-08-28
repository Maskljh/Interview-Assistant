import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 全局错误边界：渲染期异常不白屏，展示可恢复的错误提示。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="interview-stub" style={{ padding: '48px 24px', textAlign: 'center' }}>
          <p className="interview-error">页面出错了，请刷新重试。</p>
          <details style={{ margin: '16px auto', maxWidth: 560, textAlign: 'left' }}>
            <summary>查看错误详情</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>
              {String(this.state.error.message || this.state.error)}
            </pre>
          </details>
          <button type="button" className="interview-submit" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <a className="interview-inline-link" href="/history" style={{ marginLeft: 12 }}>
            返回列表
          </a>
        </div>
      );
    }
    return this.props.children;
  }
}
