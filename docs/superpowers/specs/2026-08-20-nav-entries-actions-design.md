# 面试列表双入口 + 详情/报告页去互跳 — 设计文档

日期：2026-08-20 · 版本：v1

## 背景与目标

当前面试列表行只有单一入口，且详情页与报告页互相跳转，导航路径不符合用户预期。

用户期望：
1. 列表每行提供**两个明确入口**：「看报告」和「面试详情（本场对话）」。
2. 详情页、报告页**只返回「我的面试」列表**，两页之间**不互相跳转**。

## 现状

| 页面 | 当前导航 |
| --- | --- |
| 列表页 `InterviewListPage` | 行标题「面试 #id」→ 详情；completed 行有「报告」→ report；in_progress 行有「进入面试」→ room |
| 详情页 `InterviewDetailPage` | 顶部 AppNav +「← 全部面试」返回；completed 时有「查看报告」→ report |
| 报告页 `ReportPage` | 顶部 AppNav +「← 全部面试」返回；有「查看本场对话 →」→ 详情 |

## 改动设计

### 1. 列表页每行（`frontend/src/pages/InterviewListPage.tsx`）

按状态显示按钮（`InterviewRow` 的 `.interview-list-links` 区）：

- `completed`：`看报告`（`/interviews/{id}/report`）+ `面试详情`（`/interviews/{id}`）
- `in_progress`：`进入面试`（`/interviews/{id}/room`）+ `面试详情`（`/interviews/{id}`）
- 其他状态：仅 `面试详情`（`/interviews/{id}`）

按钮沿用 `.interview-inline-link` 样式，保持现有视觉。

### 2. 详情页（`frontend/src/pages/InterviewDetailPage.tsx`）

- 移除 completed 时的 `查看报告` 链接（不再跳转报告页）。
- 保留：顶部 AppNav、`← 全部面试` 返回、`存入题库`、对话记录展示。

### 3. 报告页（`frontend/src/pages/ReportPage.tsx`）

- 移除 `查看本场对话 →` 链接（不再跳转详情页）。
- 保留：顶部 AppNav、`← 全部面试` 返回、报告内容与重试逻辑。

## 非目标

- 不改后端。
- 不改列表行布局结构（仅调整链接区）。
- 不改移动端底部 tab 栏。
- 不做报告页/详情页之间的其他入口（如进度条跳转）。

## 验收标准

- [ ] 列表页 completed 行显示「看报告」「面试详情」两个链接
- [ ] 列表页 in_progress 行显示「进入面试」「面试详情」两个链接
- [ ] 其他状态行显示「面试详情」
- [ ] 详情页无「查看报告」入口，只有「← 全部面试」返回
- [ ] 报告页无「查看本场对话」入口，只有「← 全部面试」返回
- [ ] `npm test`、`npm run build` 通过
