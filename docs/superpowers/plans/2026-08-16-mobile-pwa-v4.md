# V4 手机端（移动端 PWA）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing React app fully usable on phones as an installable PWA — responsive layout at mobile widths (no horizontal overflow), bottom tab navigation, and a Service Worker that precaches the app shell for offline opening — with zero backend changes.

**Architecture:** Keep the single existing `frontend/` app. Add `vite-plugin-pwa@^1.3.0` (supports Vite 8) for manifest + Service Worker generation, plus a dependency-free Node script that generates the 192/512 PNG icons from the brand palette. Add one new stylesheet `src/styles/mobile.css` holding all `@media (max-width: 599px)` rules scoped under `.interview-page`/`.auth-page` (so they win over the later-loaded page CSS), a small `MobileTabBar` component included in the 7 protected pages, and `registerSW()` in `main.tsx`. Verification is browser-based at a 375×667 viewport (spec §7); real-device voice/install checks are a documented manual checklist.

**Tech Stack:** React 19 / Vite 8 / TS 6 (`npm run build` = `tsc -b && vite build`), `vite-plugin-pwa@^1.3.0` (bundles `workbox-build` + `workbox-window`), Node ≥18 built-ins only (icon script uses `node:zlib`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-16-mobile-pwa-design.md`
- Branch `feat/v4-mobile-pwa` from main HEAD (create in an isolated worktree via `using-git-worktrees`). Spec says V3 merges first; if V3 is not yet merged when this starts, branch from current main HEAD anyway and note it in the PR — do not wait on V3.
- **Zero backend code changes** (spec §2 locked decision). Real-device verification needs the backend CORS allowlist (`backend/cmd/server/main.go:80-85`) to include the LAN origin; that is a **verification-only, never-committed** edit (Task 5).
- Mobile breakpoint: `@media (max-width: 599px)` only. Use design tokens (`--space-*`, `--color-*`, `--text-*`, `--rounded-*`) — no hardcoded colors/fonts/sizes.
- Touch targets: nav/tappable targets ≥44px; primary action buttons ≥48px.
- All UI copy Chinese; app name「模拟面试助手」; `theme_color` `#171717`, `background_color` `#ffffff`.
- Offline scope is the **app shell only** (spec Non-goal: no offline interview); deep links like `/interviews/:id` require network (`navigateFallbackAllowlist` is root-only by design).
- Desktop must not regress: on ≥600px the header links and layout are untouched; the tab bar is `display:none` by default.
- No new frontend entry or directory; modify the existing `frontend/`.
- Verification: `npm run lint` + `npm run build` + 375×667 viewport walk of all routes (M1) + manifest/SW checks (M3) + desktop viewport smoke (M5). Real-device items (M2 voice, M3 install, M4 on-device parity) are manual and listed in Task 5.

---

## File map

| Path | Responsibility |
|------|----------------|
| `frontend/package.json` | Add `vite-plugin-pwa@^1.3.0` (devDep) + `"icons"` npm script |
| `frontend/scripts/generate-icons.mjs` | Dependency-free PNG generator: 192/512 brand icons |
| `frontend/public/pwa-192x192.png`, `frontend/public/pwa-512x512.png` | Generated icons (committed) |
| `frontend/vite.config.ts` | `VitePWA()` plugin: manifest + workbox precache |
| `frontend/tsconfig.app.json` | `types` += `vite-plugin-pwa/client` (for `virtual:pwa-register`) |
| `frontend/index.html` | `theme-color` + apple meta tags + `apple-touch-icon` |
| `frontend/src/main.tsx` | `registerSW({ immediate: true })` |
| `frontend/src/styles/mobile.css` | All `@media (max-width: 599px)` rules + `.mobile-tabbar` base styles |
| `frontend/src/index.css` | `@import './styles/mobile.css';` |
| `frontend/src/components/MobileTabBar.tsx` | Fixed bottom tab bar (NavLink × 4), hidden on desktop |
| 7 protected pages (`InterviewListPage`, `QuestionBankPage`, `CreateInterviewPage`, `InterviewDetailPage`, `InterviewRoomPage`, `ReportPage`, `TrendsPage`) | Import + render `<MobileTabBar />` |
| `docs/superpowers/specs/2026-08-16-mobile-pwa-design.md` | Status → Implemented (Task 4) |

---

### Task 1: PWA 化 — manifest、图标、Service Worker

**Files:**
- Modify: `frontend/package.json`, `frontend/vite.config.ts`, `frontend/tsconfig.app.json`, `frontend/index.html`, `frontend/src/main.tsx`
- Create: `frontend/scripts/generate-icons.mjs`, `frontend/public/pwa-192x192.png`, `frontend/public/pwa-512x512.png`

**Interfaces:**
- Consumes: existing Vite 8 / React 19 setup (no code-level interfaces)
- Produces: `vite-plugin-pwa` config emitting `dist/manifest.webmanifest` + `dist/sw.js`; `virtual:pwa-register` module (typed via `vite-plugin-pwa/client`) with `registerSW({ immediate: true })`; icons at `/pwa-192x192.png` and `/pwa-512x512.png` (also used as `apple-touch-icon`)

- [ ] **Step 1: Install the dependency**

Run: `cd frontend && npm install -D vite-plugin-pwa@^1.3.0`
Expected: `package.json` devDependencies gains `"vite-plugin-pwa": "^1.3.0"`. (It bundles `workbox-build`/`workbox-window`; no separate installs needed.)

- [ ] **Step 2: Write the icon generator script**

Create `frontend/scripts/generate-icons.mjs`:

```js
// Generates public/pwa-192x192.png and public/pwa-512x512.png.
// Dependency-free: encodes PNGs with node:zlib. Colors from src/styles/tokens.css
// and the brand palette in public/favicon.svg: background #171717, bubble #ffffff,
// tail #863bff.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const BG = [0x17, 0x17, 0x17];
const WHITE = [0xff, 0xff, 0xff];
const VIOLET = [0x86, 0x3b, 0xff];

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function coverage(px, py, cx, cy, r) {
  const d = Math.hypot(px - cx, py - cy);
  return Math.max(0, Math.min(1, r + 0.5 - d));
}

function renderIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const r = size * 0.36; // bubble radius
  const tail = { x: c + r * 0.45, y: c + r * 0.4, radius: r * 0.5 };
  const dots = [
    { x: c - size * 0.1, y: c, radius: size * 0.035 },
    { x: c, y: c, radius: size * 0.035 },
    { x: c + size * 0.1, y: c, radius: size * 0.035 },
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const col = BG.slice();
      const paint = (target, cover) => {
        for (let i = 0; i < 3; i++) col[i] = Math.round(col[i] + (target[i] - col[i]) * cover);
      };
      paint(VIOLET, coverage(px, py, tail.x, tail.y, tail.radius));
      paint(WHITE, coverage(px, py, c, c, r));
      for (const d of dots) paint(BG, coverage(px, py, d.x, d.y, d.radius));
      const off = (y * size + x) * 4;
      buf[off] = col[0];
      buf[off + 1] = col[1];
      buf[off + 2] = col[2];
      buf[off + 3] = 255;
    }
  }
  return buf;
}

function writePng(path, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const pixels = renderIcon(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
}

writePng(join(outDir, 'pwa-192x192.png'), 192);
writePng(join(outDir, 'pwa-512x512.png'), 512);
console.log('icons written to', outDir);
```

- [ ] **Step 3: Run the generator**

Run: `cd frontend && node scripts/generate-icons.mjs`
Expected: `frontend/public/pwa-192x192.png` and `frontend/public/pwa-512x512.png` exist (each file starts with the PNG magic bytes; verify with `file public/pwa-*.png` or opening them).

- [ ] **Step 4: Configure vite-plugin-pwa**

Replace the entire contents of `frontend/vite.config.ts` with:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: '模拟面试助手',
        short_name: '模拟面试',
        description: 'AI 模拟面试练习助手',
        lang: 'zh-CN',
        display: 'standalone',
        start_url: '/',
        background_color: '#ffffff',
        theme_color: '#171717',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // App shell only: offline opens "/"; deep links need network (spec Non-goal).
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/$/],
      },
    }),
  ],
})
```

- [ ] **Step 5: Register the Service Worker**

In `frontend/src/main.tsx`, add the import and call so the current file becomes:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './index.css'
import App from './App.tsx'

registerSW({ immediate: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

In `frontend/tsconfig.app.json`, change `"types": ["vite/client"]` to `"types": ["vite/client", "vite-plugin-pwa/client"]` (provides the `virtual:pwa-register` module types for `tsc -b`).

- [ ] **Step 6: Add meta tags to `index.html`**

In `frontend/index.html`, add after the existing viewport meta (line 6):

```html
    <meta name="theme-color" content="#171717" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="模拟面试" />
    <link rel="apple-touch-icon" href="/pwa-192x192.png" />
