import { useEffect, useRef, type ReactNode } from 'react';
import './Dialog.css';

interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/**
 * 通用模态对话框：遮罩 + 居中卡片 + 标题 + 内容 + 可选底部操作区。
 * 点击遮罩或按 Esc 关闭；打开时聚焦关闭按钮。
 */
export default function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  width = 480,
}: DialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  // 始终持有最新的 onClose，供 Escape 监听使用，避免内联回调导致 effect 反复重跑
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    // 仅在打开时聚焦一次关闭按钮；不再依赖 onClose，输入框打字引起的重渲染不会抢焦点
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="dialog-head">
          <h3 className="dialog-title">{title}</h3>
          <button
            ref={closeRef}
            type="button"
            className="dialog-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}
