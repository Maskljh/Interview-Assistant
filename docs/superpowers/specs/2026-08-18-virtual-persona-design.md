# V12 数字虚拟人讲话 — 设计规格

**Date:** 2026-08-18  
**Status:** Implemented on feat/v12-virtual-persona
**Parent:** 全功能（V1–V11）之上的体验增强  
**Approach:** 面试房间语音模式下显示 2D 虚拟面试官形象，TTS 播报时用 Web Audio 音量驱动嘴型动画

---

## 1. Goal

让面试练习更有「面对面」的真实感：语音面试时，房间顶部出现一个 2D 虚拟面试官形象，它读题目时嘴巴随语音音量开合、平时有呼吸/眨眼动画、等待回答时安静。纯前端实现，离线可用，Android App（WebView）兼容。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 形态 | **2D 动画形象**（SVG 内置 + CSS/JS 动画），非 Live2D、非云端数字人 |
| 集成位置 | **面试房间**（语音模式下房间顶部显示）；报告页等暂不接入 |
| 素材 | **内置默认 SVG 形象** + **可换头像**（本地 localStorage，替换脸部，身体/嘴型保留） |
| 嘴型同步 | **Web Audio 音量驱动**：`AnalyserNode.getByteFrequencyData` 实时音量 → 嘴部开合幅度 |
| 动画状态 | `idle`（呼吸+眨眼）/ `speaking`（嘴型+点头）/ `listening`（思考等待） |
| 显示条件 | 仅语音模式（`effectiveInputMode === 'voice'`）显示；文字模式不显示（避免干扰阅读） |
| 音频播放 | `voicePlayer` 改 Web Audio 播放（保留静音/重播/跳过行为一致） |
| 后端 | **零后端改动**；头像仅存本地 |
| 分支 | `feat/v12-virtual-persona` from main HEAD |

---

## 3. Non-goals (V12)

- Live2D / 云端数字人 API（形态已锁定 2D）
- 报告页讲解员形象、独立虚拟人页面
- 头像上传到后端 / 多设备同步
- 真实口型（音素级唇形同步）——只做音量驱动的嘴部开合
- 录音中用户侧的形象动画（聚焦面试官）

---

## 4. 音频改造：`frontend/src/lib/voicePlayer.ts`

现有 `createVoicePlayer` 用 `HTMLAudioElement`，无法取音频数据。改造：

- 新增返回接口：

```ts
export interface VoicePlayer {
  play(blob: Blob): Promise<void>;
  stop(): void;
  getLevel(): number; // 0..1，当前音量水平（播放中实时，停止后 0）
}
```

- 实现：`AudioContext` + `MediaElementAudioSourceNode` + `AnalyserNode`（`fftSize=512`）；`play` 时连接并 `requestAnimationFrame` 更新内部 `level`；`stop` 时 `context.suspend()`/关闭并复位 level 为 0
- 保持语义：`play` 替换旧播放、`onended` resolve、`stop` 立即停；静音/重播/跳过调用方不变（`stop()` 需正确处理 AudioContext 生命周期，避免泄漏）
- 兼容性：Web Audio 桌面浏览器与 Android WebView（Capacitor）均支持；iOS Safari 需用户手势后创建 AudioContext（`play` 由点击触发，满足）

---

## 5. 虚拟人组件：`frontend/src/components/VirtualPersona.tsx`

**Props：**

```ts
interface VirtualPersonaProps {
  state: 'idle' | 'speaking' | 'listening';
  level?: number; // 0..1，speaking 时驱动嘴型
  avatarUrl?: string | null; // 用户头像（可选，替换默认脸）
}
```

**结构（SVG）：**
- 默认形象：半身面试官（圆形头部 + 身体 + 领口），嘴部为独立可动元素（`<ellipse>`/`<path>`，按 `level` 缩放高度）
- 可换头像：`avatarUrl` 存在时，用 `<image>`/背景图替换头部脸部区域（圆形裁切），嘴部元素仍叠在上方

**动画（CSS + JS）：**
- `idle`：头部/身体 `transform: translateY` 呼吸（2.5s 缓动）+ 眼睛眨眼（定时 `scaleY` 动画）
- `speaking`：嘴部 `scaleY = 0.2 + level * 0.8`（`requestAnimationFrame` 驱动，直接改 SVG 属性），身体轻微点头
- `listening`：静止（或轻微等待动画），嘴闭合
- 组件内部 `requestAnimationFrame` 循环仅在挂载时启动；卸载清理

**头像存储：** `localStorage` key `virtual_persona_avatar`（base64 data URL，≤ 300KB 校验）；组件提供 `avatarUrl` prop 由父组件传入

---

## 6. 房间页接入：`frontend/src/pages/InterviewRoomPage.tsx`

- 语音模式（`effectiveInputMode === 'voice'`）时，房间头部（`interview-room-header` 附近）渲染 `<VirtualPersona>`，尺寸约 120–160px
- 状态映射：
  - `playQuestion` 播放中（`reading === true`）→ `state="speaking"` + `level={voicePlayerRef.current?.getLevel() ?? 0}`（rAF 循环读取）
  - `thinking` → `state="listening"`
  - 其余 → `state="idle"`
- 播放结束 / `stop()` 后 → 回到 `idle`（`reading` 已由现有逻辑复位）
- 头像读取：挂载时 `localStorage.getItem('virtual_persona_avatar')`，传入组件；提供「更换头像」入口（文件选择 → 压缩校验 → 存 localStorage → 刷新显示）
- 文字模式不渲染组件

---

## 7. CSS（`InterviewPages.css`）

- `.virtual-persona` 容器（尺寸、圆形容器、投影）
- 呼吸/眨眼关键帧动画
- 头像裁切（`border-radius: 50%` + `object-fit: cover`）
- 嘴型由 JS 直接改 SVG 属性（不依赖 CSS）

---

## 8. 测试与验收

| ID | Expectation |
|----|-------------|
| V1 | TTS 播报时嘴型随音量开合（桌面浏览器手工冒烟：播放音量变化 → 嘴缩放变化） |
| V2 | 静音 / 重播 / 跳过 / 播放结束 → 动画正确回到 idle，无残留 |
| V3 | 思考中（thinking）→ listening 动画；文字模式不显示虚拟人 |
| V4 | 可换头像：上传 → 本地生效 → 刷新后仍在；超限/非图片拒绝 |
| V5 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过（前端为主） |
| V6 | Android WebView（Capacitor APK）语音播报时动画正常（可选：模拟器/真机冒烟） |

---

## 9. Implementation notes

- 涉及文件：`frontend/src/lib/voicePlayer.ts`（改造）、`frontend/src/components/VirtualPersona.tsx`（新建）、`frontend/src/pages/InterviewRoomPage.tsx`（接入）、`frontend/src/pages/InterviewPages.css`（样式）
- 头像上传入口放房间页虚拟人区域（小图标按钮）
- 无后端、无迁移、无新依赖
- Prefer branch `feat/v12-virtual-persona` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（2D 形象、房间接入、内置+可换头像、音量驱动、三态动画、仅语音模式、零后端）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除 Live2D/云端/报告页/音素口型
- [x] AudioContext 生命周期、头像存储上限、动画状态映射显式