```

- [ ] **Step 7: Add the icons npm script**

In `frontend/package.json`, add to `scripts`:

```json
    "icons": "node scripts/generate-icons.mjs"
```

- [ ] **Step 8: Build and verify PWA artifacts**

Run: `cd frontend && npm run build`
Expected: PASS, and `frontend/dist/` contains `manifest.webmanifest`, `sw.js`, `registerSW.js`, `pwa-192x192.png`, `pwa-512x512.png`.

Check the generated manifest: `node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync('./dist/manifest.webmanifest','utf8')); console.log(m.name, m.display, m.icons.map(i=>i.sizes))"`
Expected: `模拟面试助手 standalone [ '192x192', '512x512', '512x512' ]`.

- [ ] **Step 9: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/vite.config.ts frontend/tsconfig.app.json frontend/index.html frontend/src/main.tsx frontend/scripts/generate-icons.mjs frontend/public/pwa-192x192.png frontend/public/pwa-512x512.png
git commit -m "feat(v4): PWA manifest, service worker, and app icons"
```

---

### Task 2: 移动端响应式布局 + 底部标签栏

**Files:**
- Create: `frontend/src/styles/mobile.css`, `frontend/src/components/MobileTabBar.tsx`
- Modify: `frontend/src/index.css`
- Modify (import + render `<MobileTabBar />`): `frontend/src/pages/InterviewListPage.tsx`, `frontend/src/pages/QuestionBankPage.tsx`, `frontend/src/pages/CreateInterviewPage.tsx`, `frontend/src/pages/InterviewDetailPage.tsx`, `frontend/src/pages/InterviewRoomPage.tsx`, `frontend/src/pages/ReportPage.tsx`, `frontend/src/pages/TrendsPage.tsx`

**Interfaces:**
- Consumes: `react-router-dom` `NavLink` (v7), design tokens from `src/styles/tokens.css`
- Produces: `<MobileTabBar />` (default export) — fixed bottom nav, `display:none` on desktop; `src/styles/mobile.css` imported from `src/index.css` with rules scoped under `.interview-page`/`.auth-page`

- [ ] **Step 1: Write `MobileTabBar.tsx`**

Create `frontend/src/components/MobileTabBar.tsx`:

```tsx
import { NavLink } from 'react-router-dom';

