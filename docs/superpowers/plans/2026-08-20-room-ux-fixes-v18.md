# V18 面试房间 UX 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复面试房间 UX 第一批问题：断线答案队列补发、结束面试确认、错误中文化 + 404/错误页 + 请求超时。

**Architecture:** 全部前端改动。核心是 `client.ts` 的错误映射（`toUserMessage` 纯函数 + `ApiError.rawMessage`），页面零改动获得中文错误；断线队列在 `InterviewRoomPage` 用 `pendingAnswersRef` 实现，以 `session_started` 消息为补发触发点；`sendAnswer` 改为返回 boolean 让调用方感知发送结果。

**Tech Stack:** React 19 + TypeScript (vite 8) + vitest (新引入) + Playwright（验证用）

## Global Constraints

- **零后端改动、零数据库迁移**
- 所有用户可见文案为中文；`ApiError.message` 中文化，`rawMessage` 保留原文
- 不重构现有大文件结构（`InterviewRoomPage.tsx` 1069 行保持现状，仅增量修改）
- 每个任务结束时 `npm run build`（`tsc -b && vite build`）必须通过
- 分支：main（当前工作区）
- 提交信息遵循仓库习惯：`feat(room): ...` / `fix(room): ...` / `test(...): ...`

---

### Task 1: vitest 脚手架 + `toUserMessage` 失败测试

**Files:**
- Modify: `frontend/package.json`（devDependencies + scripts）
- Create: `frontend/vitest.config.ts`
- Create: `frontend/src/api/client.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `toUserMessage(status: number, raw: string): string`（Task 2 实现，本任务只写测试）；`npm test` 脚本

- [ ] **Step 1: 安装 vitest 与 jsdom**

Run: `cd frontend && npm install -D vitest jsdom`
Expected: package.json devDependencies 出现 `vitest`、`jsdom`

- [ ] **Step 2: package.json 加 test 脚本**

在 `frontend/package.json` 的 `"scripts"` 中加一行：

```json
"test": "vitest run",
```

- [ ] **Step 3: 创建 vitest.config.ts**

`frontend/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
```

> 说明：environment 必须是 jsdom —— `client.ts` 顶层执行 `window.location.protocol`（构造 `API_BASE`），node 环境会 ReferenceError。

- [ ] **Step 4: 写失败的测试**

`frontend/src/api/client.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';

// client.ts 顶层引用 window.location / localStorage / import.meta.env，
// 测试里只关心 toUserMessage 纯函数；Capacitor 在 jsdom 下按非原生平台处理。
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));

import { toUserMessage } from './client';

describe('toUserMessage', () => {
  it('maps known backend error strings to Chinese', () => {
    expect(toUserMessage(400, 'invalid credentials')).toBe('邮箱或密码错误');
    expect(toUserMessage(400, 'email already registered')).toBe('该邮箱已注册');
    expect(toUserMessage(502, 'question generation failed')).toBe(
      '题目生成失败，请检查服务器 AI 配置后重试',
    );
    expect(toUserMessage(404, 'not found')).toBe('未找到相关内容');
    expect(toUserMessage(409, 'report not available')).toBe('报告尚未生成');
    expect(toUserMessage(503, 'speech service unavailable')).toBe('语音服务暂不可用');
  });

  it('falls back to status-based Chinese messages', () => {
    expect(toUserMessage(401, 'anything')).toBe('登录已过期，请重新登录');
    expect(toUserMessage(403, 'anything')).toBe('没有权限执行此操作');
    expect(toUserMessage(500, 'anything')).toBe('服务器开小差了，请稍后重试');
    expect(toUserMessage(0, '')).toBe('网络异常或请求超时，请检查连接后重试');
  });

  it('keeps the original message when nothing matches', () => {
    expect(toUserMessage(422, 'weird custom error')).toBe('weird custom error');
  });
});
```

- [ ] **Step 5: 运行测试确认失败**

Run: `cd frontend && npm test`
Expected: FAIL — `toUserMessage is not defined`（模块不存在该导出，import 报错）

- [ ] **Step 6: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vitest.config.ts frontend/src/api/client.test.ts
git commit -m "test(api): scaffold vitest and failing toUserMessage tests"
```

---

### Task 2: 实现错误映射 + ApiError 扩展 + JSON 容错 + 请求超时

**Files:**
- Modify: `frontend/src/api/client.ts`（全部改动在此文件）

