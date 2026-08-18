# V13 虚拟人换用静态形象图 — 设计规格

**Date:** 2026-08-18  
**Status:** Draft for user review  
**Parent:** V12 数字虚拟人（SVG 形象）之后的形象替换  
**Approach:** 虚拟面试官改为整张静态图片（用户指定 `wps.png`），图片文件原样零修改，保留整体动画（呼吸/点头/等待），移除嘴型动画

---

## 1. Goal

把 V12 的内置 SVG 虚拟人替换为用户指定的静态形象图。图片**原样使用、不能修改**（不裁剪、不压缩、不改内容）；虚拟人在面试房间语音模式下以整图显示，保留状态标签与轻微整体动画（呼吸浮动/点头/等待），去掉嘴型随音量动画。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 形象来源 | `C:\Users\l\Desktop\wps.png`（1128×912 PNG），**复制进项目原样使用**，零修改 |
| 展示方式 | 整图 `<img>` 显示（`object-fit: contain` 等比适配，不裁剪）；非 SVG 人物绘制 |
| 嘴型动画 | **移除**（图片静态，无嘴型随音量）；`level`/音量轮询一并移除 |
| 整体动画 | **保留**：作用于图片容器的 CSS transform（不碰图片文件）——`idle` 呼吸浮动、`speaking` 点头、`listening` 等待 |
| 状态标签 | 保留（面试官 / 正在提问… / 思考中…） |
| 可换头像 | 保留：用户上传头像后**整图替换**默认形象（localStorage `virtual_persona_avatar`，图片/≤300KB 校验不变） |
| 房间页 | 移除音量轮询 rAF 与 `personaLevel`；`reading→speaking`、`thinking→listening`、其余 `idle` 状态映射保留 |
| 兼容性 | `VoicePlayer.getLevel()` 保留（不删，避免影响其他调用；当前无其他调用方） |
| 分支 | `feat/v13-static-persona` from main HEAD |

---

## 3. Non-goals (V13)

- 图片任何形式的处理（裁剪/压缩/改色/去背景）——原样
- 嘴型/口型动画（图片静态）
- 默认形象的多图选择
- 图片上传到后端（仅本地）

---

## 4. 资源

- 复制 `C:\Users\l\Desktop\wps.png` → `frontend/public/persona-default.png`（**字节级原样**，用 `cp` 复制）
- 图片 ~1MB：作为默认形象资源打进前端 bundle（public 目录原样分发）；对首屏影响可接受（仅语音模式加载）

---

## 5. VirtualPersona 组件改造（`frontend/src/components/VirtualPersona.tsx`）

- Props 保持 `{ state; avatarUrl? }`；**移除 `level` prop**（不再驱动嘴型）
- 移除：SVG 人物绘制、`mouthRef`/`bodyRef`、rAF 嘴型 effect
- 渲染改为：

```tsx
<div className={`virtual-persona virtual-persona--${state}`} aria-label="虚拟面试官">
  <img
    className="virtual-persona-img"
    src={avatarUrl ?? '/persona-default.png'}
    alt="虚拟面试官"
  />
  {state === 'speaking' && <span className="virtual-persona-label">正在提问…</span>}
  {state === 'listening' && <span className="virtual-persona-label">思考中…</span>}
  {state === 'idle' && <span className="virtual-persona-label">面试官</span>}
</div>
```

- 无 `useEffect`/`useRef` 依赖（纯展示 + CSS 动画）

---

## 6. 房间页清理（`frontend/src/pages/InterviewRoomPage.tsx`）

- 移除：`personaLevel` state、`personaLevelRaf` ref、音量轮询 effect（`[personaState]` 那个）
- 保留：`personaState`、状态映射 effect（`[reading, thinking]`）、`avatarUrl` + `handleAvatarChange`（不变）
- 渲染传参：`<VirtualPersona state={personaState} avatarUrl={avatarUrl} />`（去掉 `level`）

---

## 7. CSS（`frontend/src/pages/InterviewPages.css`）

- `.virtual-persona-img`：宽 ~140px，`border-radius: 50%`（圆形显示）+ `object-fit: cover` 或 `contain`——**用 `contain` 整图不裁剪**（等比完整显示，四周留白）；若用户要圆形裁切显示则改 `cover`（显示行为，非图片修改），实施默认 `contain` 圆角容器
- 保留：`.virtual-persona--idle` 呼吸、`--speaking` 点头、`--listening` 等待关键帧（作用于容器/图片 transform）
- 移除：`.virtual-persona-mouth` 相关（无 SVG 嘴）；`.virtual-persona-head`/`.virtual-persona-eye` 相关动画类改为作用于 `.virtual-persona-img`（idle 呼吸/眨眼——**眨眼对静态图不可行，仅保留呼吸与点头/等待**）

---

## 8. 测试与验收

| ID | Expectation |
|----|-------------|
| W1 | 房间语音模式显示 `wps.png` 整图（不裁剪、不改内容），`/persona-default.png` 可访问 |
| W2 | speaking → 图片轻微点头；idle → 呼吸浮动；listening → 等待；无嘴型动画、无音量依赖 |
| W3 | 换头像：上传后整图替换；刷新保留；校验不变 |
| W4 | 文字模式不显示；V10/V11 房间逻辑（重连/语音 refs）无回归 |
| W5 | `npm run build` 通过；`go test ./... -count=1 -p 1` 全绿（回归） |

---

## 9. Implementation notes

- 涉及：`frontend/public/persona-default.png`（复制资源）、`frontend/src/components/VirtualPersona.tsx`（重写）、`frontend/src/pages/InterviewRoomPage.tsx`（清理）、`frontend/src/pages/InterviewPages.css`（样式）
- `VoicePlayer.getLevel()` 保留不删（向后兼容，暂无调用方）
- 图片复制用 `cp`（字节级原样），提交进 git
- Prefer branch `feat/v13-static-persona` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（原样图片、整图显示、移除嘴型、保留整体动画、头像保留、零修改）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除任何图片处理/口型
- [x] 资源来源与复制方式、CSS 显示语义（contain 不裁剪）、getLevel 保留显式
