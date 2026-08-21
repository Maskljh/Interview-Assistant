# 按钮 UI 系统化 + 删除确认 Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立统一按钮变体系统（primary/secondary/ghost/danger/link）并应用到全部页面；新建 ConfirmModal 替换题库页删除的原生 `window.confirm`。

**Architecture:** 纯前端 CSS + React 组件改动。CSS 层新增 `.btn` 基类 + 变体，并把既有按钮类名（`.interview-submit` 等）映射为变体别名，实现视觉统一而不大改 JSX；`ConfirmModal` 是独立可复用组件；题库页用 Modal 状态替代两个 `window.confirm`。

**Tech Stack:** React 19 + TypeScript + Vite 8；vitest + jsdom（已有）；现有 `tokens.css`。

## Global Constraints

- 零后端改动，仅 `frontend/`。
- 不改 AppNav 组件本体（离开确认保持原生）。
- 不改结束面试确认（InterviewRoomPage:735，非删除）。
- 不改语音录音按钮（`.voice-record-button`）。
- 中文用户可见文案精确：单题「删除这道题目」、批量「删除选中的 N 道」。
- 危险（删除）视觉用 `--color-error` 红色体系。
- 提交信息遵循仓库习惯（`feat(ui|question-bank|component): ...`）。
- 每个任务须通过 `npx tsc --noEmit -p tsconfig.app.json` 与 `npm test`。

---

### Task 1: 按钮变体 CSS 系统

**Files:**
- Create: `frontend/src/styles/buttons.css`
- Modify: `frontend/src/pages/InterviewPages.css`（引入 buttons.css）
- Modify: `frontend/src/pages/AuthPages.css`（auth-submit 映射）

**Interfaces:**
- Produces: `.btn` 基类 + `.btn--primary` / `.btn--secondary` / `.btn--ghost` / `.btn--danger` / `.btn--link` 变体；既有类名（`.interview-submit`/`.auth-submit`/`.interview-back-link`/`.interview-header-cta`/`.interview-inline-link`/`.question-bank-bulk-delete`）获得对应变体视觉。

- [ ] **Step 1: 创建 buttons.css**

`frontend/src/styles/buttons.css`:

```css
/* ─── Button system ─── */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 24px;
  font: var(--text-button-lg);
  line-height: 1.2;
  border: none;
  border-radius: var(--rounded-pill);
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease, background-color 0.15s ease, color 0.15s ease;
  -webkit-tap-highlight-color: transparent;
}

.btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (prefers-reduced-motion: reduce) {
  .btn {
    transition: none;
    transform: none !important;
  }
}

/* primary — 黑底白字 */
.btn--primary {
  color: var(--color-on-primary);
  background: var(--color-primary);
  box-shadow: var(--shadow-sm);
}
.btn--primary:hover:not(:disabled) {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.btn--primary:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-xs);
}

/* secondary — 白底描边 */
.btn--secondary {
  color: var(--color-ink);
  background: var(--color-canvas);
  border: 1px solid var(--color-hairline-strong);
}
.btn--secondary:hover:not(:disabled) {
  border-color: var(--color-ink);
  background: var(--color-canvas-soft);
}

/* ghost — 无边框，hover 淡灰 */
.btn--ghost {
  color: var(--color-body);
  background: transparent;
}
.btn--ghost:hover:not(:disabled) {
  color: var(--color-ink);
  background: var(--color-canvas-soft-2);
}

/* danger — 红底白字 */
.btn--danger {
  color: var(--color-on-primary);
  background: var(--color-error);
  box-shadow: var(--shadow-sm);
}
.btn--danger:hover:not(:disabled) {
  background: var(--color-error-deep);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.btn--danger:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-xs);
}

/* link — 文本链接式动作 */
.btn--link {
  padding: 4px 8px;
  font: var(--text-body-sm);
  font-weight: 500;
  color: var(--color-link);
  background: transparent;
  border-radius: var(--rounded-sm);
}
.btn--link:hover:not(:disabled) {
  color: var(--color-link-deep);
  background: var(--color-link-bg-soft);
}
```

- [ ] **Step 2: 既有类名映射**

在 `frontend/src/pages/InterviewPages.css` 末尾追加映射（复用 `.btn` 变体视觉）：

