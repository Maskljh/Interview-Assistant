# 成长分析跳转报告页的来源感知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 报告页感知是否来自成长分析：从成长分析进来时返回链接改为「← 返回成长分析」、顶部导航高亮「成长分析」。

**Architecture:** 成长分析页节点跳转加 `?from=trends` 查询参数；报告页用 `useSearchParams` 读取并据此做两处条件渲染（返回链接、AppNav tab）。来源检测函数 `detailSource.ts` 泛化为对象查找并新增 `isFromTrends`，保持 `isFromQuestions` 向后兼容。

**Tech Stack:** React 19 + TypeScript + Vite 8；react-router-dom v7；vitest + jsdom（已有）。

## Global Constraints

- 零后端改动，仅 `frontend/` 内 3 个文件 + 1 个测试文件。
- 用户可见文案精确：`← 返回成长分析`、`← 全部面试`。
- 判定条件精确：`from === 'trends'`。
- 仅成长分析页节点跳转带参；列表/房间等其他入口不带参，行为不变。
- `isFromQuestions` 签名与行为不变（`InterviewDetailPage.tsx` 已使用，勿破坏）。
- 不改 AppNav 组件、不改成长分析页布局、不改报告页内容与重试逻辑。
- 提交信息遵循仓库习惯（`feat(trends|nav|detail): ...`）。
- 每个任务须通过 `npm test` 与 `npx tsc --noEmit -p tsconfig.app.json`。

---

### Task 1: detailSource 泛化（对象查找 + isFromTrends）+ 测试

**Files:**
- Modify: `frontend/src/lib/detailSource.ts`
- Modify: `frontend/src/lib/detailSource.test.ts`

**Interfaces:**
- Produces:
  - `export type DetailSource = 'list' | 'questions' | 'trends';`
  - `export function detailSourceFrom(from: string | null): DetailSource`
  - `export function isFromQuestions(from: string | null): boolean`
  - `export function isFromTrends(from: string | null): boolean`
- Consumes（不变）: `isFromQuestions(from: string | null): boolean`（`InterviewDetailPage.tsx` 现有调用不受影响）

- [ ] **Step 1: 扩展测试**

在 `frontend/src/lib/detailSource.test.ts` 现有内容基础上，`detailSourceFrom` describe 内追加：

```ts
  it('from=trends 判定为 trends', () => {
    expect(detailSourceFrom('trends')).toBe('trends');
  });
```

并在文件末尾追加新的 describe：

```ts
describe('isFromTrends', () => {
  it('from=trends 返回 true', () => {
    expect(isFromTrends('trends')).toBe(true);
  });

  it('其他值返回 false', () => {
    expect(isFromTrends(null)).toBe(false);
    expect(isFromTrends('')).toBe(false);
    expect(isFromTrends('questions')).toBe(false);
    expect(isFromTrends('list')).toBe(false);
  });
});
```

同时更新现有断言中与 `'report'` 相关的内容：当前 `detailSourceFrom('report')` 断言为 `'list'`，保持有效（对象查找 fallback 到 `'list'`）。若现有测试用 `expect(...).toBe('list')` 验证 `'report'`，无需改动。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/lib/detailSource.test.ts`
Expected: FAIL（`isFromTrends` 未定义）

- [ ] **Step 3: 重写实现**

`frontend/src/lib/detailSource.ts` 全文替换为：

```ts
export type DetailSource = 'list' | 'questions' | 'trends';

const SOURCE_TO_DETAIL: Record<string, DetailSource> = {
  questions: 'questions',
  trends: 'trends',
};

export function detailSourceFrom(from: string | null): DetailSource {
  return from ? SOURCE_TO_DETAIL[from] ?? 'list' : 'list';
}

export function isFromQuestions(from: string | null): boolean {
  return detailSourceFrom(from) === 'questions';
}