**Interfaces:**
- Consumes: Task 1 的测试契约 `toUserMessage(status, raw)`
- Produces: `toUserMessage` 实现；`ApiError` 增加 `rawMessage: string` 字段；`fetchJSON` 20s 超时；错误体 JSON.parse 容错

- [ ] **Step 1: 写失败测试的补充用例（可选）**

本步骤可跳过（Task 1 测试已覆盖映射）；如要测超时行为需 mock fetch，本计划不做（手动验证见 Task 2 Step 4）。

- [ ] **Step 2: 实现 toUserMessage 与 ApiError 改造**

在 `frontend/src/api/client.ts` 中：

1. 在 `ApiError` 类定义处改造：

```ts
export class ApiError extends Error {
  status: number;
  rawMessage: string;

  constructor(status: number, message: string, rawMessage?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.rawMessage = rawMessage ?? message;
  }
}
```

2. 在文件内新增导出纯函数（放在 `ApiError` 之后）：

```ts
const MESSAGE_MAP: Record<string, string> = {
  'invalid credentials': '邮箱或密码错误',
  'email already registered': '该邮箱已注册',
  'invalid email': '邮箱格式不正确',
  'password must be at least 8 characters': '密码至少需要 8 位',
  'question generation failed': '题目生成失败，请检查服务器 AI 配置后重试',
  'not found': '未找到相关内容',
  'report not available': '报告尚未生成',
  'speech service unavailable': '语音服务暂不可用',
  'digital human service unavailable': '数字人服务暂不可用',
};

const STATUS_MESSAGES: Record<number, string> = {
  401: '登录已过期，请重新登录',
  403: '没有权限执行此操作',
  404: '未找到相关内容',
  429: '操作过于频繁，请稍后再试',
  500: '服务器开小差了，请稍后重试',
  502: '服务器开小差了，请稍后重试',
  503: '服务器开小差了，请稍后重试',
  0: '网络异常或请求超时，请检查连接后重试',
};

export function toUserMessage(status: number, raw: string): string {
  const key = raw.trim().toLowerCase();
  if (MESSAGE_MAP[key]) return MESSAGE_MAP[key];
  if (STATUS_MESSAGES[status]) return STATUS_MESSAGES[status];
  return raw;
}
```

3. 修改 `fetchJSON`：

- 在函数开头创建 AbortController 与 20s 定时器（放在 `headers` 构造之前）：

```ts
const controller = new AbortController();
const timeoutId = window.setTimeout(() => controller.abort(), 20000);
```

- `fetch` 调用带上 signal，并处理超时：

```ts
let res: Response;
try {
  res = await fetch(`${API_BASE}${path}`, { ...fetchOpts, headers, signal: controller.signal });
} catch (err) {
  if (err instanceof DOMException && err.name === 'AbortError') {
    throw new ApiError(0, '请求超时，请检查网络后重试', 'request timeout');
  }
  throw new ApiError(0, '网络异常或请求超时，请检查连接后重试', String(err));
} finally {
  window.clearTimeout(timeoutId);
}
```

- 401 分支的 `JSON.parse` 包 try/catch（两处：401 分支与通用分支），解析失败按 `data = null`：

```ts
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
```

401 分支改为：

```ts
if (res.status === 401) {
  setToken(null);
  localStorage.removeItem(USER_KEY);
  const data = parseBody(await res.text());
  const rawMessage =
    data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : 'Unauthorized';
  if (
    !skipAuthRedirect &&
    !window.location.pathname.startsWith('/login') &&
    !window.location.pathname.startsWith('/register')
  ) {
    window.location.href = '/login';
  }
  throw new ApiError(401, toUserMessage(401, rawMessage), rawMessage);
}
```

通用错误分支改为：

```ts
const text = await res.text();
const data = parseBody(text);

if (!res.ok) {
  const rawMessage =
    data && typeof data === 'object' && 'error' in data
      ? String((data as { error: unknown }).error)
      : res.statusText || 'Request failed';
  throw new ApiError(res.status, toUserMessage(res.status, rawMessage), rawMessage);
}
```

> 注意：`rawMessage` 需先赋值再 `throw`；`console.warn` 记录 `rawMessage` 便于排查：`console.warn('[api]', res.status, rawMessage);`（放在 throw 前）。

- [ ] **Step 3: 运行测试确认通过**

