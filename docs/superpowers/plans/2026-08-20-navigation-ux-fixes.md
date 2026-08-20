# 导航体验梳理与修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除页面跳转中的困惑与冗余：报告页去掉无上下文的「存入题库」按钮并补「查看本场对话」入口，统一 7 个页面的导航为共享 `AppNav` 组件，面试间离开加确认，删掉死代码。

**Architecture:** 全部前端改动。新建共享导航组件 `AppNav`（header + 移动端 TabBar 一体化，按 `tab` prop 渲染全局链接/高亮/上下文动作/退出登录，`confirmLeave` 对面试间所有离开链接做 `window.confirm` 拦截），7 个页面替换各自手写的 header 与 `MobileTabBar`；报告页删除存题按钮及相关状态/请求，改为「查看本场对话」链接；各页面同步清理不再使用的导入（`tsc` 的 `noUnusedLocals` 兜底）。

**Tech Stack:** React 19 + TypeScript (vite 8, `tsc -b` 构建) + vitest/@testing-library/react（AppNav 组件测试）+ oxlint

**Spec:** `docs/superpowers/specs/2026-08-20-navigation-ux-fixes-design.md`

## Global Constraints

- **零后端改动、零数据库迁移**
- 所有用户可见文案为中文
- 不重构现有大文件结构（`InterviewRoomPage.tsx` 1069 行保持现状，仅增量修改）
- 每个任务结束时 `cd frontend && npm run build`（`tsc -b && vite build`）与 `npm run lint` 必须通过
- `tsconfig.app.json` 开启 `noUnusedLocals`/`noUnusedParameters`/`verbatimModuleSyntax`：删除使用点后必须同步删除导入，类型导入用 `import type`
- 分支：`nav-ux-fixes`（2026-08-20 从 main 分出；因另一进程并发实现 V18 room-ux 计划提交同一 main，经用户批准本计划改在独立分支执行，完成后合并回 main）
- 提交信息遵循仓库习惯：`feat(nav): ...` / `test(nav): ...` / `docs(nav): ...`
- 移动端（<600px）header 链接隐藏、底部 TabBar 显示的规则保持不变（`styles/mobile.css`）
- 品牌名统一为 `APP_NAME = '模拟面试助手'`（`src/lib/labels.ts`），AppNav 统一渲染，题库页不再单独写死「面试助手」

---

### Task 1: 安装测试依赖 + 扩展 vitest 配置 + AppNav 组件（TDD）

**Files:**
- Modify: `frontend/package.json`（devDependencies）
- Modify: `frontend/vitest.config.ts`（include 支持 .tsx）
- Create: `frontend/src/components/AppNav.tsx`
- Create: `frontend/src/components/AppNav.test.tsx`

**Interfaces:**
- Consumes: 无（不依赖其他任务）
- Produces: `AppNav`（default export，props: `{ tab: NavTab; actions?: NavAction[]; confirmLeave?: boolean }`），导出类型 `NavTab`、`NavAction`。后续 Task 2–8 全部使用；Task 9 删除 `MobileTabBar.tsx`。

- [ ] **Step 1: 安装测试库**

Run: `cd frontend && npm install -D @testing-library/react @testing-library/dom`
Expected: package.json devDependencies 出现 `@testing-library/react`、`@testing-library/dom`

- [ ] **Step 2: vitest 配置支持 .tsx 测试**

`frontend/vitest.config.ts` 完整内容改为：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 3: 写失败的测试**

`frontend/src/components/AppNav.test.tsx`：

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AppNav, { type NavAction, type NavTab } from './AppNav';
import { AuthProvider } from '../auth/AuthContext';

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

function renderNav(props: { tab: NavTab; actions?: NavAction[]; confirmLeave?: boolean }) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <AppNav {...props} />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const originalConfirm = window.confirm;
afterEach(() => {
  window.confirm = originalConfirm;
});

function mockConfirm(value: boolean) {
  const spy = vi.fn(() => value);
  window.confirm = spy as unknown as typeof window.confirm;
  return spy;
}

