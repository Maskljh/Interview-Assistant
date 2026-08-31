import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './ConfirmModal.css';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  /** 头部副标题（设计稿 question-add-dialog-head p） */
  description: string;
  /** 正文（设计稿 question-delete-dialog-body p），默认“此操作不可撤销，请确认是否继续。” */
  body?: string;
  error?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  /** 危险操作：红色确认键 + 红调头部渐变（设计稿 question-delete-dialog） */
  danger?: boolean;
  /** 确认按钮额外禁用条件（如收件人未就绪） */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  description,
  body,
  error = '',
  confirmLabel,
  cancelLabel = '取消',
  loading = false,
  danger = true,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  // 始终持有最新的 onCancel，供 Escape 监听使用，避免内联回调导致 effect 反复重跑
  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    // 仅在打开时聚焦一次取消按钮；不再依赖 onCancel，输入引起的重渲染不会抢焦点
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  // 挂到 #design-root（缩放画布外）：fixed 定位相对视口、尺寸不被 --home-fit 缩放
  const host =
    typeof document !== 'undefined' ? document.getElementById('design-root') : null;
  const fallback = typeof document !== 'undefined' ? document.body : null;
  const target = host ?? fallback;

  const dialog = (
    <div className="question-dialog-backdrop" onClick={onCancel}>
      <section
        className={`question-add-dialog${danger ? ' question-delete-dialog' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="question-add-dialog-head">
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onCancel}>
            ×
          </button>
        </header>
        <div className="question-add-dialog-rule" />
        <div className="question-delete-dialog-body">
          {body !== '' && <p>{body ?? '此操作不可撤销，请确认是否继续。'}</p>}
          {error && <p className="dialog-error" role="alert">{error}</p>}
          <div className="question-add-dialog-actions">
            <button
              ref={cancelRef}
              type="button"
              className="dialog-cancel"
              onClick={onCancel}
              disabled={loading}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={danger ? 'question-delete-confirm' : 'management-action'}
              onClick={onConfirm}
              disabled={loading || confirmDisabled}
            >
              {loading ? '处理中…' : (confirmLabel ?? (danger ? '确认删除' : '确定'))}
            </button>
          </div>
        </div>
      </section>
    </div>
  );

  return target ? createPortal(dialog, target) : dialog;
}
