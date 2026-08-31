import { useEffect, useRef, useState } from 'react';
import {
  type AvatarController,
  type AvatarStatus,
} from '../lib/avatar/avatarController';

interface Props {
  controller: AvatarController | null;
  enabled: boolean;
  onToggle: () => void;
}

/**
 * 数字人面试官面板：容器 div 常驻挂载（TalkingHead 会住里面 append 自己的
 * 渲染 canvas；不能用 canvas 元素做容器——canvas 是替换元素，其 DOM 子元素
 * 不参与布局渲染）。通过 enabled 控制显隐与渲染循环；加载/失败态以遮罩层呈现。
 */
export default function InterviewerAvatar({ controller, enabled, onToggle }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<AvatarStatus>('idle');
  const [message, setMessage] = useState('');

  // 订阅 controller 状态（可能已初始化过，先同步一次当前值）
  useEffect(() => {
    if (!controller) return;
    setStatus(controller.getStatus());
    setMessage(controller.getErrorMessage());
    return controller.subscribe((next, msg) => {
      setStatus(next);
      setMessage(msg);
    });
  }, [controller]);

  // 仅在开启时才加载模型并跑渲染循环；关闭时停渲染省 GPU
  useEffect(() => {
    if (!controller || !containerRef.current) return;
    if (!enabled) {
      controller.setRenderingEnabled(false);
      return;
    }
    controller.setRenderingEnabled(true);
    void controller.init(containerRef.current);
  }, [controller, enabled]);

  return (
    <section className={`ir-avatar${enabled ? '' : ' is-collapsed'}`}>
      <div className="ir-avatar-head">
        <h3 className="ir-avatar-title">AI 面试官</h3>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="数字人面试官开关"
          className={`ir-avatar-toggle${enabled ? ' is-on' : ''}`}
          onClick={onToggle}
        >
          <span className="ir-avatar-toggle-knob" />
          <span className="ir-avatar-toggle-label">{enabled ? '开' : '关'}</span>
        </button>
      </div>
      <div className="ir-avatar-stage">
        <div ref={containerRef} className="ir-avatar-stage-inner" />
        {enabled && status === 'loading' && (
          <div className="ir-avatar-mask">
            <span className="ir-avatar-spin" aria-hidden />
            面试官进场中…
          </div>
        )}
        {enabled && status === 'failed' && (
          <div className="ir-avatar-mask ir-avatar-mask--error">
            {message || '数字人不可用，已切换纯语音'}
          </div>
        )}
      </div>
    </section>
  );
}