const ITEMS: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: '面试', end: true },
  { to: '/questions', label: '题库' },
  { to: '/trends', label: '成长分析' },
  { to: '/interviews/new', label: '新建' },
];

export default function MobileTabBar() {
  return (
    <nav className="mobile-tabbar" aria-label="主导航">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            `mobile-tabbar-item${isActive ? ' is-active' : ''}`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
```

- [ ] **Step 2: Write `mobile.css`**

Create `frontend/src/styles/mobile.css`. Every override is scoped under the page root class so it beats the later-loaded per-page CSS regardless of import order (media queries do not add specificity). `--space-4xl` (64px) + safe-area clears the 56px tab bar.

```css
/* V4 mobile layout: breakpoint <600px (spec §4). Imported from index.css.
   Rules are scoped under .interview-page / .auth-page so they win over the
   per-page stylesheets that load afterwards. */

.mobile-tabbar {
  display: none;
}

@media (max-width: 599px) {
  body {
    overflow-x: hidden; /* M1: no horizontal overflow */
  }

  /* --- Header: compact; nav links move to the bottom tab bar --- */
  .interview-page .interview-header {
    height: 56px;
    padding: 0 var(--space-md);
  }

  .interview-page .interview-header-actions {
    gap: var(--space-xxs);
  }

  /* 题库 / 成长分析 / 返回列表 / 详情 / 新建面试 CTA: covered by the tab bar */
  .interview-page .interview-header-actions a {
    display: none;
  }

  .interview-page .interview-header-actions button {
    padding: var(--space-xs);
    border: none;
    background: none;
    color: var(--color-body);
  }

  /* --- Main column: narrower gutters, clearance under the fixed tab bar --- */
  .interview-page .interview-main {
    padding: var(--space-lg) var(--space-md)
      calc(var(--space-4xl) + env(safe-area-inset-bottom));
  }

  .interview-page .interview-main h1 {
    font: var(--text-display-sm);
  }

  /* --- Bottom tab bar (≥44px targets) --- */
  .mobile-tabbar {
    display: flex;
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 20;
    height: calc(56px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--color-canvas);
    border-top: 1px solid var(--color-hairline);
  }

  .mobile-tabbar-item {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    font: var(--text-body-sm-strong);
    color: var(--color-body);
    text-decoration: none;
  }

  .mobile-tabbar-item.is-active {
    color: var(--color-primary);
    box-shadow: inset 0 -2px 0 var(--color-primary);
  }

  /* --- Buttons: full-width primary actions, ≥48px --- */
  .interview-page .interview-submit {
    width: 100%;
    min-height: 48px;
  }

  .interview-page .interview-room-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .interview-page .interview-room-actions .interview-room-end {
    width: 100%;
    min-height: 48px;
  }

  /* --- Interview room --- */
  .interview-page .interview-room-header {
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-xxs);
  }

  .interview-page .interview-room-transcript {
    max-height: 45svh;
  }

  .interview-page .voice-room-controls {
    flex-direction: column;
    align-items: stretch;
  }

  /* 按住说话: thumb-sized target */
  .interview-page .voice-record-button {
    width: 100%;
    min-width: 0;
    min-height: 64px;
    font: var(--text-button-lg);
  }

  .interview-page .voice-room-tts-controls {
    display: flex;
    width: 100%;
  }

  .interview-page .voice-room-tts-btn {
    flex: 1;
    min-height: 44px;
  }

  /* --- Lists / cards: stack vertically, no side-by-side squeeze --- */
  .interview-page .interview-list-item {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-sm);
  }

  .interview-page .question-bank-row {
    flex-direction: row;
    align-items: flex-start;
  }

  .interview-page .question-bank-content {
    min-width: 0;
  }

  .interview-page .interview-list-links {
    flex-wrap: wrap;
  }

  .interview-page .interview-inline-link {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
  }

  .interview-page .question-bank-star {
    min-width: 44px;
    min-height: 44px;
    font-size: 1.5rem;
  }

  /* --- Filters / forms --- */
  .interview-page .question-bank-filters,
  .interview-page .interview-filter-row {
    flex-direction: column;
    align-items: stretch;
  }

  .interview-page .question-bank-filters .interview-field,
  .interview-page .interview-filter-row select {
    width: 100%;
  }

  .interview-page .interview-field textarea {
    min-height: 100px;
  }

  .interview-page .interview-file-meta {
    flex-direction: column;
    align-items: flex-start;
  }

  .interview-page .question-bank-actions {
    align-items: stretch;
    gap: var(--space-sm);
  }

  /* --- Auth --- */
  .auth-page .auth-card {
    padding: var(--space-lg) var(--space-md);
  }
}
```

- [ ] **Step 3: Import the mobile stylesheet**

In `frontend/src/index.css`, change the first line to:

```css
@import './styles/tokens.css';
@import './styles/mobile.css';
```

- [ ] **Step 4: Add `<MobileTabBar />` to the 7 protected pages**

For each file below: add `import MobileTabBar from '../components/MobileTabBar';` right after its existing `import './InterviewPages.css';` line, then insert `<MobileTabBar />` between the root div's `</main>` and the final `</div>` (i.e. as the last child of `.interview-page`).

| File | Import goes after | JSX goes between |
|------|-------------------|------------------|
| `frontend/src/pages/InterviewListPage.tsx` | `import './InterviewPages.css';` (line 10) | `</main>` (line 126) and `</div>` (line 127) |
| `frontend/src/pages/QuestionBankPage.tsx` | `import './InterviewPages.css';` (line 16) | `</main>` (line 277) and `</div>` (line 278) |
| `frontend/src/pages/CreateInterviewPage.tsx` | `import './InterviewPages.css';` (line 13) | `</main>` (line 200) and `</div>` (line 201) |
| `frontend/src/pages/InterviewDetailPage.tsx` | `import './InterviewPages.css';` (line 12) | `</main>` (line 189) and `</div>` (line 190) |
| `frontend/src/pages/InterviewRoomPage.tsx` | `import './InterviewPages.css';` (line 14) | `</main>` (line 526) and `</div>` (line 527) |
| `frontend/src/pages/ReportPage.tsx` | `import './InterviewPages.css';` (line 13) | `</main>` and the closing `</div>` of `.interview-page` |
| `frontend/src/pages/TrendsPage.tsx` | `import './InterviewPages.css';` (line 18) | `</main>` (line 204) and `</div>` (line 205) |

For ReportPage, find the pair with: `grep -n "</main>" src/pages/ReportPage.tsx` — the element right after it is the closing `</div>`. The exact change in every page is:

```tsx
      </main>
      <MobileTabBar />
    </div>