export function isFromTrends(from: string | null): boolean {
  return detailSourceFrom(from) === 'trends';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/lib/detailSource.test.ts`
Expected: PASS（原 4 个 it + 新增 1 + 2 = 7 个 it）

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npm test` 与 `npx tsc --noEmit -p tsconfig.app.json`
Expected: 全部 PASS（确认 `isFromQuestions` 现有调用方无回归）

- [ ] **Step 6: 提交**

```bash
git add frontend/src/lib/detailSource.ts frontend/src/lib/detailSource.test.ts
git commit -m "feat(detail): generalize source detection with lookup and isFromTrends"
```

---

### Task 2: 报告页来源感知（返回链接 + AppNav tab）

**Files:**
- Modify: `frontend/src/pages/ReportPage.tsx`

**Interfaces:**
- Consumes: `isFromTrends(from: string | null): boolean` 从 `../lib/detailSource`（Task 1 产出）

- [ ] **Step 1: 引入 useSearchParams 与 isFromTrends**

在 `frontend/src/pages/ReportPage.tsx` 顶部：

1. 修改 react-router-dom 导入（当前 `:2` 为 `import { Link, useParams } from 'react-router-dom';`）：

```tsx
import { Link, useParams, useSearchParams } from 'react-router-dom';
```

2. 添加 `detailSource` 导入（放在 `./InterviewPages.css` import 之后、`AppNav` import 之前）：

```tsx
import { isFromTrends } from '../lib/detailSource';
```

- [ ] **Step 2: 在组件内计算来源**

在 `ReportPage` 组件函数体顶部（`const { id } = useParams<{ id: string }>();` 之后）：

```tsx
  const [searchParams] = useSearchParams();
  const fromTrends = isFromTrends(searchParams.get('from'));
```

- [ ] **Step 3: 两处条件渲染**

1. **AppNav tab**（当前 `:140`）：`<AppNav tab="interviews" />` 改为：

```tsx
      <AppNav tab={fromTrends ? 'trends' : 'interviews'} />
```

2. **返回链接**（当前 `:142-144`）：改为条件渲染：

```tsx
        {fromTrends ? (
          <Link className="interview-back-link" to="/trends">
            ← 返回成长分析
          </Link>
        ) : (
          <Link className="interview-back-link" to="/">
            ← 全部面试
          </Link>
        )}
```

> 注意：报告页 error 分支（`:153-155`）另有「← 返回列表」→ `/`（V18 既有，spec 非目标不改）。该链接与 `fromTrends` 无关，保留。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 5: 运行测试确认无回归**

Run: `npm test`
Expected: PASS（含新增 detailSource 测试）

- [ ] **Step 6: 提交**

```bash
git add frontend/src/pages/ReportPage.tsx
git commit -m "feat(nav): adapt back link and active tab on report page from trends"
```

---

### Task 3: 成长分析页节点跳转带来源参数

**Files:**
- Modify: `frontend/src/pages/TrendsPage.tsx:200`

- [ ] **Step 1: 修改节点跳转**

在 `frontend/src/pages/TrendsPage.tsx` 得分趋势图节点 `onClick`（`:200`），改为：

```tsx
                        onClick={() => navigate(`/interviews/${payload.session_id}/report?from=trends`)}
```

（当前为 `` navigate(`/interviews/${payload.session_id}/report`) ``，仅追加 `?from=trends`。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 3: 运行测试确认无回归**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/TrendsPage.tsx
git commit -m "feat(trends): pass from=trends source on report dot navigation"
```

---

### Task 4: 全量回归验证

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
- 成长分析页节点跳转链接带 `?from=trends`
- 从成长分析进报告页：返回链接为「← 返回成长分析」，点击回 `/trends`
- 从成长分析进报告页：顶部导航高亮「成长分析」
- 从列表/房间进报告页：行为与现状一致（「← 全部面试」、高亮「面试」）
- 现有 `detailSource` 测试全部通过（含新增 `isFromTrends` 测试）

可用页面路由（需后端 + 预览服务，通常 9090/5174）：
- 成长分析 `http://127.0.0.1:5174/trends`
- 报告 `http://127.0.0.1:5174/interviews/{id}/report?from=trends` 与不带参版本

若环境可用，用 Playwright 打开上述页面确认链接文本、tab 高亮；不可用则以代码审查 + 测试为准并在报告注明。注意：成长分析页需要至少一条有报告数据的趋势点才能点击节点；若测试账号无 completed 面试，说明限制。

- [ ] **Step 4: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-report-source-trends/task-4-report.md`，列出验收逐条结果与验证证据。
