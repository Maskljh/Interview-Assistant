# 题库分组「查看」跳转详情页的来源感知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 详情页感知是否来自题库页：从题库进来时隐藏「存入题库」、返回链接改为「← 返回题库页」、顶部导航高亮「题库」。

**Architecture:** 题库页「查看」链接加 `?from=questions` 查询参数；详情页用 `useSearchParams` 读取并据此做三处条件渲染（存入题库按钮、返回链接、AppNav tab）。来源判定抽为可测试纯函数。

**Tech Stack:** React 19 + TypeScript + Vite 8；react-router-dom v7；vitest + jsdom（已有）。

## Global Constraints

- 零后端改动，仅 `frontend/` 内 2 个页面文件 + 1 个纯函数文件 + 1 个测试文件。
- 用户可见文案精确：`存入题库`、`← 全部面试`、`← 返回题库页`。
- 判定条件精确：`from === 'questions'`。
- 仅题库「查看」链接带参；列表页等其他入口不带参，行为不变。
- 不改 AppNav 组件本身、不改题库页布局、不做其他来源感知。
- 提交信息遵循仓库习惯（`feat(question-bank|nav): ...`）。
- 每个任务须通过 `npm test` 与 `npx tsc --noEmit -p tsconfig.app.json`。

---

### Task 1: 详情页来源感知纯函数 + 测试

**Files:**
- Create: `frontend/src/lib/detailSource.ts`
- Test: `frontend/src/lib/detailSource.test.ts`

**Interfaces:**
- Produces:
  - `export type DetailSource = 'list' | 'questions';`
  - `export function detailSourceFrom(from: string | null): DetailSource` — 返回 `'questions'` 当 `from === 'questions'`，否则 `'list'`。
  - `export function isFromQuestions(from: string | null): boolean` — `from === 'questions'`。

- [ ] **Step 1: 写失败测试**

`frontend/src/lib/detailSource.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detailSourceFrom, isFromQuestions } from './detailSource';

describe('detailSourceFrom', () => {
  it('from=questions 判定为 questions', () => {
    expect(detailSourceFrom('questions')).toBe('questions');
  });

  it('from 缺失或其他值判定为 list', () => {
    expect(detailSourceFrom(null)).toBe('list');
    expect(detailSourceFrom('report')).toBe('list');
    expect(detailSourceFrom('')).toBe('list');
  });
});

describe('isFromQuestions', () => {
  it('from=questions 返回 true', () => {
    expect(isFromQuestions('questions')).toBe(true);
  });

  it('其他值返回 false', () => {
    expect(isFromQuestions(null)).toBe(false);
    expect(isFromQuestions('')).toBe(false);
    expect(isFromQuestions('list')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/lib/detailSource.test.ts`
Expected: FAIL（`./detailSource` 模块不存在）

- [ ] **Step 3: 写最小实现**

`frontend/src/lib/detailSource.ts`:

```ts
export type DetailSource = 'list' | 'questions';

export function detailSourceFrom(from: string | null): DetailSource {
  return from === 'questions' ? 'questions' : 'list';
}

export function isFromQuestions(from: string | null): boolean {
  return from === 'questions';
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- src/lib/detailSource.test.ts`
Expected: PASS（2 describe, 5 it）

- [ ] **Step 5: 提交**

```bash
git add frontend/src/lib/detailSource.ts frontend/src/lib/detailSource.test.ts
git commit -m "test(detail): detailSourceFrom/isFromQuestions source detection"
```

---

### Task 2: 详情页来源感知三处改动

**Files:**
- Modify: `frontend/src/pages/InterviewDetailPage.tsx`

**Interfaces:**
- Consumes: `isFromQuestions` 从 `../lib/detailSource`（Task 1 产出）

- [ ] **Step 1: 引入 useSearchParams 与 isFromQuestions**

在 `frontend/src/pages/InterviewDetailPage.tsx` 顶部：