```

- [ ] **Step 5: Build + lint**

Run: `cd frontend && npm run build && npm run lint`
Expected: both PASS. (If oxlint flags an unused import anywhere, remove it.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/styles/mobile.css frontend/src/index.css frontend/src/components/MobileTabBar.tsx frontend/src/pages/InterviewListPage.tsx frontend/src/pages/QuestionBankPage.tsx frontend/src/pages/CreateInterviewPage.tsx frontend/src/pages/InterviewDetailPage.tsx frontend/src/pages/InterviewRoomPage.tsx frontend/src/pages/ReportPage.tsx frontend/src/pages/TrendsPage.tsx
git commit -m "feat(v4): responsive mobile layout with bottom tab bar"
```

---

### Task 3: 桌面端回归（M5）

**Files:** none (verification only)

**Interfaces:** — none

- [ ] **Step 1: Desktop build + lint (already green from Task 2)**

Run: `cd frontend && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 2: Desktop viewport smoke at 1280×800**

1. Start the preview server: `cd frontend && npm run preview` (serves `dist/` at `http://localhost:4173`).
2. Open `http://localhost:4173` in a ≥1280px-wide browser.
3. Check the header still shows the brand + all original links (题库 / 成长分析 / 新建面试 / 退出登录) — the mobile rules do not apply above 599px.
4. Confirm the bottom tab bar is **not** visible (`.mobile-tabbar` is `display:none` by default).
5. Walk `/`, `/questions`, `/interviews/new` at desktop width; login page too.
Expected: no visual or layout regression vs. `main` HEAD.

