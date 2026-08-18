# V12 数字虚拟人讲话 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 面试房间语音模式下显示 2D 虚拟面试官，TTS 播报时嘴型随音量开合（Web Audio 驱动），支持内置默认形象与本地可换头像。

**Architecture:** 改造 `voicePlayer.ts` 用 Web Audio（AudioContext + AnalyserNode）播放并提供 `getLevel()` 实时音量；新建 `VirtualPersona` 组件（SVG 默认形象 + 三态动画 + 头像替换）；房间页语音模式接入——播放中 `speaking`（level 驱动嘴型）、思考 `listening`、其余 `idle`。纯前端，零后端。

**Tech Stack:** React/Vite TS、Web Audio API、SVG、既有 design tokens。

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-18-virtual-persona-design.md`
- 分支 `feat/v12-virtual-persona` from main HEAD
- `VoicePlayer` 接口新增 `getLevel(): number`（0..1）；`play`/`stop` 语义不变（静音/重播/跳过行为一致）
- `VirtualPersonaProps = { state: 'idle' | 'speaking' | 'listening'; level?: number; avatarUrl?: string | null }`
- 动画：`idle` 呼吸+眨眼（CSS）、`speaking` 嘴型 `scaleY = 0.2 + level * 0.8`（rAF 驱动 SVG 属性）+ 点头、`listening` 静止
- 头像：`localStorage` key `virtual_persona_avatar`（base64 data URL，≤300KB，非图片拒绝）；仅本地
- 显示条件：仅 `effectiveInputMode === 'voice'`（文字模式不渲染）
- 房间页：`reading === true` → speaking + level 轮询；`thinking` → listening；否则 idle
- 无后端改动、无迁移、无新依赖（Web Audio 原生）
- 测试：`go test ./... -count=1 -p 1` 全绿（回归）+ `npm run build` 零 TS 错误

---

## File map

| Path | Responsibility |
|------|----------------|
| `frontend/src/lib/voicePlayer.ts` | Web Audio 播放 + AnalyserNode 音量分析 + `getLevel()` |
| `frontend/src/components/VirtualPersona.tsx` | SVG 默认形象 + 三态动画 + 头像替换（新建） |
| `frontend/src/pages/InterviewRoomPage.tsx` | 接入虚拟人（状态映射 + level 轮询 + 头像读写） |
| `frontend/src/pages/InterviewPages.css` | `.virtual-persona` 样式 + 呼吸/眨眼关键帧 |
| `docs/superpowers/specs/2026-08-18-virtual-persona-design.md` | Status → Implemented |

---

### Task 1: voicePlayer 改造（Web Audio + 音量分析）

**Files:**
- Modify: `frontend/src/lib/voicePlayer.ts`

**Interfaces:**
- Consumes: 无（既有 `createVoicePlayer` 调用方只依赖 `play`/`stop`）
- Produces:
  - `interface VoicePlayer { play(blob: Blob): Promise<void>; stop(): void; getLevel(): number }`
  - `createVoicePlayer(): VoicePlayer`

- [ ] **Step 1: 重写 voicePlayer.ts**

```ts
export interface VoicePlayer {
  play(blob: Blob): Promise<void>;
  stop(): void;
  /** 当前播放音量水平 0..1；未播放时为 0 */
  getLevel(): number;
}