Run: `cd frontend && npm test`
Expected: PASS（3 个用例全绿）

- [ ] **Step 4: 类型检查 + 手动验证**

Run: `cd frontend && npm run build`
Expected: 构建通过（`tsc -b` 无类型错误）

手动验证（可选，浏览器打开 `http://127.0.0.1:5174/login` 输入错误密码）：
Expected: 页面显示「邮箱或密码错误」而非 `invalid credentials`

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat(api): Chinese error messages, ApiError.rawMessage, 20s fetch timeout, JSON body fallback"
```

---

### Task 3: 断线答案队列补发

**Files:**
- Modify: `frontend/src/ws/interviewSocket.ts:50-61`（sendAnswer 返回 boolean）
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`（队列 state/ref、submitAnswer 入队、session_started 补发、提示条渲染、cleanup）
- Modify: `frontend/src/pages/InterviewPages.css`（pending 提示条样式）

**Interfaces:**
- Consumes: Task 2 的 `ApiError`（房间页现有用法不变）
- Produces: `sendAnswer(): boolean`；房间页 `pendingCount` 状态与提示条（无外部消费方）

- [ ] **Step 1: sendAnswer 返回 boolean**

`frontend/src/ws/interviewSocket.ts`，把返回值对象里的 `sendAnswer` 改为：

```ts
sendAnswer(content: string, voiceDurationMs?: number): boolean {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify(
        voiceDurationMs
          ? { type: 'answer', content, voice_duration_ms: voiceDurationMs }
          : { type: 'answer', content },
      ),
    );
    return true;
  }
  return false;
},
```

`connectInterviewWS` 的返回类型签名同步改为：

```ts
): { sendAnswer(content: string, voiceDurationMs?: number): boolean; close(): void } {
```

- [ ] **Step 2: 房间页加入队逻辑**

`frontend/src/pages/InterviewRoomPage.tsx`：

1. state 区（约 line 81-104 的 ref 群附近）新增：

```ts
const [pendingCount, setPendingCount] = useState(0);
const pendingAnswersRef = useRef<{ content: string; voiceDurationMs?: number }[]>([]);
```

2. `submitAnswer`（约 line 111-118）改为：

```ts
const submitAnswer = useCallback(
  (content: string, voiceDurationMs?: number) => {
    appendTurn('candidate', content);
    setAnswer('');
    const sent = socketRef.current?.sendAnswer(content, voiceDurationMs) ?? false;
    if (!sent) {
      pendingAnswersRef.current.push({ content, voiceDurationMs });
      setPendingCount(pendingAnswersRef.current.length);
    }
  },
  [appendTurn],
);
```

- [ ] **Step 3: session_started 时补发队列**

`onMessage` 的 `session_started` 分支（约 line 387-390）改为：

```ts
if (msg.type === 'session_started') {
  attemptRef.current = 0; // 重连成功，重置退避
  const queue = pendingAnswersRef.current;
  if (queue.length > 0) {
    pendingAnswersRef.current = [];
    for (const item of queue) {
      socketRef.current?.sendAnswer(item.content, item.voiceDurationMs);
    }
    setPendingCount(0);
    setStatusLine('连接已恢复，暂存回答已发送');
  }
}
```

- [ ] **Step 4: 渲染提示条**

在 `{statusLine && <p className="interview-room-status">{statusLine}</p>}`（约 line 844）之前插入：

```tsx
{pendingCount > 0 && (
  <p className="interview-room-status interview-room-pending">
    未连接，回答已暂存（{pendingCount} 条），重连后自动发送
  </p>
)}
```

`frontend/src/pages/InterviewPages.css` 末尾新增：

```css
/* V18: 断线暂存回答提示 */
.interview-room-pending {
  color: var(--color-warning);
  font-weight: 500;
}
```

> `--color-warning: #f5a623` 已定义于 `styles/tokens.css:20`。

- [ ] **Step 5: 卸载时清空队列**

useEffect cleanup（约 line 496-524）中、`socketRef.current = null;` 之后加：

```ts
pendingAnswersRef.current = [];
setPendingCount(0);
```

- [ ] **Step 6: 构建 + 手动验证（Playwright 离线模拟）**

Run: `cd frontend && npm run build`
Expected: 构建通过