1. 修改 react-router-dom 导入（当前 `:2` 为 `import { Link, useParams } from 'react-router-dom';`）：

```tsx
import { Link, useParams, useSearchParams } from 'react-router-dom';
```

2. 添加 `detailSource` 导入（放在 `./InterviewPages.css` import 之后、`AppNav` import 之前）：

```tsx
import { isFromQuestions } from '../lib/detailSource';
```

- [ ] **Step 2: 在组件内计算来源**

在 `InterviewDetailPage` 组件函数体顶部（`const { id } = useParams<{ id: string }>();` 之后）：

```tsx
  const [searchParams] = useSearchParams();
  const fromQuestions = isFromQuestions(searchParams.get('from'));
```

- [ ] **Step 3: 三处条件渲染**

1. **AppNav tab**（当前 `:95`）：`<AppNav tab="interviews" />` 改为：

```tsx
      <AppNav tab={fromQuestions ? 'questions' : 'interviews'} />
```

2. **返回链接**（当前 `:97-99`）：改为条件渲染：

```tsx
        {fromQuestions ? (
          <Link className="interview-back-link" to="/questions">
            ← 返回题库页
          </Link>
        ) : (
          <Link className="interview-back-link" to="/">
            ← 全部面试
          </Link>
        )}
```

3. **存入题库按钮**（当前 `:143-152` 的 `{interview.questions.length > 0 && (...)}` 块）：加前置门控 `!fromQuestions`：

```tsx
              {!fromQuestions && interview.questions.length > 0 && (
                <button
                  type="button"
                  className="interview-inline-link"
                  onClick={() => void handleSaveToBank()}
                  disabled={savingToBank}
                >
                  {savingToBank ? '存入中…' : '存入题库'}
                </button>
              )}
```

> 注意：`bankMessage`/`bankError` 的状态显示（`:154-155`）在 `fromQuestions` 时不会触发（按钮隐藏），无需改动。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 5: 运行测试确认无回归**

Run: `npm test`
Expected: PASS（含新增 detailSource 5 个测试）

- [ ] **Step 6: 提交**

```bash
git add frontend/src/pages/InterviewDetailPage.tsx
git commit -m "feat(nav): hide save-to-bank and adapt back link when arriving from question bank"
```

---

### Task 3: 题库页「查看」链接带来源参数

**Files:**
- Modify: `frontend/src/pages/QuestionBankPage.tsx:283-288`

- [ ] **Step 1: 修改「查看」链接**

在 `frontend/src/pages/QuestionBankPage.tsx` 的分组头部「查看」链接（`:283-288`），`to` 改为：

```tsx
                        to={`/interviews/${sessionId}?from=questions`}
```

（当前为 `` `/interviews/${sessionId}` ``，仅追加 `?from=questions`。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit -p tsconfig.app.json`
Expected: 无错误

- [ ] **Step 3: 运行测试确认无回归**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/QuestionBankPage.tsx
git commit -m "feat(question-bank): pass from=questions source on group view link"
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
- 题库页分组「查看」链接带 `?from=questions`
- 从题库进详情页：无「存入题库」按钮
- 从题库进详情页：返回链接为「← 返回题库页」，点击回 `/questions`
- 从题库进详情页：顶部导航高亮「题库」
- 从列表进详情页：行为与现状一致（有存入题库、返回「← 全部面试」、高亮「面试」）

可用页面路由（需后端 + 预览服务，通常 9090/5174）：
- 题库 `http://127.0.0.1:5174/questions`
- 详情 `http://127.0.0.1:5174/interviews/{id}?from=questions` 与不带参版本

若环境可用，用 Playwright 打开上述页面确认链接文本、按钮存在性、tab 高亮；不可用则以代码审查 + 测试为准并在报告注明。

- [ ] **Step 4: 汇报**

写最终报告至 `.superpowers/sdd/2026-08-20-question-bank-detail-source/task-4-report.md`，列出验收逐条结果与验证证据。
