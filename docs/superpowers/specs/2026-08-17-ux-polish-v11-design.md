# V11 体验打磨（P1/P2 修复批次）— 设计规格

**Date:** 2026-08-17  
**Status:** Implemented on feat/v11-ux-polish
**Parent:** V10 体验修复（P0）之后的 P1/P2 批次  
**Approach:** 7 项前端体验修复，全部在现有页面/组件内完成，无后端 API 改动、无迁移

---

## 1. Goal

修复体验审查中确认的 P1/P2 问题批次：
1. **语音识别失败重录**（P1）— 识别失败后要重新说一遍，已录内容浪费
2. **语音→文字切换**（P1）— 语音模式下缺少显式切换入口（现只有备选输入框）
3. **移动端导航**（P1）— 顶栏链接与底部标签栏重复、拥挤；房间页无「返回」
4. **语音模式提交提示**（P1）— 识别/发送中点发送无反馈
5. **退出登录关闭 WS**（P2）— 退出登录后房间页 WebSocket 仍连接
6. **结束面试进度提示**（P2）— 同步评分等待期无明确文案（不异步化，另议）
7. **报告未就绪自动轮询**（P2）— 报告生成中需手动刷新/重试

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 识别失败重录 | **重试识别按钮**：失败时保留已录音频，显示「重试识别」按钮（重新调 ASR 不重说）+ 保留「重新录音」入口 |
| 语音→文字切换 | **显式切换按钮**：语音模式下显示「切换为文字作答」，本场本地切换（隐藏按住说话），不写库；备选输入框保留 |
| 移动端导航 | 移动端（<600px）**隐藏顶栏导航链接**（品牌 + 退出保留），导航靠底部标签栏；房间页顶栏加「返回列表」 |
| 语音 busy 提交提示 | `voiceBusy`（识别/发送中）提交时显示「正在识别语音，请稍候」状态提示 |
| 退出登录关 WS | 房间页监听登录态：user 变 null → 关闭 WS + 跳转登录页 |
| 结束进度提示 | 结束期间显示状态行「正在生成报告，请稍候…」（评分仍同步，不异步化） |
| 报告自动轮询 | 报告 `available:false` 时每 10s 自动重查；**60s 内**生成完成自动展示；超时切换为「生成失败，请重新生成」文案 + 保留手动重试按钮 |
| 后端改动 | **零后端改动**（全部前端；报告语义：available:false = 分析中或失败，前端轮询超时自行区分） |
| 分支 | `feat/v11-ux-polish` from main HEAD |

---

## 3. Non-goals (V11)

- 评分异步化重构（结束立即返回、后台生成）——单列后续版本
- 移动端底部标签栏重设计（保持既有 MobileTabBar）
- 报告轮询间隔/超时可配置（10s/60s 定值）
- 语音识别的服务端重试/缓存

---

## 4. 修复 1：识别失败重试（`InterviewRoomPage.tsx`）

现状：`handleStopRecording` catch 丢弃 audio blob，仅置「识别失败，请重录」。

改造：
- 新增 state `failedAudioRef = useRef<Blob | null>(null)`（识别失败的音频）；`retryingASR` state 控制按钮态
- 识别失败（catch 或空文本）时：`failedAudioRef.current = audio`（保留），`setVoicePhase('idle')`，状态行「识别失败」+ 显示操作区：
  - 「重试识别」按钮 → `transcribeAudio(failedAudioRef.current)` 重试；成功走 `submitAnswer`，失败再提示
  - 「重新录音」按钮 → 清 failedAudioRef，回 idle（用户重按按住说话）
- 录音期间（新一次 `handleStartRecording`）清 `failedAudioRef`
- 重试成功进入 sending 流程（复用现有 submit 路径）

---

## 5. 修复 2：语音→文字显式切换（`InterviewRoomPage.tsx`）

- 新增 `textModeOverride` state（`boolean`）；实际模式 = `inputMode === 'voice' && !textModeOverride ? 'voice' : 'text'`
- 语音模式下（`inputMode === 'voice'` 且未 override）在按住说话按钮旁显示「切换为文字作答」按钮 → `setTextModeOverride(true)`，提示「已切换为文字作答，本场生效」
- override 后：隐藏按住说话区，textarea 标签恢复「你的回答」，发送走文字路径（`handleSubmit` 的 voice 分支不再触发）
- 不写库（刷新后回语音模式）；`handleForceEnd`/cleanup 不影响 override