- [ ] **Step 3: Commit**

No code changed — nothing to commit.

---

### Task 4: 验收验证 M1 / M3（自动化部分）+ spec 状态更新

**Files:**
- Modify: `docs/superpowers/specs/2026-08-16-mobile-pwa-design.md` (status line)

**Interfaces:** — uses the artifacts from Tasks 1–2

Prerequisites: backend running (MySQL via docker, `cd backend && go run ./cmd/server` with `JWT_SECRET`; no DeepSeek key needed to view pages). Create a test account and at least one interview with a completed report via the UI so `/interviews/:id`, `/interviews/:id/room`, and `/interviews/:id/report` have data.

- [ ] **Step 1: Map acceptance to verification**

| ID | How verified |
|----|--------------|
| M1 | Step 2: 375×667 viewport walk — all routes operable, `scrollWidth <= innerWidth` |
| M2 | Manual real-device (Task 5) |
| M3 | Step 3: dist artifacts + preview SW registration + offline shell |
| M4 | Step 4: same account/data across viewports in one browser profile |
| M5 | Task 3 (desktop viewport smoke) |

- [ ] **Step 2: M1 — mobile viewport walk (375×667)**

Start `cd frontend && npm run preview`. Drive a Chromium browser (use the browser-use web-gui-tester skill, or a throwaway `npx playwright` script — do not add Playwright to `package.json`) with viewport 375×667.

