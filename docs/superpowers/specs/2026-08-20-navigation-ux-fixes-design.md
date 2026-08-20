# 导航体验梳理与修复设计

日期：2026-08-20
状态：已获用户批准（含两个可选项）

## 背景与问题

用户反馈：页面跳转感觉奇怪、容易"懵"，存在不必要的跳转。典型例子：面试详情页和报告页都有「存入题库」按钮，但报告页不展示任何题目，按钮孤立且多余。

### 问题清单

1. **报告页「存入题库」缺上下文**：按钮孤悬页面顶部，页面本身无题目；与详情页功能重复。且面试结束后用户被自动带到报告页（而非详情页），移动端报告页又没有任何入口能到详情页——直接删按钮会让移动端用户无法存题。
2. **报告页 ↔ 详情页导航不对称**：桌面端报告页 header 有「详情」链接，但移动端 header 链接全部隐藏，报告页在手机上到不了详情页。
3. **详情页三处「返回列表」**（桌面端）：品牌 logo、header「返回列表」、正文「← 全部面试」都指向 `/`。
4. **面试进行中可随意跳走**：面试间 header 有「详情」链接，移动端 TabBar 完整可用——中途点出去会断开 WebSocket、关闭腾讯数智人会话。
5. **列表页行内重复入口**：行标题和「详情」按钮指向同一页面。
6. **成长分析跳转路径绕**：折线点 → 详情页 →（再点一次「查看报告」）→ 报告页。
7. **题库分组与趋势页方向不一致**：趋势页折线点可跳面试，题库分组头「面试 #N」不可点击。
8. **死代码**：`frontend/src/pages/HomePage.tsx` 未被任何路由引用。

## 方案选择

- **方案 A（采纳）**：抽共享导航组件 `AppNav`，7 个页面的 header + TabBar 统一由它渲染，页面只声明上下文动作。根治"每页手写 header 导致的不一致"。
- 方案 B（放弃）：各页面最小改动，逻辑仍分散，易再分叉。

## 设计

### 1. 共享导航组件 `AppNav`

新建 `frontend/src/components/AppNav.tsx`，替代各页面手写 header 与 `MobileTabBar` 的使用方式。

```tsx
type NavTab = 'interviews' | 'questions' | 'trends' | 'create';
type NavAction = { to: string; label: string; variant?: 'link' | 'cta' };

<AppNav
  tab={NavTab}                    // 移动端 TabBar 高亮 + 当前页判定
  actions={NavAction[]}           // 桌面 header 动作
  confirmLeave?: boolean          // 面试间专用：离开前弹确认
/>
```

**桌面 header 统一规则**：
- 品牌 logo（→ `/`）始终显示；
- 「题库」「成长分析」为全局动作，非当前页时显示为链接；
- 当前页自身不重复显示为链接（题库页不显示"题库"链接，用高亮文字占位）；
- 页面上下文动作由 `actions` 提供（如列表页的「新建面试」CTA、报告页的「详情」）；
- 「退出登录」按钮在所有页面保留（移动端现有 CSS 不隐藏 button，行为不变）；由 `AppNav` 内部通过 `useAuth` 统一渲染，各页面不再传。

**移动 TabBar**：保持现有 4 项（面试/题库/成长分析/新建）与现有高亮样式；active 状态由 `tab` 判定。

**`confirmLeave` 实现**：当 `confirmLeave` 为 true，组件内所有会离开当前页的链接（header 动作 + TabBar 项）在 onClick 中 `preventDefault` 并 `window.confirm('离开将中断本场面试，确定离开吗？')`，确认后 `navigate(to)`。

**组件内部结构**：header 部分用 `<header className="interview-header">` 保持现有样式类（复用 `InterviewPages.css`），TabBar 部分沿用 `MobileTabBar` 的类名与样式（`mobile.css` 中 `.interview-page .interview-header-actions a { display:none }` 等规则继续生效）。`MobileTabBar.tsx` 可保留作为 AppNav 的内部实现或删除由 AppNav 内联。

### 2. 报告页（ReportPage.tsx）