手动验证（Playwright 脚本，见 Task 3 验证说明）：登录 → 创建/进入房间 → DevTools 切 offline → 输入答案点发送 → 断言出现「未连接，回答已暂存（1 条）」→ 恢复 online → 断言提示消失、状态行出现「连接已恢复，暂存回答已发送」、转录区出现面试官新回复。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/ws/interviewSocket.ts frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(room): queue answers during disconnect and auto-flush on reconnect"
```

---

### Task 4: 结束面试确认

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`（handleForceEnd）

**Interfaces:**
- Consumes: 无
- Produces: 手动结束面试前的原生确认弹窗

- [ ] **Step 1: handleForceEnd 加确认**

`handleForceEnd`（约 line 714）在 `if (ending || doneRef.current) return;` 之后加一行：

```ts
if (!window.confirm('确定结束面试吗？结束后将生成评分报告，且无法继续回答。')) return;
```

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建通过；手动点击「结束面试」出现确认框，取消无副作用，确认后走原结束流程

- [ ] **Step 3: Commit**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx
git commit -m "feat(room): confirm before force-ending an interview"
```

---

### Task 5: 404 页面与路由

**Files:**
- Create: `frontend/src/pages/NotFoundPage.tsx`
- Modify: `frontend/src/App.tsx:77`（`*` 路由）

**Interfaces:**
- Consumes: 无
- Produces: `<NotFoundPage />` 组件；`/` 之外的未知路由渲染 404 页

- [ ] **Step 1: 创建 NotFoundPage**

`frontend/src/pages/NotFoundPage.tsx`：

```tsx
import { Link } from 'react-router-dom';
import { APP_NAME } from '../lib/labels';
import './InterviewPages.css';

export default function NotFoundPage() {
  return (
    <div className="interview-page">
      <header className="interview-header">
        <Link className="interview-brand" to="/">
          {APP_NAME}
        </Link>
      </header>
      <main className="interview-main">
        <h1>页面不存在</h1>
        <p className="interview-subtitle">
          你访问的页面不存在或已被删除。
        </p>
        <div className="interview-list-links">
          <Link className="interview-inline-link" to="/">
            返回面试列表
          </Link>
          <Link className="interview-inline-link" to="/login">
            回到登录页
          </Link>
        </div>
      </main>
    </div>
  );
}
```

> 先确认 `frontend/src/lib/labels.ts` 导出 `APP_NAME`（房间页已 import 使用，存在）。

- [ ] **Step 2: App.tsx 替换 `*` 路由**

`frontend/src/App.tsx`：

1. import 区加 `import NotFoundPage from './pages/NotFoundPage';`
2. 末尾路由（line 77）从：

```tsx
<Route path="*" element={<Navigate to="/" replace />} />
```

改为：

```tsx
<Route path="*" element={<NotFoundPage />} />
```

3. 若 `Navigate` 不再被使用，移除其 import（`import { BrowserRouter, Navigate, Route, Routes }` → 去掉 `Navigate`），否则 tsc 的 `noUnusedLocals` 会报错。

- [ ] **Step 3: 构建验证**

Run: `cd frontend && npm run build`
Expected: 构建通过；浏览器访问 `http://127.0.0.1:5174/xyz` 显示 404 页

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/NotFoundPage.tsx frontend/src/App.tsx
git commit -m "feat(app): dedicated 404 page for unknown routes"
```

---

### Task 6: 房间页与报告页错误态

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`（转录区错误态，约 line 843-848）
- Modify: `frontend/src/pages/ReportPage.tsx`（错误分支，约 line 210-211）
- Modify: `frontend/src/pages/InterviewPages.css`（`.interview-room-error` 样式）

**Interfaces:**
- Consumes: Task 2 的中文 `ApiError.message`
- Produces: 加载失败时「重新加载」+「返回列表」入口

- [ ] **Step 1: 房间页转录区错误态**

`InterviewRoomPage.tsx` line 845-848 区域，把：

```tsx
<div className="interview-transcript interview-room-transcript">
  {turns.length === 0 ? (
    <p className="interview-loading">正在连接面试间…</p>
  ) : (
```

改为：

```tsx
<div className="interview-transcript interview-room-transcript">
  {turns.length === 0 ? (
    error && !loadingInterview ? (
      <div className="interview-room-error">
        <p className="interview-error">{error}</p>
        <button
          type="button"
          className="interview-submit"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
        <Link className="interview-inline-link" to="/">
          返回列表
        </Link>
      </div>
    ) : (
      <p className="interview-loading">正在连接面试间…</p>
    )
  ) : (
```