For each route, log in as the test account and check: page renders, primary actions work (create → start → room; question-bank start practice; detail/report links), and no horizontal overflow:

```js
const doc = document.documentElement;
console.log(doc.scrollWidth, window.innerWidth, doc.scrollWidth <= window.innerWidth);
```

Routes to walk: `/login`, `/`, `/questions`, `/interviews/new`, `/interviews/:id`, `/interviews/:id/room`, `/interviews/:id/report`, `/trends`.
Expected: `scrollWidth <= innerWidth` on every route; all tappable targets ≥44px; no element visibly clipped at the right edge.

- [ ] **Step 3: M3 — manifest + SW + offline shell**

1. `dist/manifest.webmanifest` exists and its `name` is `模拟面试助手`, `display` is `standalone`, icons include 192/512 PNGs (already checked in Task 1 Step 8).
2. In the preview browser: open `/`, reload once, then check `navigator.serviceWorker.controller` is set and DevTools → Application → Service Workers shows an activated `sw.js`.
3. DevTools → Application → Manifest shows an installable manifest (no installability warnings).
4. With the app loaded, set DevTools Network → Offline, reload — the app shell (login page) renders.
Expected: all four checks pass. (Deep links offline are intentionally out of scope.)

- [ ] **Step 4: M4 — cross-viewport data parity**

In the same browser profile, verify with a desktop viewport (1280×800) and a 375×667 viewport that: the same account logs in on both, and the interview list, an interview detail, and its report show identical data (same IDs, same transcript, same scores).
Expected: identical — same backend, same JWT, same DB (spec §2).

- [ ] **Step 5: Update the spec status**

In `docs/superpowers/specs/2026-08-16-mobile-pwa-design.md`, change line 4:

```
**Status:** Draft for user review
```

to:

```
**Status:** Implemented on feat/v4-mobile-pwa
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-16-mobile-pwa-design.md
git commit -m "docs(v4): mark spec implemented"
```

---

### Task 5: 真机人工验证清单（M2 / M3 安装 / M4 真机）

**Files:** none (manual checklist; follow `docs/superpowers/plans/acceptance-checklist.md` conventions)

**Interfaces:** — requires real phones + LAN setup; **no backend code may be committed** from this task

- [ ] **Step 1: Prepare the LAN environment**

1. PC: `cd backend && go run ./cmd/server` (needs MySQL docker + `JWT_SECRET`; add Aliyun speech keys to enable ASR/TTS for M2).
2. Backend CORS: `allowedOrigins` in `backend/cmd/server/main.go:80-85` only lists localhost. A phone's requests carry `Origin: http://<PC-LAN-IP>:5173`, which the allowlist rejects. For real-device testing **temporarily** add `"http://<PC-LAN-IP>:5173": true,` to that map, verify, and **revert before committing** (spec §2: zero backend changes; never commit this line).
3. Frontend: `cd frontend && VITE_API_BASE=http://<PC-LAN-IP>:8080 npm run build && npm run preview -- --host` — the phone opens `http://<PC-LAN-IP>:4173`. (The WS origin derives from `VITE_API_BASE` — see `frontend/src/ws/interviewSocket.ts`.)
4. Same Wi-Fi on PC and phone; PC firewall allows 4173/8080.