---

## 6. 修复 3：移动端导航（`InterviewPages.css` + 页面 JSX）

- **CSS**（<600px media query）：`.interview-header-actions` 隐藏（顶栏导航链接消失）；`.interview-header` 保留品牌与退出按钮（`interview-header-actions` 里的退出也隐藏？——退出登录入口底部标签栏没有，需保留：拆分退出按钮到独立类，移动端只隐藏导航链接类）
  - 实现：给导航链接加 `header-nav-link` 类（题库/成长分析/新建/返回列表/详情），移动端隐藏 `.header-nav-link`；退出按钮（`header-logout` 类）保留
- **房间页**：顶栏加「返回列表」链接（`/`），归入 `header-nav-link` 类（移动端隐藏，因底部标签栏有「面试」）
- 桌面端不变

---

## 7. 修复 4：语音 busy 提交提示（`InterviewRoomPage.tsx`）

- `handleSubmit` 的 voice-busy 早退处：`voiceBusy` 时设 `statusLine('正在识别语音，请稍候')`（仅当 voice 模式且 busy），不再完全静默
- 发送按钮已 `disabled`（voiceBusy），提示是兜底（键盘回车触发时可见）

---

## 8. 修复 5：退出登录关闭 WS（`InterviewRoomPage.tsx`）

- `useAuth()` 已有 `user`；新增 effect：`user === null`（且非初始加载态）→ `socketRef.current?.close()`、清 retry timer、`navigate('/login')`
- 与 V10 的 `mountedRef` 配合（卸载后不重连）
- 登录页已在 fetchJSON 401 跳转路径内，无重复逻辑

---

## 9. 修复 6：结束面试进度提示（`InterviewRoomPage.tsx`）

- `handleForceEnd` 开头：`setStatusLine('正在生成报告，请稍候…')`
- 结束按钮文案「结束中…」保留；`statusLine` 提供明确进度语义
- 无后端改动

---

## 10. 修复 7：报告自动轮询（`ReportPage.tsx`）

- 报告 `available:false` 时启动轮询：`setInterval` 10s 调 `getReport`，成功 `available:true` → 展示 + 清定时器；**60s 超时**（6 次）→ 清定时器，状态切换为「生成失败，请重新生成」
- 文案区分：
  - 轮询中：「报告正在生成中，请稍候…（自动刷新中）」
  - 超时后：「报告生成失败，可点击下方按钮重新生成」+ 保留「重新生成报告」按钮
  - 手动 `handleRetry` 成功/失败沿用现有逻辑；重试成功即停止轮询
- effect 清理清定时器（含卸载）
- `handleRetry` 后若仍 `available:false` → 重启轮询（复用同一启动函数）

---

## 11. Acceptance

| ID | Expectation |
|----|-------------|
| U1 | 识别失败显示「重试识别」+「重新录音」；重试成功直接发送不重说 |
| U2 | 语音模式有「切换为文字作答」按钮；切换后本场按文字交互，刷新恢复语音 |
| U3 | 移动端顶栏仅剩品牌 + 退出；房间页顶栏有「返回列表」；桌面端导航不变 |
| U4 | 语音识别/发送中点发送有「正在识别语音，请稍候」提示 |
| U5 | 退出登录后房间页 WS 关闭并跳登录页，无重连 |
| U6 | 结束面试期间显示「正在生成报告，请稍候…」 |
| U7 | 报告未就绪自动轮询，60s 内就绪自动展示；超时提示失败 + 保留重试 |
| U8 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |

---

## 12. Implementation notes

- 全部改动在前端：`frontend/src/pages/InterviewRoomPage.tsx`（修复 1/2/4/5/6）、`frontend/src/pages/ReportPage.tsx`（修复 7）、`frontend/src/pages/InterviewPages.css` + 各页顶栏 JSX（修复 3）
- 无后端改动、无迁移、无新依赖
- 测试：前端 `npm run build`（零 TS 错误）+ 手工冒烟；后端全量回归确认（前端改动不影响后端，但按惯例跑全量）
- Prefer branch `feat/v11-ux-polish` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（重试按钮/显式切换/移动端隐藏顶栏链接/提交提示/退登关 WS/结束文案/自动轮询+超时）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除评分异步化/标签栏重设计/可配参数
- [x] 轮询语义（10s/60s 定值、超时切换失败态）、本地切换（不写库）显式说明
