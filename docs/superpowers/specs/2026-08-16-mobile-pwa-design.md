# 手机端 App（移动端 Web/PWA）— 设计规格

**Date:** 2026-08-16  
**Status:** Draft for user review  
**Parent:** V1–V3（main HEAD）  
**Approach:** 现有 React 前端响应式适配 + PWA 化，复用同一后端与登录态，数据天然互通

---

## 1. Goal

让同一套 Web 应用在手机上可用：面试（文字 + 语音作答）与历史面试记录查看为主要场景，手机端与桌面端**同一账号、同一数据**。无后端改动。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 技术栈 | 移动端 Web / PWA（非 React Native / Flutter） |
| 前端形态 | **现有前端响应式 + PWA**（非独立移动前端） |
| 面试功能 | 文字 + 语音作答完整支持（复用现有 WS / ASR / TTS） |
| 数据互通 | 同一后端、同一 JWT、同一 DB；零后端改动 |
| 手机端范围 | 全功能（面试/历史/题库/成长），重点优化面试与历史 |
| 执行顺序 | 先 V3 针对性出题，后本功能 |

---

## 3. Non-goals

- 后端 API 改动（若实现中发现必改项，单独提 spec）
- 原生推送通知 / 原生能力（仅 Web 能力）
- 独立移动前端应用（只维护一套前端）
- 离线完整面试（仅应用壳离线可打开；面试需联网）

---

## 4. 响应式适配（移动断点 <600px）

| 区域 | 适配 |
|------|------|
| 顶栏导航 | 折叠为汉堡菜单（抽屉）或底部标签栏；链接目标 ≥44px 触控区 |
| 面试列表 / 题库 / 成长页 | 全宽卡片布局；筛选行换行 |
| 面试房间 | 问答区占满宽度；「按住说话」按钮加大；发送/结束按钮触控目标 ≥44px |
| 表单（新建面试） | 全宽输入；文件上传行适配 |
| 表格/评分卡 | 汇总卡单列堆叠 |

现有 CSS 使用 design tokens（`--space-*`、`--color-*`），适配基于 token 保持一致。

---

## 5. PWA 化

- `manifest.json`：应用名「模拟面试助手」、图标（192/512）、`display: standalone`、主题色
- Service Worker：`vite-plugin-pwa` 或手写 SW，预缓存应用壳（index.html + JS/CSS），离线可打开
- 移动端浏览器访问 → 提示「添加到主屏幕」
- HTTPS 或 localhost 下 SW 可用（本地开发 localhost 正常）

---

## 6. Acceptance

| ID | Expectation |
|----|-------------|
| M1 | 375×667 视口下：列表/新建/面试房间/历史详情/题库/成长页均可正常操作，无横向溢出 |
| M2 | 语音面试在手机端可用：TTS 播报、按住说话→ASR→自动发送（需真实手机/模拟器验证） |
| M3 | PWA：manifest 生效、应用可安装、SW 缓存应用壳、离线可打开应用壳 |
| M4 | 手机端与桌面端同账号数据一致（登录态互通、记录互通） |
| M5 | 桌面端体验不回归（`npm run build` + 桌面视口冒烟） |

---

## 7. Implementation notes

- 改造现有 `frontend/`，不新建前端目录
- 移动断点用 CSS media query，配合现有 token
- PWA 依赖：`vite-plugin-pwa`（或最小手写 SW），public 下加 `manifest.webmanifest` + 图标
- 语音：`voiceRecorder.ts` 已是 MediaRecorder + PCM16 转换，移动端浏览器（Chrome/Edge Android、iOS Safari 15+）应兼容；iOS 需真机验证 `getUserMedia` 与 `audio/webm` 回退（`voiceRecorder.ts` 已含 `audio/mp4` 回退，iOS 可用）
- 测试：前端 build + 移动视口浏览器验证（Playwright 375×667）；真机语音验证需人工
- Prefer branch `feat/v4-mobile-pwa` from main HEAD（V3 合并后）

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（PWA、响应式、全功能、零后端改动、先 V3）
- [x] 范围聚焦单实施计划；Non-goals 明确（无原生能力、无独立前端）
- [x] 验收明确（M1–M5）；语音 iOS 兼容性显式标注需真机验证