describe('AppNav', () => {
  it('renders brand and only non-current global tabs in header', () => {
    const { container } = renderNav({ tab: 'interviews' });
    const header = container.querySelector('.interview-header')!;
    const links = [...header.querySelectorAll('a.interview-header-link')].map((a) => a.textContent);
    expect(links).toEqual(['题库', '成长分析']);
    expect(header.textContent).toContain('模拟面试助手');
  });

  it('shows current global tab as an aria-current span, not a link', () => {
    const { container } = renderNav({ tab: 'questions' });
    const header = container.querySelector('.interview-header')!;
    const current = header.querySelector('span.interview-header-link[aria-current="page"]');
    expect(current?.textContent).toBe('题库');
    expect(header.querySelector('a[href="/questions"]')).toBeNull();
  });

  it('renders page actions, with cta variant using the cta class', () => {
    const { container } = renderNav({
      tab: 'interviews',
      actions: [{ to: '/interviews/new', label: '新建面试', variant: 'cta' }],
    });
    const header = container.querySelector('.interview-header')!;
    const cta = header.querySelector('a.interview-header-cta');
    expect(cta?.textContent).toBe('新建面试');
  });

  it('always renders all four tab-bar items, active from the tab prop', () => {
    const { container } = renderNav({ tab: 'create' });
    const tabbar = container.querySelector('nav.mobile-tabbar')!;
    expect(tabbar.querySelectorAll('a').length).toBe(4);
    const active = tabbar.querySelector('.is-active');
    expect(active?.textContent).toBe('新建');
  });

  it('blocks header navigation when confirmLeave and the user cancels', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'interviews', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/');
  });

  it('navigates after confirm when confirmLeave is set', () => {
    mockConfirm(true);
    const { container } = renderNav({ tab: 'interviews', confirmLeave: true });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });

  it('does not confirm when confirmLeave is unset', () => {
    const confirmSpy = mockConfirm(false);
    const { container } = renderNav({ tab: 'interviews' });
    const trendsLink = container.querySelector('a[href="/trends"]')!;
    fireEvent.click(trendsLink);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/trends');
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd frontend && npm test`
Expected: FAIL — 找不到 `./AppNav` 模块（模块不存在）

- [ ] **Step 5: 实现 AppNav**

`frontend/src/components/AppNav.tsx` 完整内容：

```tsx
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { APP_NAME } from '../lib/labels';

export type NavTab = 'interviews' | 'questions' | 'trends' | 'create';

export interface NavAction {
  to: string;
  label: string;
  variant?: 'link' | 'cta';
}

const TAB_BAR_ITEMS: { tab: NavTab; to: string; label: string }[] = [
  { tab: 'interviews', to: '/', label: '面试' },
  { tab: 'questions', to: '/questions', label: '题库' },
  { tab: 'trends', to: '/trends', label: '成长分析' },
  { tab: 'create', to: '/interviews/new', label: '新建' },
];

// 桌面 header 的全局链接：仅题库/成长分析；当前页显示为高亮文字占位
const HEADER_GLOBAL_TABS = TAB_BAR_ITEMS.filter(
  (item) => item.tab === 'questions' || item.tab === 'trends',
);

const LEAVE_CONFIRM = '离开将中断本场面试，确定离开吗？';

interface AppNavProps {
  tab: NavTab;
  actions?: NavAction[];
  confirmLeave?: boolean;
}

export default function AppNav({
  tab,
  actions = [],
  confirmLeave = false,
}: AppNavProps) {
  const { logout } = useAuth();
  const navigate = useNavigate();

  function guard(to: string): boolean {
    if (!confirmLeave) return true;
    return window.confirm(LEAVE_CONFIRM);
  }

  function handleClick(e: MouseEvent, to: string) {
    if (!guard(to)) e.preventDefault();
  }

  function handleLogout() {
    if (!guard('/')) return;
    logout();
  }

  return (
    <>
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
        <div className="interview-header-actions">
          {HEADER_GLOBAL_TABS.map((item) =>
            item.tab === tab ? (
              <span
                key={item.to}
                className="interview-header-link header-nav-link"
                aria-current="page"
              >
                {item.label}
              </span>
            ) : (
              <Link
                key={item.to}
                className="interview-header-link header-nav-link"
                to={item.to}
                onClick={(e) => handleClick(e, item.to)}
              >
                {item.label}
              </Link>
            ),
          )}
          {actions.map((action) => (
            <Link
              key={action.to + action.label}
              className={
                action.variant === 'cta'
                  ? 'interview-header-cta header-nav-link'
                  : 'interview-header-link header-nav-link'
              }
              to={action.to}
              onClick={(e) => handleClick(e, action.to)}
            >
              {action.label}
            </Link>
          ))}
          <button type="button" className="interview-header-link" onClick={handleLogout}>
            退出登录
          </button>
        </div>
      </header>
      <nav className="mobile-tabbar" aria-label="主导航">
        {TAB_BAR_ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className={`mobile-tabbar-item${item.tab === tab ? ' is-active' : ''}`}
            aria-current={item.tab === tab ? 'page' : undefined}
            onClick={(e) => handleClick(e, item.to)}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
```

> 说明：TabBar 从 `NavLink`（URL 匹配高亮）改为 `Link` + 由 `tab` prop 判定高亮——面试详情/报告页统一高亮「面试」，与 spec「active 状态由 tab 判定」一致。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd frontend && npm test`
Expected: PASS（7 个用例全绿）

- [ ] **Step 7: 构建与 lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: build 成功（tsc + vite），lint 无错误

- [ ] **Step 8: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/components/AppNav.tsx frontend/src/components/AppNav.test.tsx
git commit -m "feat(nav): add shared AppNav component with leave-confirm guard and tests"
```

---

### Task 2: 报告页 —— 删存题按钮、加「查看本场对话」、换 AppNav

**Files:**
- Modify: `frontend/src/pages/ReportPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 报告页不再引用 `importQuestionsFromSession` / `getInterview` / `useAuth` / `MobileTabBar`；新增正文入口「查看本场对话 →」指向 `/interviews/${id}`

- [ ] **Step 1: 调整 imports**

`frontend/src/pages/ReportPage.tsx` 头部导入改为（删除 `getInterview`、`importQuestionsFromSession`、`useAuth`、`MobileTabBar`、`APP_NAME`，新增 `AppNav`）：

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  getReport,
  retryReport,
  type InterviewFeedback,
} from '../api/interviews';
import { fetchExpression, type ExpressionResult } from '../api/expression';
import './InterviewPages.css';
import AppNav from '../components/AppNav';
```

- [ ] **Step 2: 删除存题相关状态与函数**

删除：`const [questionCount, setQuestionCount] = useState(0);`、`savingToBank`/`bankMessage`/`bankError` 三个 state、整个 `handleSaveToBank` 函数、`const { logout } = useAuth();`。

- [ ] **Step 3: 简化数据加载**

`load()` 中把：

```tsx
const [result, interview] = await Promise.all([
  getReport(interviewId),
  getInterview(interviewId),
]);
if (cancelled) return;
setQuestionCount(interview.questions.length);
```

改为：

```tsx
const result = await getReport(interviewId);
if (cancelled) return;
```

- [ ] **Step 4: 替换 header，删除存题按钮区块**

把整个 `<header className="interview-header">…</header>`（含 题库/成长分析/详情 链接与退出按钮）替换为：

```tsx
    <div className="interview-page">
      <AppNav
        tab="interviews"
        actions={[{ to: `/interviews/${id}`, label: '详情' }]}
      />
```

把存题按钮区块（`{questionCount > 0 && !loading && ( … )}` 及 `bankMessage`/`bankError` 两行）替换为：

```tsx
        <div className="interview-list-links" style={{ marginBottom: 'var(--space-md)' }}>
          <Link className="interview-inline-link" to={`/interviews/${id}`}>
            查看本场对话 →
          </Link>
        </div>
```

- [ ] **Step 5: 删除 MobileTabBar 使用**

删除文件末尾的 `<MobileTabBar />`（AppNav 已渲染 TabBar）。

- [ ] **Step 6: 构建与 lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: 通过（若报未使用导入，说明 Step 1 有漏删，补齐）

- [ ] **Step 7: 运行全量测试**

Run: `cd frontend && npm test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/ReportPage.tsx
git commit -m "feat(nav): remove contextless bank button on report, add conversation entry, use AppNav"
```

---

### Task 3: 详情页 —— 去掉重复「返回列表」，换 AppNav

**Files:**
- Modify: `frontend/src/pages/InterviewDetailPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 详情页 header 无「返回列表」（仅品牌 logo + 正文「← 全部面试」）；不再引用 `useAuth` / `MobileTabBar` / `APP_NAME`

- [ ] **Step 1: 调整 imports**

删除 `import { useAuth } from '../auth/AuthContext';`、`import MobileTabBar from '../components/MobileTabBar';`，labels 导入去掉 `APP_NAME`，新增 `import AppNav from '../components/AppNav';`。

- [ ] **Step 2: 删除 logout 使用**

删除 `const { logout } = useAuth();`。

- [ ] **Step 3: 替换 header**

把 `<header className="interview-header">…</header>` 整体替换为：

```tsx
    <div className="interview-page">
      <AppNav tab="interviews" />
```

- [ ] **Step 4: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 5: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/InterviewDetailPage.tsx
git commit -m "feat(nav): drop duplicate back-to-list in detail header, use AppNav"
```

---

### Task 4: 列表页 —— 行内去「详情」按钮，换 AppNav

**Files:**
- Modify: `frontend/src/pages/InterviewListPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: `InterviewRow` 行内无「详情」链接；不再引用 `useAuth` / `MobileTabBar` / `APP_NAME`

- [ ] **Step 1: 调整 imports**

删除 `useAuth`、`MobileTabBar` 导入；labels 导入去掉 `APP_NAME`；新增 `import AppNav from '../components/AppNav';`。

- [ ] **Step 2: 删除 logout 使用**

删除 `const { logout } = useAuth();`。

- [ ] **Step 3: 行内删除「详情」链接**

`InterviewRow` 的 `interview-list-links` 区块中删除：

```tsx
        <Link className="interview-inline-link" to={`/interviews/${item.id}`}>
          详情
        </Link>
```

保留「进入面试」（in_progress）与「报告」（completed）链接。

- [ ] **Step 4: 替换 header**

把 `<header className="interview-header">…</header>` 替换为：

```tsx
      <AppNav
        tab="interviews"
        actions={[{ to: '/interviews/new', label: '新建面试', variant: 'cta' }]}
      />
```

- [ ] **Step 5: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 6: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/InterviewListPage.tsx
git commit -m "feat(nav): remove redundant detail link in list rows, use AppNav"
```

---

### Task 5: 面试间 —— AppNav + 离开确认 + 结束确认

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 面试间所有离开导航带 `confirmLeave`；「结束面试」弹确认；不再引用 `Link` / `logout` / `APP_NAME` / `MobileTabBar`

- [ ] **Step 1: 调整 imports**

- 第 2 行改为 `import { useNavigate, useParams } from 'react-router-dom';`（去掉 `Link`）
- `import { APP_NAME, PERSONA_LABELS } from '../lib/labels';` 改为 `import { PERSONA_LABELS } from '../lib/labels';`
- 删除 `import MobileTabBar from '../components/MobileTabBar';`，新增 `import AppNav from '../components/AppNav';`

- [ ] **Step 2: 调整 useAuth 解构**

`const { logout, user } = useAuth();` 改为 `const { user } = useAuth();`

- [ ] **Step 3: 替换 header**

把 `<header className="interview-header">…</header>` 替换为：

```tsx
    <div className="interview-page">
      <AppNav
        tab="interviews"
        confirmLeave
        actions={[
          { to: '/', label: '返回列表' },
          { to: `/interviews/${id}`, label: '详情' },
        ]}
      />
```

- [ ] **Step 4: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 5: 「结束面试」加确认**

`handleForceEnd` 开头（`if (ending || doneRef.current) return;` 之后）插入：

```tsx
    if (!window.confirm('确定结束面试并生成报告吗？')) return;
```

- [ ] **Step 6: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(nav): guard all leave-navigation in room with confirm, confirm before ending"
```

---

### Task 6: 成长分析 —— 折线点直达报告页，换 AppNav

**Files:**
- Modify: `frontend/src/pages/TrendsPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 折线点点击跳 `/interviews/:id/report`；不再引用 `Link` / `useAuth` / `APP_NAME` / `MobileTabBar`

- [ ] **Step 1: 调整 imports**

- 第 2 行改为 `import { useNavigate } from 'react-router-dom';`（去掉 `Link`）
- 删除 `import { useAuth } from '../auth/AuthContext';`
- 删除 `import { APP_NAME } from '../lib/labels';`
- 删除 `import MobileTabBar from '../components/MobileTabBar';`，新增 `import AppNav from '../components/AppNav';`

- [ ] **Step 2: 删除 logout 使用**

删除 `const { logout } = useAuth();`（保留 `const navigate = useNavigate();`）。

- [ ] **Step 3: 替换 header**

把 `<header className="interview-header">…</header>` 替换为：

```tsx
      <AppNav
        tab="trends"
        actions={[{ to: '/', label: '面试列表' }]}
      />
```

- [ ] **Step 4: 折线点改跳报告页**

总分段折线 dot 的 onClick 改为：

```tsx
onClick={() => navigate(`/interviews/${payload.session_id}/report`)}
```

- [ ] **Step 5: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 6: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add frontend/src/pages/TrendsPage.tsx
git commit -m "feat(nav): jump trend dots straight to report, use AppNav"
```

---

### Task 7: 题库 —— 分组头「查看」链接，换 AppNav

**Files:**
- Modify: `frontend/src/pages/QuestionBankPage.tsx`
- Modify: `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 有来源分组头显示「查看」链接指向 `/interviews/${sessionId}`；不再引用 `useAuth` / `MobileTabBar`

- [ ] **Step 1: 调整 imports**

删除 `import { useAuth } from '../auth/AuthContext';` 与 `import MobileTabBar from '../components/MobileTabBar';`，新增 `import AppNav from '../components/AppNav';`。

- [ ] **Step 2: 删除 logout 使用**

删除 `const { logout } = useAuth();`（保留 `useNavigate`）。

- [ ] **Step 3: 替换 header**

把 `<header className="interview-header">…</header>` 替换为：

```tsx
      <AppNav
        tab="questions"
        actions={[{ to: '/', label: '面试列表' }]}
      />
```

- [ ] **Step 4: 分组头加「查看」链接**

在 `.question-group-header` 内、`question-group-toggle` 按钮与 `question-group-select-all` 标签之间插入（sessionId 为 null 时不渲染）：

```tsx
                    {sessionId != null && (
                      <Link
                        className="interview-inline-link question-group-view"
                        to={`/interviews/${sessionId}`}
                      >
                        查看
                      </Link>
                    )}
```

- [ ] **Step 5: CSS 补充**

`frontend/src/pages/InterviewPages.css` 中 `.question-group-select-all {` 规则（约 1047 行）之前加：

```css
.question-group-view {
  flex-shrink: 0;
}
```

- [ ] **Step 6: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 7: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/QuestionBankPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(nav): link question-bank session groups to their interview, use AppNav"
```

---

### Task 8: 新建面试页 —— 换 AppNav

**Files:**
- Modify: `frontend/src/pages/CreateInterviewPage.tsx`

**Interfaces:**
- Consumes: `AppNav`（Task 1）
- Produces: 创建页 header 含「返回列表」；不再引用 `Link` / `useAuth` / `APP_NAME` / `MobileTabBar`

- [ ] **Step 1: 调整 imports**

- 第 2 行改为 `import { useNavigate } from 'react-router-dom';`（去掉 `Link`）
- 删除 `import { useAuth } from '../auth/AuthContext';`
- labels 导入去掉 `APP_NAME`（保留 `DIMENSION_LABELS`、`MODE_LABELS`、`PERSONA_LABELS`）
- 删除 `import MobileTabBar from '../components/MobileTabBar';`，新增 `import AppNav from '../components/AppNav';`

- [ ] **Step 2: 删除 logout 使用**

删除 `const { logout } = useAuth();`。

- [ ] **Step 3: 替换 header**

把 `<header className="interview-header">…</header>` 替换为：

```tsx
      <AppNav
        tab="create"
        actions={[{ to: '/', label: '返回列表' }]}
      />
```

- [ ] **Step 4: 删除 MobileTabBar 使用**

删除文件末尾 `<MobileTabBar />`。

- [ ] **Step 5: 构建 + lint + 测试**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/CreateInterviewPage.tsx
git commit -m "feat(nav): use AppNav on create interview page"
```

---

### Task 9: 清理死代码 + 全量验证

**Files:**
- Delete: `frontend/src/pages/HomePage.tsx`
- Delete: `frontend/src/pages/HomePage.css`
- Delete: `frontend/src/components/MobileTabBar.tsx`

**Interfaces:**
- Consumes: 前 8 个任务的产出
- Produces: 无（收尾）

- [ ] **Step 1: 确认无残留引用**

Run: `cd frontend && grep -rn "MobileTabBar\|HomePage" src --include="*.tsx" --include="*.ts" --include="*.css" | grep -v "AppNav"`
Expected: 无输出（AppNav 已内联 TabBar；HomePage 仅被自身引用）

- [ ] **Step 2: 删除文件**

```bash
git rm frontend/src/pages/HomePage.tsx frontend/src/pages/HomePage.css frontend/src/components/MobileTabBar.tsx
```

- [ ] **Step 3: 全量门禁**

Run: `cd frontend && npm run build && npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 4: 手工走查导航矩阵**

启动前后端（`docker compose up -d` 后 `npm run dev` + `go run ./cmd/server`），登录后在**桌面（≥600px）与移动视口（≤599px）**各走一遍：

1. 列表 `/`：行标题进详情；行内只有「进入面试/报告」，无「详情」；header 有 题库/成长分析/新建面试 CTA/退出
2. 题库 `/questions`：header 题库为高亮文字非链接；分组「面试 #N」后有「查看」链接，点击进对应详情；「独立题目」分组无「查看」
3. 新建 `/interviews/new`：header 含「返回列表」；TabBar「新建」高亮
4. 详情 `/interviews/:id`：header 无「返回列表」；「存入题库」仍在对话记录上方；「查看报告/继续面试」可用
5. 面试间 `/:id/room`：点击 header 任何链接（返回列表/详情/成长分析）或 TabBar 任一项均弹「离开将中断本场面试，确定离开吗？」；取消不跳转，确认跳转；「结束面试」弹「确定结束面试并生成报告吗？」
6. 报告 `/:id/report`：无「存入题库」按钮；有「查看本场对话 →」进详情；header 有「详情」；报告生成中该入口仍可见
7. 成长分析 `/trends`：折线点点击直达该面试报告页

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(nav): remove dead HomePage and MobileTabBar after AppNav migration"
```

---

## Self-Review

**Spec 覆盖检查：**
- spec §1 AppNav 组件 → Task 1 ✓
- spec §2 报告页删按钮+对话入口 → Task 2 ✓
- spec §3 详情页去重复返回 → Task 3 ✓
- spec §4 列表页去行内详情 → Task 4 ✓
- spec §5 面试间 confirmLeave + 结束确认 → Task 5 ✓
- spec §6 趋势点直达报告 → Task 6 ✓
- spec §7 题库分组查看链接 → Task 7 ✓
- spec §8 清理 HomePage/MobileTabBar → Task 9 ✓
- spec 验证（build + 导航矩阵桌面/移动）→ Task 9 Step 3–4 ✓

**占位符检查：** 无 TBD/TODO；每个代码步骤都给出完整代码或精确删除目标。

**类型一致性：** `NavTab`（'interviews' | 'questions' | 'trends' | 'create'）、`NavAction`（{ to; label; variant? }）、`AppNav` props（tab/actions/confirmLeave）在 Task 1 定义并在 Task 2–8 以相同签名使用；`AppNav` 为 default export，测试与各页面一致引用 `./AppNav` / `../components/AppNav`。