```css
/* ─── Button system aliases ─── */
.interview-submit {
  /* primary */
}
.interview-submit:focus-visible,
.auth-submit:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
.question-bank-bulk-delete {
  /* danger */
}
```

> 关键：`.btn` 变体的具体样式不重复，而是通过把既有类名与 `.btn` 变体**组合使用**（JSX 加类）或在 CSS 里 `.interview-submit` 复用 `.btn--primary` 的规则。**采用方案**：CSS 选择器合并，让既有类名直接获得变体样式：

```css
.interview-submit,
.auth-submit {
  color: var(--color-on-primary);
  background: var(--color-primary);
  box-shadow: var(--shadow-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 24px;
  font: var(--text-button-lg);
  line-height: 1.2;
  border: none;
  border-radius: var(--rounded-pill);
  cursor: pointer;
  transition: box-shadow 0.15s ease, transform 0.15s ease;
}
.interview-submit:hover:not(:disabled),
.auth-submit:hover:not(:disabled) {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.interview-submit:active:not(:disabled),
.auth-submit:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: var(--shadow-xs);
}
.interview-submit:disabled,
.auth-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.interview-back-link {
  color: var(--color-body);
  text-decoration: none;
  font: var(--text-body-sm);
  font-weight: 500;
  padding: 6px 10px;
  margin-left: -10px;
  border-radius: var(--rounded-sm);
  transition: color 0.15s ease, background-color 0.15s ease;
}
.interview-back-link:hover {
  color: var(--color-ink);
  background: var(--color-canvas-soft-2);
}

.question-bank-bulk-delete {
  color: var(--color-error-deep);
  background: var(--color-error-soft);
  border: 1px solid var(--color-error);
  border-radius: var(--rounded-sm);
  padding: 8px 16px;
  font: var(--text-button-md);
  cursor: pointer;
  transition: all 0.15s ease;
}
.question-bank-bulk-delete:hover {
  color: var(--color-on-primary);
  background: var(--color-error);
}
```

- [ ] **Step 3: AuthPages.css 清理**

`frontend/src/pages/AuthPages.css` 的 `.auth-submit`（:77-103）改为依赖 InterviewPages.css 的合并规则（删除 AuthPages.css 中重复的 `.auth-submit` 定义，保留宽版/特殊 padding 覆盖若有）。若 auth-submit 需要全宽，加：

```css
.auth-submit {
  width: 100%;
}
```

> 注意：AuthPages.css 与 InterviewPages.css 的加载顺序——需确认 `.auth-submit` 的合并规则在其后生效。implementer 读 `AuthPages.css` 顶部是否 `@import` 或单独引用；若两文件均被页面 import，需保证 InterviewPages.css 的规则优先级（同特异性后加载者胜）。

- [ ] **Step 4: 构建验证**

Run (in `frontend/`): `npx tsc --noEmit -p tsconfig.app.json` + `npm run build`
Expected: 通过（无 JSX 改动，仅 CSS，构建应绿）

- [ ] **Step 5: 提交**

```bash
git add frontend/src/styles/buttons.css frontend/src/pages/InterviewPages.css frontend/src/pages/AuthPages.css
git commit -m "feat(ui): unified button variant system (primary/secondary/ghost/danger/link)"
```

---

### Task 2: ConfirmModal 组件

**Files:**
- Create: `frontend/src/components/ConfirmModal.tsx`
- Create: `frontend/src/components/ConfirmModal.css`
- Create: `frontend/src/components/ConfirmModal.test.tsx`
- Modify: `frontend/src/pages/QuestionBankPage.tsx`（仅 import CSS，后续 Task 3 使用组件）

**Interfaces:**
- Produces:
  - `interface ConfirmModalProps { open: boolean; title: string; description: string; confirmLabel?: string; cancelLabel?: string; loading?: boolean; onConfirm: () => void; onCancel: () => void; }`
  - `export default function ConfirmModal(props: ConfirmModalProps): JSX.Element | null`（`open` 为 false 时返回 null）

- [ ] **Step 1: 写测试（失败先行）**

`frontend/src/components/ConfirmModal.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ConfirmModal from './ConfirmModal';

describe('ConfirmModal', () => {
  it('open=false 时不渲染', () => {
    const { container } = render(
      <ConfirmModal open={false} title="t" description="d" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('open=true 渲染标题、说明与按钮', () => {
    render(
      <ConfirmModal open title="删除题目" description="确定删除吗？" confirmLabel="删除" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText('删除题目')).toBeTruthy();
    expect(screen.getByText('确定删除吗？')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('点击确认触发 onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal open title="t" description="d" onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('点击取消触发 onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open title="t" description="d" onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test -- src/components/ConfirmModal.test.tsx`
