# V13 虚拟人换用静态形象图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 虚拟面试官从 V12 的 SVG 形象换成用户指定的 `wps.png` 静态图，图片原样零修改，移除嘴型动画，保留整体动画（呼吸/点头/等待）与可换头像。

**Architecture:** `cp` 复制 `wps.png` → `frontend/public/persona-default.png`（字节级原样）；重写 `VirtualPersona.tsx` 为整图 `<img>` + 三态 CSS 动画（无 level/rAF/嘴型）；房间页移除音量轮询，保留状态映射与头像上传；CSS 图片容器样式。纯前端。

**Tech Stack:** React/Vite TS、CSS 动画。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-18-static-persona-design.md`
- 分支 `feat/v13-static-persona` from main HEAD
- 图片 `C:\Users\l\Desktop\wps.png`（1128×912）→ `frontend/public/persona-default.png`，**cp 原样复制、零修改**（不裁剪/压缩/改色）
- `VirtualPersonaProps = { state: 'idle'|'speaking'|'listening'; avatarUrl?: string | null }`（**移除 level**）
- 组件渲染：`<img className="virtual-persona-img" src={avatarUrl ?? '/persona-default.png'} />` + 三态标签；无 useEffect/useRef
- 整体动画（CSS transform 作用于图片容器，不碰文件）：idle 呼吸浮动、speaking 点头、listening 等待；**无嘴型动画**
- 头像：localStorage `virtual_persona_avatar`（image/*、≤300KB），整图替换默认
- 房间页：移除 `personaLevel`/`personaLevelRaf`/音量轮询 effect；保留 `personaState` + `[reading, thinking]` 映射 + `handleAvatarChange`；渲染去掉 `level` prop
- `VoicePlayer.getLevel()` **保留不删**
- 测试：`npm run build` 零 TS 错误 + `go test ./... -count=1 -p 1` 全绿（回归）

---

## File map

| Path | Responsibility |
|------|----------------|
| `frontend/public/persona-default.png` | 复制 wps.png（原样） |
| `frontend/src/components/VirtualPersona.tsx` | 重写为整图 + 三态动画 |
| `frontend/src/pages/InterviewRoomPage.tsx` | 清理音量轮询，保留状态映射/头像 |
| `frontend/src/pages/InterviewPages.css` | `.virtual-persona-img` 样式 + 动画类调整 |
| `docs/superpowers/specs/2026-08-18-static-persona-design.md` | Status → Implemented |

---

### Task 1: 资源 + 组件重写 + 房间页清理 + CSS

**Files:**
- Create: `frontend/public/persona-default.png`（复制）
- Modify: `frontend/src/components/VirtualPersona.tsx`, `frontend/src/pages/InterviewRoomPage.tsx`, `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: V12 的 `personaState`、`avatarUrl`、`handleAvatarChange`（房间页既有）
- Produces: `VirtualPersonaProps`（无 level）

- [ ] **Step 1: 复制图片（原样）**

```bash
cp "C:\Users\l\Desktop\wps.png" "C:\Users\l\Desktop\Interview Assistant\frontend\public\persona-default.png"
```

验证字节一致：`cmp` 两文件输出无差异。

- [ ] **Step 2: 重写 VirtualPersona.tsx**

```tsx
export type PersonaState = 'idle' | 'speaking' | 'listening';

export interface VirtualPersonaProps {
  state: PersonaState;
  /** 用户头像 data URL（可选，整图替换默认形象） */
  avatarUrl?: string | null;
}

export default function VirtualPersona({ state, avatarUrl }: VirtualPersonaProps) {
  return (
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
  );
}
```

（无 React hooks import。）

- [ ] **Step 3: 房间页清理**

`frontend/src/pages/InterviewRoomPage.tsx`：
- 删除：`const [personaLevel, setPersonaLevel] = useState(0);` 和 `const personaLevelRaf = useRef(0);`
- 删除整个音量轮询 effect（`[personaState]` 依赖的那个，当前约 326-338 行）
- 保留：`personaState` state、状态映射 effect（`[reading, thinking]`）、`avatarUrl`、`handleAvatarChange`
- 渲染改为：`<VirtualPersona state={personaState} avatarUrl={avatarUrl} />`（去掉 `level={personaLevel}`）

- [ ] **Step 4: CSS 调整**

`frontend/src/pages/InterviewPages.css` 中虚拟人相关改为：

```css
.virtual-persona {
  position: relative;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15));
}

.virtual-persona-img {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  object-fit: contain; /* 整图等比完整显示，不裁剪 */
  background: var(--color-canvas-soft);
}

.virtual-persona-label {
  font: var(--text-caption);
  color: var(--color-mute);
  text-align: center;
}

.virtual-persona-avatar-btn {
  font: var(--text-caption);
  color: var(--color-ink);
  cursor: pointer;
  text-decoration: underline;
}

/* idle 呼吸浮动 */
.virtual-persona--idle .virtual-persona-img {
  animation: persona-breathe 2.5s ease-in-out infinite;
}

/* speaking 点头 */
.virtual-persona--speaking .virtual-persona-img {
  animation: persona-nod 0.8s ease-in-out infinite;
}

/* listening 轻微等待 */
.virtual-persona--listening .virtual-persona-img {
  animation: persona-listen 3s ease-in-out infinite;
}

@keyframes persona-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

@keyframes persona-nod {
  0%, 100% { transform: translateY(0) rotate(0deg); }
  50% { transform: translateY(1px) rotate(1.5deg); }
}

@keyframes persona-listen {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(2px); }
}
```

删除旧 SVG 相关规则（`.virtual-persona-head`、`.virtual-persona-eye`、`.virtual-persona-mouth` 及 blink 关键帧；若无独立定义则清理引用）。

- [ ] **Step 5: 构建**

Run: `cd frontend && npm run build`
Expected: PASS（零 TS 错误；确认无残留对 `personaLevel`/`level` 的引用）。

- [ ] **Step 6: 提交**

```bash
git add frontend/public/persona-default.png frontend/src/components/VirtualPersona.tsx frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(v13): static persona image with ambient animations, drop mouth sync"
```

---

### Task 2: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-static-persona-design.md`

- [ ] **Step 1: 全量后端测试（回归）**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（可选）**

语音面试 → 房间显示 wps.png 整图；speaking 点头 / idle 呼吸 / listening 等待；换头像整图替换；刷新保留；文字模式不显示。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-18-static-persona-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v13-static-persona`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-18-static-persona-design.md
git commit -m "docs(v13): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v13-static-persona -m "merge: V13 static persona"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 资源复制（原样） | T1 Step 1 |
| §5 组件重写（整图、无 level） | T1 Step 2 |
| §6 房间页清理 | T1 Step 3 |
| §7 CSS | T1 Step 4 |
| §8 W1–W5 | T1–T2 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `cmp` 验证图片字节一致（原样要求）
- 房间页删除音量轮询后，确认 `voicePlayerRef`/`getLevel` 无其他房间页引用（getLevel 仅 voicePlayer 内部，保留不删）
- CSS 旧 SVG 规则清理：`grep -n "virtual-persona" InterviewPages.css` 确认哪些删除哪些保留
