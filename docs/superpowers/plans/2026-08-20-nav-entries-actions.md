# 面试列表双入口 + 详情/报告页去互跳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 列表页每行提供「看报告」+「面试详情」双入口；详情页与报告页只返回列表、互不跳转。

**Architecture:** 纯前端改动。三个页面组件（InterviewListPage / InterviewDetailPage / ReportPage）各调整其链接区。列表行的状态→按钮映射抽为可测试的纯函数 `entryLinksFor(status)`，供 vitest 断言。

**Tech Stack:** React 19 + TypeScript + Vite 8；vitest + jsdom（已有）。

## Global Constraints

- 零后端改动，仅 `frontend/` 内 3 个页面文件 + 1 个测试文件 + 可能的 labels 文件。
- 用户可见文案全中文，按钮文案精确为：`看报告`、`面试详情`、`进入面试`。
- 不改列表行布局结构（仅调整 `.interview-list-links` 区）。
- 不改移动端底部 tab 栏、不改 AppNav 本身。
- 详情页保留：顶部 AppNav、`← 全部面试` 返回、`存入题库`、对话记录。
- 报告页保留：顶部 AppNav、`← 全部面试` 返回、报告内容与重试逻辑。
- 提交信息遵循仓库习惯（`feat(room|nav|...): ...`）。
- 每个任务须通过 `npm test` 与 `npx tsc --noEmit -p tsconfig.app.json`。

---

### Task 1: 列表行按钮映射纯函数 + 测试

**Files:**
- Create: `frontend/src/lib/listEntries.ts`
- Test: `frontend/src/lib/listEntries.test.ts`

**Interfaces:**
- Produces: `export type EntryStatus = 'completed' | 'in_progress' | 'other';` 与
  `export function entryLinksFor(status: EntryStatus): { label: string; to: string }[]`
  - `completed` → `[{ label: '看报告', to: 'report' }, { label: '面试详情', to: '' }]`
  - `in_progress` → `[{ label: '进入面试', to: 'room' }, { label: '面试详情', to: '' }]`
  - `other` → `[{ label: '面试详情', to: '' }]`
  - `to` 存相对片段（`report`/`room`/空字符串），由调用方拼完整路径。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/listEntries.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { entryLinksFor } from './listEntries';