Expected: FAIL（组件不存在）
> 若 @testing-library/react 未安装，`npm i -D @testing-library/react` 并配置 vitest setup；implementer 检查 `frontend/vitest.config.ts` 是否已有 jsdom + setup，缺则补。

- [ ] **Step 3: 实现组件**

`frontend/src/components/ConfirmModal.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import './ConfirmModal.css';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = '删除',
  cancelLabel = '取消',
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-desc"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-modal-title" className="confirm-modal-title">
          {title}
        </h3>
        <p id="confirm-modal-desc" className="confirm-modal-desc">
          {description}
        </p>
        <div className="confirm-modal-actions">
          <button
            ref={cancelRef}
            type="button"
            className="btn btn--secondary"
            onClick={onCancel}
            disabled={loading}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? '处理中…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 样式**

`frontend/src/components/ConfirmModal.css`:

```css
.confirm-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-md);
  background: rgba(0, 0, 0, 0.4);
}

.confirm-modal {
  width: 100%;
  max-width: 380px;
  padding: var(--space-lg);
  background: var(--color-canvas);
  border-radius: var(--rounded-lg);
  box-shadow: var(--shadow-md);
}

.confirm-modal-title {
  margin: 0 0 var(--space-xs);
  font: var(--text-display-sm);
  color: var(--color-ink);
}

.confirm-modal-desc {
  margin: 0 0 var(--space-lg);
  font: var(--text-body-md);
  color: var(--color-body);
  white-space: pre-line;
}

.confirm-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-xs);
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- src/components/ConfirmModal.test.tsx`
Expected: PASS（4 tests）

- [ ] **Step 6: 全量验证 + 提交**

Run: `npm test` + `npx tsc --noEmit -p tsconfig.app.json`
Expected: PASS
```bash
git add frontend/src/components/ConfirmModal.tsx frontend/src/components/ConfirmModal.css frontend/src/components/ConfirmModal.test.tsx
git commit -m "feat(component): add reusable ConfirmModal with focus management and aria"
```

---

### Task 3: 题库页删除改用 ConfirmModal

**Files:**
- Modify: `frontend/src/pages/QuestionBankPage.tsx`

**Interfaces:**
- Consumes: `ConfirmModal`（Task 2 产出）

- [ ] **Step 1: 加状态与 Modal**

在 `QuestionBankPage.tsx` 组件顶部加 state：
```tsx
const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
const [deleting, setDeleting] = useState(false);
```

- [ ] **Step 2: 改 handleDelete / handleBulkDelete**

当前（读文件确认行号）：
```tsx
async function handleDelete(item: Question) {
  if (!window.confirm('确定删除这道题目吗？')) return;
  ...
}
async function handleBulkDelete() {
  if (selectedIds.length === 0) return;
  if (!window.confirm(`确定删除选中的 ${selectedIds.length} 道题目吗？`)) return;
  ...
}
```
改为：
- `handleDelete` 不直接 confirm，改为 `setDeleteTarget(item)`（打开 Modal）；新增 `confirmDelete()` 执行原删除逻辑（从 `setDeleteTarget(null)` 后 `deleteQuestion(item.id)`...）。
- `handleBulkDelete` 改为 `setBulkDeleteOpen(true)`；新增 `confirmBulkDelete()` 执行原批量删除逻辑。

具体（新增函数）：
```tsx
async function confirmDelete() {
  if (!deleteTarget) return;
  setDeleting(true);
  try {
    await deleteQuestion(deleteTarget.id);
    setQuestions((prev) => prev.filter((q) => q.id !== deleteTarget.id));
    setSelectedIds((prev) => prev.filter((id) => id !== deleteTarget.id));
    setDeleteTarget(null);
  } catch (err) {
    setError(err instanceof ApiError ? err.message : '删除失败');
  } finally {
    setDeleting(false);
  }
}

