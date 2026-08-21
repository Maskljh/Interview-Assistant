# 按钮 UI 系统化 + 删除确认 Modal — 设计文档

日期：2026-08-20 · 版本：v1

## 背景与目标

应用现有按钮样式分散在多个 CSS 文件，缺少统一的变体系统：主按钮（`.interview-submit`）是黑底白字 pill，链接式按钮（`.interview-inline-link`）是文本链接，登录/注册（`.auth-submit`）又一套，危险操作（删除）无专属视觉，直接复用文本链接。删除的二次确认使用原生 `window.confirm`，与产品 UI 割裂。

目标：
1. 建立统一的按钮变体系统（primary / secondary / ghost / danger / link），应用到全部页面按钮。
2. 新建可复用 `ConfirmModal` 组件，替换题库页单题删除与批量删除的原生 `window.confirm`。

## 设计原则（沿用并打磨现有体系）

现有"克制单色 + pill 胶囊 + Geist 字体 + 浅阴影"是该产品的视觉身份，不推翻，补齐变体与状态。

## 按钮变体系统

在 `tokens.css` 新增按钮语义 token，并重构 CSS 为统一基类 + 变体修饰：

| 变体 | 视觉 | 用途 |
| --- | --- | --- |
| `primary` | 黑底白字 pill（沿用 `.interview-submit`） | 提交 / 开始 / 重试 |
| `secondary` | 白底 + hairline 边框 | 取消、次要动作 |
| `ghost` | 无边框，hover 淡灰底 | 文本级动作 |
| `danger` | 红底白字（`--color-error` 体系） | 删除类破坏性操作 |
| `link` | 现有 `.interview-inline-link` 保持 | 页内文本链接动作 |

**统一状态**：
- hover：微上浮（translateY(-1px)）/ 淡底色，统一 transition
- `:focus-visible`：键盘焦点环（`--shadow-focus`）
- `:disabled`：统一降透明度 + `cursor: not-allowed`
- `prefers-reduced-motion: reduce`：关闭位移动效

## ConfirmModal 组件

新建 `frontend/src/components/ConfirmModal.tsx` + 样式：

- Props：`open: boolean`、`title: string`、`description: string`、`confirmLabel?: string`（默认「删除」）、`cancelLabel?: string`（默认「取消」）、`onConfirm: () => void`、`onCancel: () => void`、`loading?: boolean`
- 结构：半透明遮罩 + 居中卡片；`role="dialog"` + `aria-modal="true"` + `aria-labelledby`/`aria-describedby`
- 交互：
  - 遮罩点击 → onCancel
  - `Esc` → onCancel
  - 自动聚焦「取消」按钮（安全默认）
  - 确认按钮为 danger 变体
- 关闭时对底层无状态残留（卸载即可）

## 页面改动

### 1. 按钮统一

将各页面按钮类替换为统一变体（保留既有类名别名，避免大改 JSX）：

- `.interview-submit` → 作为 primary 变体基类保留（语义化）
- 新增 `.btn` 基类 + `.btn--primary` / `.btn--secondary` / `.btn--ghost` / `.btn--danger` / `.btn--link` 变体
- 现有 `.auth-submit`、`.question-bank-bulk-delete` 等映射到对应变体
- `.interview-inline-link` 作为 link 变体的既有名保留（样式统一）

具体映射：
| 现有类 | 新变体 | 页面 |
| --- | --- | --- |
| `.interview-submit` | `btn btn--primary` | 创建、房间、题库开始练习、报告重试 |
| `.auth-submit` | `btn btn--primary`（宽版） | 登录、注册 |
| `.interview-inline-link`（删除场景） | `btn btn--danger btn--link` | 题库单题删除 |
| `.question-bank-bulk-delete` | `btn btn--danger` | 题库批量删除 |
| `.interview-header-cta` | `btn btn--primary`（compact） | 列表顶部新建、空态新建 |
| `.interview-back-link` | `btn btn--ghost`（带 ← 前缀） | 详情/创建/报告返回 |
| `.interview-inline-link`（其他） | `btn btn--link` | 详情/列表/房间/报告/404 |
| `.question-bank-text/.question-bank-expand-btn` | 保持（非按钮语义） | 题库展开 |

> 实现时以"类名最小改动"为原则：优先在 CSS 层把现有类名纳入新体系（如 `.interview-submit` 直接获得 `btn btn--primary` 的全部样式），JSX 仅对需要变体语义变化的按钮（删除、批量删除、返回）做必要调整。

### 2. 题库页删除改用 Modal

`QuestionBankPage.tsx`：
- `handleDelete`：删除 `window.confirm('确定删除这道题目吗？')`，改为打开 `ConfirmModal`（`open` state + 待删题目 state）
- `handleBulkDelete`：删除 `window.confirm('确定删除选中的 N 道题目吗？')`，改为打开 `ConfirmModal`（批量）
- 确认后执行原删除逻辑（`deleteQuestion` / `deleteQuestions`）
- Modal 的确认按钮文案：单题「删除这道题目」/ 批量「删除选中的 N 道」

## 非目标

- 不改后端。
- 不改 AppNav 组件本体（离开确认仍为原生 confirm）。
- 不改结束面试确认（InterviewRoomPage:735，非删除，保留原生 confirm）。
- 不改语音房间录音按钮（`.voice-record-button` 交互复杂，保留；仅统一状态若低成本）。
- 不做动画库/复杂动效。

## 验收标准

- [ ] `tokens.css` 新增按钮变体 token；`InterviewPages.css`/`AuthPages.css` 实现 `.btn` 基类 + 变体
- [ ] 全部页面按钮纳入新体系（主/次/危险/幽灵/链接），视觉一致
- [ ] 危险按钮（删除）有红色视觉；hover/focus/disabled 状态完整
- [ ] `ConfirmModal` 组件存在，支持 Esc/遮罩关闭、聚焦管理、aria 标注
- [ ] 题库页单题删除、批量删除均用 ConfirmModal，无 `window.confirm`
- [ ] `npm test`、`npm run build` 通过