export function createVoicePlayer(): VoicePlayer {
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array | null = null;
  let level = 0;
  let rafId = 0;

  function sampleLevel(): void {
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      level = Math.min(1, sum / dataArray.length / 128);
    }
    rafId = requestAnimationFrame(sampleLevel);
  }

  function stopSampling(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  return {
    play(blob: Blob): Promise<void> {
      stop();
      objectUrl = URL.createObjectURL(blob);
      const element = new Audio(objectUrl);
      audio = element;
      // 用 AudioContext 连接分析器：volume 可听 + analyser 取数据
      // 兼容处理：某些环境 AudioContext 受限时降级为纯 audio 播放（getLevel 返回 0）
      try {
        if (!ctx) {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          ctx = Ctor ? new Ctor() : null;
        }
        if (ctx) {
          const src = ctx.createMediaElementSource(element);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          dataArray = new Uint8Array(analyser.frequencyBinCount);
          src.connect(analyser);
          analyser.connect(ctx.destination);
          sampleLevel();
        }
      } catch {
        // 分析器初始化失败不影响播放（getLevel 保持 0）
        analyser = null;
        dataArray = null;
      }

      return new Promise<void>((resolve, reject) => {
        element.onended = () => {
          stopSampling();
          cleanup();
          resolve();
        };
        element.onerror = () => {
          stopSampling();
          cleanup();
          reject(new Error('audio playback failed'));
        };
        void element.play().catch((err) => {
          stopSampling();
          cleanup();
          reject(err);
        });
      });
    },

    stop() {
      stopSampling();
      level = 0;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio = null;
      }
      cleanup();
    },

    getLevel() {
      return level;
    },
  };

  function cleanup(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }
}
```

注意：
- `createMediaElementSource` 每个元素只能调用一次——`audio` 每次 play 新建，安全
- `AudioContext` 在用户手势后创建（play 由点击/消息触发），满足 iOS 要求；失败降级不阻塞播放
- `getLevel` 未播放返回 0（stop 置 0，play 前为初始 0）

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: PASS（零 TS 错误；现有 `play`/`stop` 调用方不受影响）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/lib/voicePlayer.ts
git commit -m "feat(v12): web audio playback with volume analysis in voice player"
```

---

### Task 2: VirtualPersona 组件

**Files:**
- Create: `frontend/src/components/VirtualPersona.tsx`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PersonaState = 'idle' | 'speaking' | 'listening'`
  - `interface VirtualPersonaProps { state: PersonaState; level?: number; avatarUrl?: string | null }`
  - `export default function VirtualPersona(props: VirtualPersonaProps): JSX.Element`

- [ ] **Step 1: 写组件**

```tsx
import { useEffect, useRef } from 'react';

export type PersonaState = 'idle' | 'speaking' | 'listening';

export interface VirtualPersonaProps {
  state: PersonaState;
  /** 0..1 音量水平，speaking 时驱动嘴型 */
  level?: number;
  /** 用户头像 data URL（可选，替换默认脸） */
  avatarUrl?: string | null;
}