- [ ] **Step 2: M2 — voice interview on a real phone**

| Check | How |
|-------|-----|
| TTS 播报 | Create a voice-mode interview on the phone; interviewer question is read aloud; 静音/重播/跳过 work |
| 按住说话 → ASR → 自动发送 | Hold the (now full-width) record button; recording → transcript → auto-send; turn appears in transcript |
| iOS `getUserMedia` | Requires a secure context: `http://<LAN-IP>` blocks the microphone on iOS Safari **and** Android Chrome. Use an HTTPS tunnel (e.g. `cloudflared tunnel --url http://localhost:4173` with `VITE_API_BASE` pointing at an HTTPS backend tunnel), or on Android enable `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with `<LAN-IP>` and `http://<PC-LAN-IP>:8080` for testing. Document the result in the checklist. |

- [ ] **Step 3: M3 — install on device**

Chrome/Edge Android: open `http://<PC-LAN-IP>:4173` → menu → 添加到主屏幕 → open from home screen → renders standalone (no browser chrome), data loads with the backend reachable.
iOS Safari: 分享 → 添加到主屏幕 (works over HTTP; the app shell opens standalone; live data/voice still subject to the secure-context note in Step 2).

- [ ] **Step 4: M4 — on-device data parity**

Log into the phone with the same account used on desktop; confirm the interview list, a detail page, and its report match the desktop exactly.

- [ ] **Step 5: Revert the CORS edit and finalize**

Remove the temporary `allowedOrigins` entry; `git diff backend/` must be empty. Record results in `docs/superpowers/plans/acceptance-checklist.md` (append a V4 section with PASS/PARTIAL/BLOCKED + notes).

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §2 locked decisions (PWA + 响应式 + 全功能 + 零后端改动) | Global constraints; T1–T5 |
| §3 non-goals (无后端 API 改动 / 无原生能力 / 无独立前端 / 仅壳离线) | T1 workbox root-only fallback; no backend files touched |
| §4 responsive table (顶栏→标签栏、卡片、房间、表单、评分卡) | T2 (tab bar, stacked cards, room controls, form widths) |
| §5 PWA (manifest 名称/图标/standalone/主题色、SW 预缓存、添加到主屏幕、localhost SW) | T1, T4 M3, T5 |
| §6 M1–M5 | T4 (M1/M3/M4/M5), T5 (M2 + 真机 M3/M4) |
| §7 notes (改现有 frontend、media query + token、vite-plugin-pwa、voiceRecorder iOS 兼容、Playwright 375×667、真机人工、branch feat/v4-mobile-pwa) | T1/T2 (branch, tokens, plugin), T4 (viewport), T5 (manual) |

## Placeholder scan

All steps contain concrete code, exact file locations, or commands; no TBD markers. Two things an implementer must confirm at edit time (not plan gaps): the exact line numbers in the 7 page files may shift if main moves after V3 merges (Task 2 Step 4 gives a grep-based fallback for ReportPage and the `</main>` anchor for all), and ReportPage's `</main>`/`</div>` positions should be located with `grep -n`.

## Type consistency

- `MobileTabBar` default export used consistently as `import MobileTabBar from '../components/MobileTabBar'` in all 7 pages.
- `registerSW` imported from `virtual:pwa-register` in `main.tsx`; typed via `tsconfig.app.json` `types` (`vite-plugin-pwa/client`).
- CSS classes referenced by JSX (`mobile-tabbar`, `mobile-tabbar-item`, `is-active`) defined in `mobile.css`; all overrides scoped `.interview-page`/`.auth-page`.
- Icon filenames in `vite.config.ts` manifest (`/pwa-192x192.png`, `/pwa-512x512.png`), `index.html` apple-touch-icon, and the generator output paths all agree.