> 说明：`error` 在运行中也可能非空（如结束失败），此时 `turns.length > 0`，不会触发该分支；只有"加载失败且无任何对话"才显示错误态。`window.location.reload()` 完整重跑 `loadAndConnect`（简单可靠）。

- [ ] **Step 2: 报告页错误分支加返回链接**

`ReportPage.tsx` line 210-211，把：

```tsx
) : error && !feedback ? (
  <p className="interview-error">{error}</p>
) : available === false ? (
```

改为：

```tsx
) : error && !feedback ? (
  <div className="interview-stub">
    <p className="interview-error">{error}</p>
    <Link className="interview-inline-link" to="/">
      ← 返回列表
    </Link>
  </div>
) : available === false ? (
```

> `ReportPage.tsx` 已 import `Link`（line 2），无需新增。

- [ ] **Step 3: 错误态样式**

`frontend/src/pages/InterviewPages.css` 末尾新增：

```css
/* V18: 房间加载失败错误态 */
.interview-room-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-md);
  padding: var(--space-xl) 0;
}
```

> `--space-md: 16px`、`--space-xl: 32px` 已定义于 `styles/tokens.css:73,75`。

- [ ] **Step 4: 构建 + 手动验证**

Run: `cd frontend && npm run build`
Expected: 构建通过

手动验证：
- 访问不存在的面试房间 `http://127.0.0.1:5174/interviews/999999/room` → 显示中文「未找到相关内容」+「重新加载」+「返回列表」，且不再显示「正在连接面试间…」
- 访问不存在的面试详情 `http://127.0.0.1:5174/interviews/999999` → 中文错误 + 既有「← 全部面试」返回链接（详情页无需代码改动，验证 Task 2 的中文映射生效即可）

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/ReportPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(room): error state with reload/back actions on load failure"
```

---

### Task 7: 全量回归验证

**Files:**
- 无代码改动

- [ ] **Step 1: 运行全部测试与构建**

Run: `cd frontend && npm test && npm run build`
Expected: 测试全绿、构建通过

- [ ] **Step 2: Playwright 回归冒烟（可选但推荐）**

复用 `.playwright-cli/ux_probe4.py` 流程（登录 → 创建 → 开始 → 房间 → 报告）跑一遍，确认：
- 创建面试成功进入房间（若后端 AI 未配置则看到中文错误提示而非英文）
- 房间页正常渲染（无 console error）
- 手动结束弹确认框

- [ ] **Step 3: 最终提交（如 Step 1/2 有修复则追加 commit）**

```bash
git add -A
git commit -m "fix(room): regression fixes from V18 verification"
```

---

## 验证说明（Task 3 的 Playwright 离线模拟）

在 `.playwright-cli/` 下编写一次性脚本 `ux_offline_test.py`：

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto("http://127.0.0.1:5174/login")
    page.wait_for_load_state("networkidle")
    page.locator("#email").fill("ux574349@test.com")
    page.locator("#password").fill("password123")
    page.locator("button").first.click()
    page.wait_for_timeout(2500)
    # 进入最近一场 in_progress 面试的房间（列表页第一个「进入面试」链接）
    page.goto("http://127.0.0.1:5174/")
    page.wait_for_load_state("networkidle")
    cont = page.locator("a", has_text="进入面试").first
    cont.click()
    page.wait_for_timeout(4000)
    # 断线
    ctx = page.context
    ctx.set_offline(True)
    page.wait_for_timeout(1500)
    # 发送答案（发送按钮文案为「发送回答」）
    page.locator("textarea").first.fill("断线测试答案")
    page.locator("button", has_text="发送回答").click()
    page.wait_for_timeout(800)
    # 断言提示条
    assert "已暂存" in page.locator("body").inner_text(), "pending hint missing"
    # 恢复
    ctx.set_offline(False)
    page.wait_for_timeout(6000)
    # 断言提示消失 / 恢复提示出现
    body = page.locator("body").inner_text()
    assert "已暂存" not in body
    print("OFFLINE QUEUE TEST PASSED")
    browser.close()
```

Run: `cd "C:\Users\l\Desktop\Interview Assistant" && python .playwright-cli\ux_offline_test.py`
Expected: 输出 `OFFLINE QUEUE TEST PASSED`