describe('entryLinksFor', () => {
  it('completed 显示看报告与面试详情', () => {
    expect(entryLinksFor('completed')).toEqual([
      { label: '看报告', to: 'report' },
      { label: '面试详情', to: '' },
    ]);
  });

  it('in_progress 显示进入面试与面试详情', () => {
    expect(entryLinksFor('in_progress')).toEqual([
      { label: '进入面试', to: 'room' },
      { label: '面试详情', to: '' },
    ]);
  });

  it('other 仅显示面试详情', () => {
    expect(entryLinksFor('other')).toEqual([{ label: '面试详情', to: '' }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/lib/listEntries.test.ts`
Expected: FAIL（`./listEntries` 模块不存在）

- [ ] **Step 3: 写最小实现**

`frontend/src/lib/listEntries.ts`:

```ts
export type EntryStatus = 'completed' | 'in_progress' | 'other';

export interface EntryLink {
  label: string;
  to: string;
}

export function entryLinksFor(status: EntryStatus): EntryLink[] {
  if (status === 'completed') {
    return [
      { label: '看报告', to: 'report' },
      { label: '面试详情', to: '' },
    ];
  }
  if (status === 'in_progress') {
    return [
      { label: '进入面试', to: 'room' },
      { label: '面试详情', to: '' },
    ];
  }
  return [{ label: '面试详情', to: '' }];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/lib/listEntries.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/listEntries.ts frontend/src/lib/listEntries.test.ts
git commit -m "test(list): entryLinksFor status-to-links mapping"
```

---

### Task 2: 列表页使用双入口

**Files:**
- Modify: `frontend/src/pages/InterviewListPage.tsx:38-49`（InterviewRow 的 `.interview-list-links` 区）

**Interfaces:**
- Consumes: `entryLinksFor` 与 `EntryStatus` 从 `../lib/listEntries`（Task 1 产出）
- Produces: 无（本任务是终点页改动）

- [ ] **Step 1: 修改 InterviewRow**

在 `frontend/src/pages/InterviewListPage.tsx`：

1. 顶部 import 区添加（放在现有 `import './InterviewPages.css';` 之后、`import AppNav ...` 之前或同区）：

```ts
import { entryLinksFor, type EntryStatus } from '../lib/listEntries';
```

2. 替换 `InterviewRow` 内 `.interview-list-links` 整块（当前 `:38-49`）：

```tsx
      <div className="interview-list-links">
        {entryLinksFor((item.status === 'completed' || item.status === 'in_progress' ? item.status : 'other') as EntryStatus).map((link) => (
          <Link
            key={link.label}
            className="interview-inline-link"
            to={
              link.to === ''
                ? `/interviews/${item.id}`
                : `/interviews/${item.id}/${link.to}`
            }
          >
            {link.label}
          </Link>
        ))}
      </div>
```

> 说明：原 `item.status === 'completed' && <Link>报告</Link>` 与 `item.status === 'in_progress' && <Link>进入面试</Link>` 整块被上述映射渲染替换。标题「面试 #id」仍是详情链接（`/interviews/{id}`），保持不变。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 3: 运行测试确认无回归**

Run: `npm test`
Expected: PASS（含新增 listEntries 3 个测试）

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/InterviewListPage.tsx
git commit -m "feat(nav): dual entries (report/detail) on interview list rows"
```

---

### Task 3: 详情页移除「查看报告」

**Files:**
- Modify: `frontend/src/pages/InterviewDetailPage.tsx:126-153`

- [ ] **Step 1: 移除「查看报告」链接**

在 `frontend/src/pages/InterviewDetailPage.tsx` 的 `.interview-list-links` 区块（`:126-153`）内，删除 completed 分支：

```tsx
              {interview.status === 'completed' && (
                <Link
                  className="interview-inline-link"
                  to={`/interviews/${interview.id}/report`}
                >
                  查看报告
                </Link>
              )}
```

保留：in_progress 的「继续面试」、`存入题库` 按钮、`← 全部面试` 返回、顶部 AppNav。此区块剩余结构：

```tsx
            <div className="interview-list-links" style={{ marginBottom: 'var(--space-xl)' }}>
              {interview.status === 'in_progress' && (
                <Link
                  className="interview-inline-link"
                  to={`/interviews/${interview.id}/room`}
                >
                  继续面试
                </Link>
              )}
              {interview.questions.length > 0 && (
                <button
                  type="button"
                  className="interview-inline-link"
                  onClick={() => void handleSaveToBank()}
                  disabled={savingToBank}
                >
                  {savingToBank ? '存入中…' : '存入题库'}
                </button>
              )}
            </div>
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 3: 运行测试确认无回归**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/InterviewDetailPage.tsx
git commit -m "feat(nav): remove report entry from interview detail page"
```

---

### Task 4: 报告页移除「查看本场对话」

**Files:**
- Modify: `frontend/src/pages/ReportPage.tsx:148-152`

- [ ] **Step 1: 移除「查看本场对话」链接**

在 `frontend/src/pages/ReportPage.tsx` 中删除整个 `.interview-list-links` 区块（`:148-152`）：

```tsx
        <div className="interview-list-links" style={{ marginBottom: 'var(--space-md)' }}>
          <Link className="interview-inline-link" to={`/interviews/${id}`}>
            查看本场对话 →
          </Link>
        </div>
```

保留：`← 全部面试` 返回（`:142-144`）、顶部 AppNav、报告内容与重试逻辑。

> 注意：删除该区块后，页面内 `Link` 仍被 `← 全部面试` 使用，import 保持不变。

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 3: 运行测试确认无回归**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/ReportPage.tsx
git commit -m "feat(nav): remove conversation entry from report page"
```

---

### Task 5: 全量回归验证

**Files:**
- 无代码改动

- [ ] **Step 1: 运行全量测试**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功（仅既有 chunk 大小提示）

- [ ] **Step 3: 验证验收标准**

对照 spec 逐条确认：
- 列表页 completed 行显示「看报告」「面试详情」两个链接
- 列表页 in_progress 行显示「进入面试」「面试详情」两个链接
- 其他状态行显示「面试详情」
- 详情页无「查看报告」入口，只有「← 全部面试」返回
- 报告页无「查看本场对话」入口，只有「← 全部面试」返回

可用的页面路由（需后端）：
- 列表 `http://127.0.0.1:5174/`
- 详情 `http://127.0.0.1:5174/interviews/{id}`
- 报告 `http://127.0.0.1:5174/interviews/{id}/report`

若环境可用，用 Playwright 打开上述页面确认链接文本与去向；不可用则以代码审查 + 测试为准并在报告注明。

- [ ] **Step 4: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-nav-entries-actions/task-5-report.md`，列出验收逐条结果与验证证据。