export default function VirtualPersona({ state, level = 0, avatarUrl }: VirtualPersonaProps) {
  const mouthRef = useRef<SVGEllipseElement | null>(null);
  const bodyRef = useRef<SVGGElement | null>(null);

  // speaking 时嘴型随音量缩放（rAF 直改 SVG 属性）
  useEffect(() => {
    if (state !== 'speaking' || !mouthRef.current) return;
    let raf = 0;
    const tick = () => {
      if (mouthRef.current) {
        const scale = 0.2 + Math.min(1, level) * 0.8;
        mouthRef.current.setAttribute('ry', String(3 + scale * 7));
      }
      if (bodyRef.current) {
        const bob = 1 + Math.sin(Date.now() / 120) * 0.01;
        bodyRef.current.setAttribute('transform', `translate(0, ${(1 - bob) * 2})`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, level]);

  return (
    <div className={`virtual-persona virtual-persona--${state}`} aria-label="虚拟面试官">
      <svg viewBox="0 0 160 200" width="140" height="175" role="img">
        {/* 身体 */}
        <g ref={bodyRef}>
          <path
            d="M40 200 C40 150 120 150 120 200 Z"
            fill="#e8e4dc"
            stroke="#171717"
            strokeWidth="2"
          />
          {/* 领口 */}
          <path d="M70 170 L80 190 L90 170 Z" fill="#f5f1e8" stroke="#171717" strokeWidth="1.5" />
        </g>
        {/* 头部 */}
        <g className="virtual-persona-head">
          <circle cx="80" cy="80" r="52" fill="#f5d0b4" stroke="#171717" strokeWidth="2" />
          {/* 头发 */}
          <path d="M28 70 Q30 30 80 26 Q130 30 132 70 L132 55 Q132 30 80 24 Q28 30 28 55 Z" fill="#3a3a3a" />
          {/* 眼睛（眨眼动画 class） */}
          <ellipse className="virtual-persona-eye" cx="62" cy="80" rx="6" ry="7" fill="#171717" />
          <ellipse className="virtual-persona-eye" cx="98" cy="80" rx="6" ry="7" fill="#171717" />
          {/* 嘴（speaking 时由 JS 改 ry） */}
          <ellipse
            ref={mouthRef}
            className="virtual-persona-mouth"
            cx="80"
            cy="104"
            rx="10"
            ry="3"
            fill="#8a4b3a"
          />
        </g>
        {/* 用户头像覆盖脸部（可选） */}
        {avatarUrl && (
          <clipPath id="persona-face-clip">
            <circle cx="80" cy="80" r="42" />
          </clipPath>
        )}
        {avatarUrl && (
          <image
            href={avatarUrl}
            x="38"
            y="38"
            width="84"
            height="84"
            clipPath="url(#persona-face-clip)"
            preserveAspectRatio="xMidYMid slice"
          />
        )}
      </svg>
      {state === 'speaking' && <span className="virtual-persona-label">正在提问…</span>}
      {state === 'listening' && <span className="virtual-persona-label">思考中…</span>}
      {state === 'idle' && <span className="virtual-persona-label">面试官</span>}
    </div>
  );
}
```

注意：
- `clipPath` id 用固定值即可（页面单实例）；若未来多实例需 useId，当前不需要
- 眨眼/呼吸由 CSS（Task 3 提供 `.virtual-persona--idle .virtual-persona-eye` 关键帧）
- `level` 变化触发 effect 重跑（rAF 循环内读最新 `level`，effect 依赖含 level 以保证闭包最新）

- [ ] **Step 2: 构建验证**

Run: `cd frontend && npm run build`
Expected: PASS（`JSX.Element` 若 TS 版本报错，用 `ReactElement` 或省略返回注解；`useRef<SVGEllipseElement | null>` 与 SVG 类型兼容）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/VirtualPersona.tsx
git commit -m "feat(v12): virtual persona component with state-driven mouth animation"
```

---

### Task 3: 房间页接入 + 头像 + CSS

**Files:**
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`, `frontend/src/pages/InterviewPages.css`

**Interfaces:**
- Consumes: T1 `createVoicePlayer().getLevel()`、T2 `VirtualPersona` 组件
- Produces: 无新导出

- [ ] **Step 1: 房间页接入虚拟人**

imports 加：

```ts
import VirtualPersona from '../components/VirtualPersona';
```

新增 state/ref：

```ts
const [personaState, setPersonaState] = useState<'idle' | 'speaking' | 'listening'>('idle');
const [personaLevel, setPersonaLevel] = useState(0);
const [avatarUrl, setAvatarUrl] = useState<string | null>(() =>
  localStorage.getItem('virtual_persona_avatar'),
);
const personaLevelRaf = useRef(0);
```

level 轮询 effect（speaking 时读取 voicePlayer 音量）：

```ts
useEffect(() => {
  if (personaState !== 'speaking') {
    if (personaLevelRaf.current) cancelAnimationFrame(personaLevelRaf.current);
    return;
  }
  const tick = () => {
    setPersonaLevel(voicePlayerRef.current?.getLevel() ?? 0);
    personaLevelRaf.current = requestAnimationFrame(tick);
  };
  personaLevelRaf.current = requestAnimationFrame(tick);
  return () => {
    if (personaLevelRaf.current) cancelAnimationFrame(personaLevelRaf.current);
  };
}, [personaState]);
```

状态映射 effect（由 reading/thinking 派生）：

```ts
useEffect(() => {
  if (reading) setPersonaState('speaking');
  else if (thinking) setPersonaState('listening');
  else setPersonaState('idle');
}, [reading, thinking]);
```

清理：主 effect cleanup 里取消 `personaLevelRaf`（若 personaState effect 已处理则无需重复）。

头像更换 handler：

```ts
function handleAvatarChange(e: ChangeEvent<HTMLInputElement>) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatusLine('请选择图片文件');
    return;
  }
  if (file.size > 300 * 1024) {
    setStatusLine('头像需小于 300KB');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result);
    localStorage.setItem('virtual_persona_avatar', url);
    setAvatarUrl(url);
    setStatusLine('头像已更新');
  };
  reader.readAsDataURL(file);
  e.target.value = '';
}
```

（`ChangeEvent` 已 import。）

渲染（`interview-room-header` 之后、error 之前，仅语音模式）：

```tsx
{effectiveInputMode === 'voice' && (
  <div className="virtual-persona-area">
    <VirtualPersona state={personaState} level={personaLevel} avatarUrl={avatarUrl} />
    <label className="virtual-persona-avatar-btn">
      换头像
      <input type="file" accept="image/*" onChange={handleAvatarChange} hidden />
    </label>
  </div>
)}
```

- [ ] **Step 2: CSS**

`InterviewPages.css` 末尾追加：

```css
.virtual-persona-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-xs);
  margin-bottom: var(--space-md);
}