- **删除**：顶部「存入题库」按钮、`savingToBank` / `bankMessage` / `bankError` 状态、`questionCount` 状态及其加载逻辑（不再需要 `getInterview` 调用——仅用于取题数）、`importQuestionsFromSession` 导入与 `handleSaveToBank`。
- **新增**：页面顶部（`<h1>面试报告</h1>` 之后、状态区之前）操作行「查看本场对话 →」，链接到 `/interviews/${id}`。报告生成中（`available === false`）与生成后均显示，保证移动端可达详情页。
- **header**：`actions` 含「详情」（→ `/interviews/${id}`），替代现有手写「详情」链接。
- 保留：「← 全部面试」返回链接、报告轮询、重试按钮、反馈展示。

### 3. 详情页（InterviewDetailPage.tsx）

- header 的 `actions` 不再含「返回列表」（去掉重复项）；保留品牌 logo 与正文「← 全部面试」。
- 「存入题库」按钮保留在对话记录上方（`interview-list-links` 区，有完整对话上下文）。
- 「继续面试」（in_progress）/「查看报告」（completed）不变。
- header 现有「题库 / 成长分析」改为走 `AppNav` 全局动作。

### 4. 列表页（InterviewListPage.tsx）

- `InterviewRow` 行内**删除「详情」按钮**：行标题本身即详情链接（点击区更大）。行内仅保留「进入面试」（in_progress）/「报告」（completed）。
- header 的「新建面试」CTA 走 `actions`（variant: 'cta'）。

### 5. 面试间（InterviewRoomPage.tsx）

- 改用 `AppNav`，`confirmLeave: true`。header `actions` 含「返回列表」「详情」。
- 「结束面试」按钮（`handleForceEnd`）增加 `window.confirm('确定结束面试并生成报告吗？')` 确认，防误触（与 V18 room UX 计划一致）。
- 场内控制（静音/重播/跳过/结束）不变。

### 6. 成长分析（TrendsPage.tsx）

- 折线点点击从 `/interviews/${payload.session_id}` 改为 `/interviews/${payload.session_id}/report`（点分数直接看报告，少一跳）。

### 7. 题库（QuestionBankPage.tsx）

- 分组头「面试 #N」后新增「查看 →」链接，指向 `/interviews/${sessionId}`；无来源分组（"独立题目"）不显示链接。
- 链接放在分组头内「面试 #N」标题之后、「全选」复选框之前（`question-group-toggle` 与 `question-group-select-all` 之间的一个 `interview-inline-link`），不改变现有展开/收起交互。

### 8. 清理

- 删除 `frontend/src/pages/HomePage.tsx`（未被路由引用）及其 `HomePage.css`（确认无其他引用后一并删除）。

## 导航矩阵（验收依据）

| 页面 | 桌面 header 动作 | 移动 TabBar | 正文入口 |
|---|---|---|---|
| 列表 `/` | 题库、成长分析、新建面试(CTA)、退出 | 面试(active)、题库、成长分析、新建 | 行标题→详情；进入面试/报告 |
| 题库 `/questions` | 面试列表、成长分析、退出（题库为高亮文字） | 面试、题库(active)、成长分析、新建 | 分组展开、开始练习；分组头查看→详情 |
| 新建 `/interviews/new` | 题库、成长分析、返回列表、退出 | 面试、题库、成长分析、新建(active) | 表单 |
| 详情 `/interviews/:id` | 题库、成长分析、退出 | 面试、题库、成长分析、新建 | ←全部面试；继续面试/查看报告/存入题库；对话 |
| 面试间 `/:id/room` | 返回列表*、详情*、成长分析、退出 | 面试*、题库*、成长分析*、新建*（*均带离开确认） | 场内控制；结束面试(带确认) |
| 报告 `/:id/report` | 题库、成长分析、详情、退出 | 面试、题库、成长分析、新建 | ←全部面试；查看本场对话→详情 |
| 成长分析 `/trends` | 面试列表、题库、退出（成长分析为高亮文字） | 面试、题库、成长分析(active)、新建 | 折线点→报告页 |

移动端（<600px）header 链接隐藏规则不变；「查看本场对话」等正文入口保证移动端页面间互通。

## 验证

1. `cd frontend && npm run build`（tsc + vite build）通过，无未使用导入/类型错误。
2. 按导航矩阵在桌面与移动视口逐页走查：
   - 任意两页之间往返可达；
   - 无重复出口（如详情页只有一处"返回列表"语义入口）；
   - 面试间点击任何离开链接必弹确认；
   - 报告页无「存入题库」按钮，详情页保留。
3. 报告页在报告未生成（生成中/失败）状态下「查看本场对话」仍可用。
