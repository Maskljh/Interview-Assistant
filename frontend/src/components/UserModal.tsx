import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  deleteResume,
  listResumes,
  renameResume,
  uploadResume,
  type ResumeFile,
} from '../api/resumes';
import { extractResumeText } from '../lib/resumeParse';
import ConfirmModal from './ConfirmModal';
import './UserModal.css';

const MAX_RESUMES = 5;
const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10MB，与创建页简历/文案一致

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 简历卡片角标：按文件名后缀显示格式（PDF/DOCX/TXT…），无扩展名回退为「文件」。 */
function resumeBadgeLabel(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return '文件';
  return fileName.slice(idx + 1).toUpperCase();
}

/**
 * 用户管理弹窗（Figma 06）：左侧用户信息 + 右侧简历管理。
 * 只允许右上角 × 关闭，点击遮罩不关闭。
 */
export default function UserModal({ onClose }: { onClose: () => void }) {
  const { user, logout, refreshUser } = useAuth();
  const [resumes, setResumes] = useState<ResumeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<ResumeFile | null>(null);
  const [deleting, setDeleting] = useState<ResumeFile | null>(null);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);

  // 始终持有最新的 onClose，供 Escape 监听使用，避免内联回调导致 effect 反复重跑
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const load = useCallback(async () => {
    try {
      const items = await listResumes();
      setResumes(items);
      setError('');
    } catch {
      setError('简历加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void refreshUser().catch(() => {});
    // 仅在挂载时聚焦一次关闭按钮；onClose 变化不再触发重跑，输入不会抢焦点
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [load, refreshUser]);

  const remaining = Math.max(0, MAX_RESUMES - resumes.length);
  const displayName = user?.nickname || user?.username || user?.email || '未登录';
  const avatarInitial = displayName.trim().charAt(0).toUpperCase() || '?';
  const avatarUrl = user?.avatar_url || '';
  // 与侧边栏一致：WPS user_id 可能是账号名，仅当纯数字时才展示，否则用系统内 MZ- 编号
  const wpsUserId = user?.user_id ? String(user.user_id).trim() : '';
  const isNumericId = wpsUserId !== '' && /^\d+$/.test(wpsUserId);
  const userId = isNumericId
    ? wpsUserId
    : `MZ-${String(user?.id ?? 0).padStart(8, '0')}`;

  async function handleFile(file: File) {
    if (uploading) return;
    // 与提示文案一致：单文件不超过 10MB，超限前端先拦截，避免无谓解析与上传。
    if (file.size > MAX_RESUME_BYTES) {
      setError('文件不能超过 10MB');
      return;
    }
    setUploading(true);
    setError('');
    try {
      const text = await extractResumeText(file);
      await uploadResume(file, text);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  function handleRenameOpen(item: ResumeFile) {
    setRenaming(item);
    setRenameValue(item.name);
  }

  async function handleRenameConfirm() {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await renameResume(renaming.id, name);
      setRenaming(null);
      await load();
    } catch {
      setError('重命名失败');
    }
  }

  async function handleDeleteConfirm() {
    if (!deleting) return;
    try {
      await deleteResume(deleting.id);
      setDeleting(null);
      await load();
    } catch {
      setError('删除失败');
    }
  }

  function handleLogout() {
    // 先确认再退出，避免误触直接清空登录态。
    setConfirmLogout(true);
  }

  function handleLogoutConfirm() {
    setConfirmLogout(false);
    logout();
    onClose();
  }

  return (
    <div className="user-modal-overlay">
      <div className="user-modal" role="dialog" aria-modal="true" aria-label="用户管理">
        <header className="user-modal-head">
          <div>
            <h3 className="user-modal-title">用户管理</h3>
            <p className="user-modal-subtitle">管理你的个人资料和面试使用的简历文件。</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="user-modal-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>
        <div className="user-modal-body">
          {/* 左侧：用户信息 */}
          <aside className="user-info-panel">
            <h4 className="user-info-title">用户信息</h4>
            <div className="user-avatar-wrap">
              <div className="user-avatar-ring">
                {avatarUrl ? (
                  <img className="user-avatar user-avatar-img" src={avatarUrl} alt="" />
                ) : (
                  <div className="user-avatar">{avatarInitial}</div>
                )}
              </div>
            </div>
            <p className="user-name">{displayName}</p>
            <p className="user-id-label">用户 ID</p>
            <p className="user-id">{userId}</p>
            <button type="button" className="user-logout-btn" onClick={handleLogout}>
              退出登录
            </button>
            <div className="user-sync-card">
              <p>资料由 WPS 账号授权同步</p>
              <p className="user-sync-card-sub">可在账号中心更新头像与昵称</p>
            </div>
          </aside>

          {/* 右侧：简历管理 */}
          <section className="resume-panel">
            <div className="resume-panel-head">
              <div>
                <h4 className="resume-panel-title">个人简历</h4>
                <p className="resume-panel-subtitle">上传多份简历，在每场面试前选择使用版本。</p>
              </div>
              <button
                type="button"
                className="resume-upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || remaining === 0}
              >
                {uploading ? '上传中…' : '＋ 上传简历'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
            </div>

            <div className="resume-list-hint">
              <span>已上传 {resumes.length} / {MAX_RESUMES} 份简历</span>
              <span>支持 PDF、DOC、DOCX，单文件不超过 10 MB</span>
            </div>

            {loading ? (
              <p className="resume-empty">加载中…</p>
            ) : resumes.length === 0 ? (
              <p className="resume-empty">还没有简历，点击右上角上传。</p>
            ) : (
              <ul className="resume-list">
                {resumes.map((item) => (
                  <li key={item.id} className="resume-row">
                    <span className="resume-file-badge">{resumeBadgeLabel(item.name)}</span>
                    {renaming?.id === item.id ? (
                      <div className="resume-row-main">
                        <input
                          className="resume-rename-input"
                          value={renameValue}
                          autoFocus
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleRenameConfirm();
                            if (e.key === 'Escape') setRenaming(null);
                          }}
                        />
                        <div className="resume-rename-actions">
                          <button
                            type="button"
                            className="resume-row-action"
                            onClick={() => void handleRenameConfirm()}
                            disabled={!renameValue.trim()}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className="resume-row-action"
                            onClick={() => setRenaming(null)}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="resume-row-main">
                          <p className="resume-row-name">{item.name}</p>
                          <p className="resume-row-meta">
                            {formatSize(item.size_bytes)}
                            {item.updated_at ? ` · 更新于 ${item.updated_at}` : ''}
                          </p>
                        </div>
                        <button
                          type="button"
                          className="resume-row-action"
                          onClick={() => handleRenameOpen(item)}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          className="resume-row-action resume-row-action--danger"
                          onClick={() => setDeleting(item)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {error && <p className="resume-error">{error}</p>}

            {remaining > 0 && (
              <div className="resume-footer-hint">
                <span className="resume-footer-plus">＋</span>
                <div>
                  <p className="resume-footer-title">还可上传 {remaining} 份简历</p>
                  <p className="resume-footer-desc">不同岗位可匹配不同版本，开始面试时自由选择。</p>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>

      {deleting && (
        <ConfirmModal
          open
          title="删除简历"
          description={`确定删除「${deleting.name}」吗？删除后不可恢复。`}
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={() => void handleDeleteConfirm()}
          onCancel={() => setDeleting(null)}
        />
      )}
      {confirmLogout && (
        <ConfirmModal
          open
          title="退出登录"
          description="退出后需要重新登录才能继续使用面试助手，确定退出吗？"
          confirmLabel="退出登录"
          cancelLabel="取消"
          onConfirm={() => void handleLogoutConfirm()}
          onCancel={() => setConfirmLogout(false)}
        />
      )}
    </div>
  );
}