.virtual-persona {
  position: relative;
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.15));
}

.virtual-persona-label {
  font: var(--text-caption);
  color: var(--color-mute);
}

.virtual-persona-avatar-btn {
  font: var(--text-caption);
  color: var(--color-ink);
  cursor: pointer;
  text-decoration: underline;
}

/* idle 呼吸 + 眨眼 */
.virtual-persona--idle .virtual-persona-head {
  animation: persona-breathe 2.5s ease-in-out infinite;
}

.virtual-persona--idle .virtual-persona-eye {
  animation: persona-blink 4s ease-in-out infinite;
}

@keyframes persona-breathe {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-2px); }
}

@keyframes persona-blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95% { transform: scaleY(0.1); }
}

/* listening 轻微等待 */
.virtual-persona--listening .virtual-persona-head {
  animation: persona-listen 3s ease-in-out infinite;
}

@keyframes persona-listen {
  0%, 100% { transform: translateX(0); }
  50% { transform: translateX(1px); }
}
```

- [ ] **Step 3: 构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/InterviewPages.css
git commit -m "feat(v12): wire virtual persona into voice room with avatar upload"
```

---

### Task 4: 验收

**Files:**
- Modify: `docs/superpowers/specs/2026-08-18-virtual-persona-design.md`

- [ ] **Step 1: 全量后端测试（回归）**

Run: `cd backend && go test ./... -count=1 -p 1`
Expected: 全部 PASS。

- [ ] **Step 2: 前端构建**

Run: `cd frontend && npm run build`
Expected: PASS。

- [ ] **Step 3: 手工冒烟（需语音/浏览器）**

语音面试 → 房间顶部出现虚拟人；TTS 播放问题 → 嘴型随音量动、播放结束回 idle；思考中 → listening；静音/重播/跳过 → 动画正确复位；换头像 → 本地生效、刷新保留；文字模式不显示。

- [ ] **Step 4: 更新 spec 状态**

`docs/superpowers/specs/2026-08-18-virtual-persona-design.md` 的 `**Status:** Draft for user review` 改为 `**Status:** Implemented on feat/v12-virtual-persona`。

- [ ] **Step 5: 提交并合并**

```bash
git add docs/superpowers/specs/2026-08-18-virtual-persona-design.md
git commit -m "docs(v12): mark spec implemented"
# 回到主仓库合并
git merge --no-ff feat/v12-virtual-persona -m "merge: V12 virtual persona"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §4 voicePlayer Web Audio + getLevel | T1 |
| §5 VirtualPersona 组件（三态 + 头像） | T2 |
| §6 房间页接入 + 状态映射 + 头像 | T3 |
| §7 CSS | T3 |
| §8 V1–V6 | T1–T4 |

## Placeholder scan

所有步骤含具体代码/命令，无 TBD。执行时需确认的点：
- `JSX.Element` 返回注解若 TS 版本报错 → 用 `ReactElement` 或省略
- `clipPath` id 固定值（单实例页面）可接受
- `AudioContext` 类型 `window.webkitAudioContext` 的 TS 断言写法（计划已含）
- 主 effect cleanup 与 personaState effect 的 rAF 清理不冲突（各自管理）
