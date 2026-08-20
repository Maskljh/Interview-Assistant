# V18 面试房间 UX 修复（第一批）— 设计规格

**Date:** 2026-08-20
**Status:** Design approved (in-session)
**Parent:** 全站 UX 审计（动态实测 + 代码审计）后的修复批次
**Approach:** 全部前端改动，零后端 API 改动、零迁移；先测试（vitest）后实现

---

## 1. Goal

修复 UX 审计中确认的最优先问题（第一批 1+2+3 组）：

1. **断线时答案被静默丢弃**（H1）— `sendAnswer` 在 socket 非 OPEN 时 no-op，但 UI 照常可用、答案照常上屏，面试官永远收不到
2. **"结束面试"无确认**（H2）— 一次误触永久结束一场进行中的面试，无撤销
3. **错误信息中文化 + 404/错误页 + 请求超时**（H3 组）—
   - 全中文界面冒出英文错误（`invalid credentials`、`question generation failed`、`not found`），且无任何"该怎么办"指引
   - 访问不存在的资源只有一行英文，无 h1、无返回入口
   - 所有 fetch 无超时，网络挂起时页面永远"加载中…"
4. **附带**：房间加载失败时不再显示误导的"正在连接面试间…"，提供"重新加载"（错误页范畴，同一批做）

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 断线答案保护 | **队列缓冲 + 状态提示**：断线时输入照常可用，发送失败自动入队，界面提示"未连接，回答已暂存（N 条）"，重连成功（`session_started`）自动补发 |
| 结束确认 | **原生 `window.confirm`**：手动点击"结束面试"时确认；自动结束（`done` 消息）不走确认 |
| 错误中文化方式 | **`ApiError.message` 构造时映射**：`client.ts` 新增纯函数 `toUserMessage(status, raw)`，`message` 存中文、新增 `rawMessage` 字段留原文；页面零改动 |
| 404 路由 | 新增 `NotFoundPage`，`App.tsx` 的 `*` 路由从 `Navigate to /` 改为渲染 404 页 |
| 错误页形态 | 详情/房间/报告页错误态：中文错误 + "返回列表"链接；房间页错误时给"重新加载"按钮 |
| 请求超时 | `fetchJSON` 加 `AbortController`，默认 **20s**（LLM 生成问题较慢），超时抛"请求超时，请检查网络后重试" |
| JSON 容错 | 顺手修 `JSON.parse` 对非 JSON 错误体抛 `SyntaxError` 的问题 |
| 测试 | 引入 vitest（最小配置）；先测 `toUserMessage`（红→绿） |
| 后端改动 | **零后端改动** |
| 分支 | main（本次会话内直接实施） |

---

## 3. Non-goals（本批不做）

- 401 会话过期无提示硬跳转 /login（清单第 4 项，下批）
- 直播模式静音/跳过按钮接线、IVH SDK 加载失败白屏降级（中危，下批）
- 题库搜索防抖与空状态文案、趋势图日期轴、对比度、分页标题（中危，下批）
- 录音电平表/计时、简历上传大小限制、请求级重试（低危）
- 后端并发面试限制、评分异步化（功能级，另立项）

---

## 4. 修复 1：断线答案队列（`interviewSocket.ts` + `InterviewRoomPage.tsx`）

### 现状
- `ws/interviewSocket.ts:51-60`：`sendAnswer` 在 `ws.readyState !== OPEN` 时静默 return，无任何反馈
- `pages/InterviewRoomPage.tsx:111-118`：`submitAnswer` 先 `appendTurn`（答案上屏）再调 `sendAnswer`，无发送结果感知
- 重连逻辑在房间页（`connectWithRetry`），重连成功标志 = 服务端 `session_started` 消息（`InterviewRoomPage.tsx:387-390`）

### 改造
1. `interviewSocket.ts`：`sendAnswer` 返回值改为 `boolean` — `OPEN` 时发送并 `return true`，否则 `return false`
2. `InterviewRoomPage.tsx`：
   - 新增 `pendingAnswersRef = useRef<{ content: string; voiceDurationMs?: number }[]>([])`、`pendingCount` state
   - `submitAnswer`：本地显示逻辑不变；`sendAnswer(...) === false`（或 socket 为 null）时入队 `pendingAnswersRef` 并 `setPendingCount(n)`
   - `onMessage` 的 `session_started` 分支：flush 队列（逐个 `sendAnswer`，此时 socket OPEN），清空队列、`setPendingCount(0)`，`setStatusLine('连接已恢复，暂存回答已发送')`
   - 渲染：`pendingCount > 0` 时在作答区上方显示提示条：`未连接，回答已暂存（N 条），重连后自动发送`
   - 语音回答复用 `submitAnswer` 入口，自动覆盖
3. 边界：退出/结束面试时清空队列（`done` 后不再补发；卸载 cleanup 清 `pendingAnswersRef`）

---

## 5. 修复 2：结束面试确认（`InterviewRoomPage.tsx`）

- `handleForceEnd`（约 714-748 行）开头：
  ```ts
  if (!window.confirm('确定结束面试吗？结束后将生成评分报告，且无法继续回答。')) return;
  ```