async function confirmBulkDelete() {
  setDeleting(true);
  try {
    await deleteQuestions(selectedIds);
    setQuestions((prev) => prev.filter((q) => !selectedIds.includes(q.id)));
    setSelectedIds([]);
    setBulkDeleteOpen(false);
  } catch (err) {
    setError(err instanceof ApiError ? err.message : '批量删除失败');
  } finally {
    setDeleting(false);
  }
}
```
原 `handleDelete`/`handleBulkDelete` 改为只开 Modal：
```tsx
function handleDelete(item: Question) {
  setDeleteTarget(item);
}
function handleBulkDelete() {
  if (selectedIds.length === 0) return;
  setBulkDeleteOpen(true);
}
```

- [ ] **Step 3: 渲染 Modal**

在页面 JSX 末尾（`</main>` 前或 `</div>` 内）加：
```tsx
<ConfirmModal
  open={deleteTarget !== null}
  title="删除题目"
  description={deleteTarget ? `确定删除这道题目吗？\n「${deleteTarget.question.slice(0, 50)}」` : ''}
  confirmLabel="删除这道题目"
  loading={deleting}
  onConfirm={() => void confirmDelete()}
  onCancel={() => setDeleteTarget(null)}
/>
<ConfirmModal
  open={bulkDeleteOpen}
  title="批量删除"
  description={`确定删除选中的 ${selectedIds.length} 道题目吗？删除后不可恢复。`}
  confirmLabel={`删除选中的 ${selectedIds.length} 道`}
  loading={deleting}
  onConfirm={() => void confirmBulkDelete()}
  onCancel={() => setBulkDeleteOpen(false)}
/>
```
并加 `import ConfirmModal from '../components/ConfirmModal';`。

- [ ] **Step 4: 验证 + 提交**

Run: `npx tsc --noEmit -p tsconfig.app.json` + `npm test`
Expected: PASS
```bash
git add frontend/src/pages/QuestionBankPage.tsx
git commit -m "feat(question-bank): confirm deletes via ConfirmModal instead of window.confirm"
```

---

### Task 4: 危险按钮 + 剩余页面按钮统一

**Files:**
- Modify: `frontend/src/pages/QuestionBankPage.tsx`（单题删除按钮加 danger 类）
- Modify: `frontend/src/pages/InterviewDetailPage.tsx` / `ReportPage.tsx` / `InterviewListPage.tsx` / `CreateInterviewPage.tsx` / `InterviewRoomPage.tsx` / `NotFoundPage.tsx`（如需类调整，最小化）

- [ ] **Step 1: 单题删除按钮 danger 化**

`QuestionBankPage.tsx` 单题删除按钮（当前 `className="interview-inline-link"`，读文件确认）改为危险链接样式：
```tsx
className="btn btn--danger btn--link"
```
（红色删除视觉）

- [ ] **Step 2: 批量删除按钮确认已 danger**

`question-bank-bulk-delete` 已在 Task 1 映射为 danger 视觉，无需 JSX 改动。

- [ ] **Step 3: 其他页面按钮类审查**

grep 各页面按钮类，将需要 danger/变体语义的调整；但保持最小化——CSS 层已统一主要视觉，JSX 仅对明显需要变体语义的（删除类）调整。若页面按钮已通过 CSS 映射获得统一视觉，无 JSX 改动。

- [ ] **Step 4: 验证 + 提交**

Run: `npx tsc --noEmit -p tsconfig.app.json` + `npm test` + `npm run build`
Expected: PASS
```bash
git add frontend/src/pages/
git commit -m "feat(ui): apply danger variant to delete actions across pages"
```

---

### Task 5: 全量回归验证

**Files:**
- 无代码改动

- [ ] **Step 1: 全量测试 + 构建**

Run (in `frontend/`): `npm test` + `npm run build`
Expected: 全部 PASS

- [ ] **Step 2: 验收标准核对**

对照 spec：
- `tokens.css` 新增按钮变体 token？（本计划在 buttons.css 定义变体；若 spec 要求 tokens.css 有 token，补一个 `--color-danger-bg` 等或说明按钮变体在 buttons.css）
- 全部页面按钮纳入新体系，视觉一致
- 危险按钮（删除）有红色视觉；hover/focus/disabled 完整
- ConfirmModal 存在，Esc/遮罩关闭、聚焦、aria 达标
- 题库页单题/批量删除用 ConfirmModal，无 `window.confirm`
- `npm test`、`npm run build` 通过

- [ ] **Step 3: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-button-system-modal/task-5-report.md`，列出验收逐条结果。