- 仅拦手动点击；`done` 消息自动结束路径不经过 `handleForceEnd`，无影响

---

## 6. 修复 3：错误中文化 + 404/错误页 + 请求超时

### 6.1 错误映射（`client.ts`）

新增导出纯函数（放 `client.ts` 便于与 ApiError 同文件）：

```ts
export function toUserMessage(status: number, raw: string): string
```

映射表（后端英文原文 → 中文，覆盖实测/审计已知错误）：
| 原始错误 | 中文 |
|---|---|
| `invalid credentials` | 邮箱或密码错误 |
| `email already registered` | 该邮箱已注册 |
| `invalid email` | 邮箱格式不正确 |
| `password must be at least 8 characters` | 密码至少需要 8 位 |
| `question generation failed` | 题目生成失败，请检查服务器 AI 配置后重试 |
| `not found` | 未找到相关内容 |
| `report not available` | 报告尚未生成 |
| `speech service unavailable` | 语音服务暂不可用 |
| `digital human service unavailable` | 数字人服务暂不可用 |

状态码兜底：
| 状态 | 中文 |
|---|---|
| 401 | 登录已过期，请重新登录 |
| 403 | 没有权限执行此操作 |
| 404 | 未找到相关内容 |
| 429 | 操作过于频繁，请稍后再试 |
| 5xx | 服务器开小差了，请稍后重试 |
| 0（网络/超时） | 网络异常或请求超时，请检查连接后重试 |

未命中且无状态码兜底 → 返回原始英文（保真，不瞎翻译）；`console.warn` 记录原始错误便于排查。

`ApiError` 扩展：`rawMessage: string` 字段；构造时 `message = toUserMessage(status, raw)`。所有页面 `err.message` 自动变中文，**零页面改动**。

### 6.2 JSON 容错（`client.ts`）

`res.text()` 后的 `JSON.parse` 包 try/catch：解析失败按 `data = null` 处理（不再抛 `SyntaxError` 绕过 ApiError 分支）。

### 6.3 请求超时（`client.ts`）

`fetchJSON` 内部创建 `AbortController`，20s 后 `abort()`；`AbortError` → 抛 `ApiError(0, '请求超时，请检查网络后重试')`。当前调用方均未传外部 signal，不处理合并。

### 6.4 404 路由页（新增 `pages/NotFoundPage.tsx` + `App.tsx`）

- `App.tsx`：`<Route path="*" element={<NotFoundPage />} />`（替换现在的 `<Navigate to="/" replace />`）
- `NotFoundPage`：沿用 `.interview-page` 布局，h1「页面不存在」，正文「你访问的页面不存在或已被删除。」+ 两个链接：「返回面试列表」（`/`）、「回到登录页」（`/login`，未登录时）

### 6.5 详情/房间/报告页错误态

- `InterviewDetailPage`：错误分支（现约 124-125 行）渲染中文错误（`err.message` 已自动中文）+「← 返回列表」链接
- `InterviewRoomPage`：
  - 加载失败（约 843-848 行）：`error` 非空时**不再显示**"正在连接面试间…"，改为错误 +「重新加载」按钮（重跑 `loadAndConnect`）；保留"返回列表"链接
  - 断线降级提示文案不变（已有中文）
- `ReportPage`：初始加载错误分支（约 210-211 行）加「← 返回列表」链接；「自动刷新中」文案问题（M7）不在本批（属中危清单）

---

## 7. 测试（TDD，vitest）

1. 引入 `vitest`（devDependency），`package.json` 加 `"test": "vitest run"`，新建 `vitest.config.ts`（独立于 vite.config.ts，避免 PWA 插件干扰）
2. 测试文件 `src/api/client.test.ts`，覆盖 `toUserMessage`：
   - 映射命中（`invalid credentials` → 中文）
   - 状态码兜底（401 / 500 / 0）
   - 未命中保留原文
   - （`JSON.parse` 容错由代码审查确认，不单测）
3. 顺序：先写测试（红）→ 实现 `toUserMessage`（绿）→ 其余改动

---

## 8. 验收标准

- [ ] 断线（`devtools` 离线模拟）时发送答案 → 出现"已暂存"提示条；恢复连接 → 自动补发、提示条消失、面试官收到答案
- [ ] 语音回答在断线时同样入队补发
- [ ] 手动"结束面试"弹确认框；取消不结束；自动结束不弹框
- [ ] 登录密码错误 → 显示"邮箱或密码错误"；创建面试 LLM 失败 → 中文提示；访问不存在面试 → 中文 + 返回列表
- [ ] 访问未知路由（如 `/xyz`）→ 404 页
- [ ] 断网请求 → 20s 内出现"请求超时"提示（不无限转圈）
- [ ] `npm test` 通过（`toUserMessage` 全绿）
- [ ] 现有功能回归：创建→开始→房间→结束流程无异常

---

## 9. 风险与注意

- `toUserMessage` 依赖后端错误文案匹配，后端若改文案需同步映射表（映射表集中一处，好维护）
- 20s 超时可能影响极慢网络下的 LLM 请求——超时文案明确提示"请检查网络"，可接受；后续可做重试
- 房间页已较大（1069 行），本次仅增量修改，不做重构
