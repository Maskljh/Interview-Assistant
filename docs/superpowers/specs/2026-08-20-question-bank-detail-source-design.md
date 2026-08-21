# 题库分组「查看」跳转详情页的来源感知 — 设计文档

日期：2026-08-20 · 版本：v1

## 背景与目标

题库页每个分组题库头部有「查看」链接，点击后跳到面试详情页（`/interviews/{id}`）。但详情页无来源感知，从题库进来的用户看到的是与从列表进来完全相同的页面，导致两个问题：

1. **多了一个「存入题库」按钮**——用户本来就在题库里，再"存入题库"没有意义。
2. **返回链接错误**——显示「← 全部面试」并返回 `/`，但用户是从题库页来的，应返回 `/questions`。

目标：详情页能感知来源，从题库进来时隐藏「存入题库」、返回链接改为「← 返回题库页」、顶部导航高亮「题库」。

## 现状

| 文件 | 位置 | 行为 |
| --- | --- | --- |
| `QuestionBankPage.tsx` | :283-288 | 分组「查看」链接 `to="/interviews/${sessionId}"` |
| `InterviewDetailPage.tsx` | :97-99 | 返回链接「← 全部面试」→ `/` |
| `InterviewDetailPage.tsx` | :126-153 | 含「存入题库」按钮（`interview.questions.length > 0` 时显示） |
| `InterviewDetailPage.tsx` | :95 | `<AppNav tab="interviews" />` |

## 改动设计

### 1. 题库页 `QuestionBankPage.tsx`

「查看」链接的 `to` 改为：

```tsx
to={`/interviews/${sessionId}?from=questions`}
```

### 2. 详情页 `InterviewDetailPage.tsx`

- 引入 `useSearchParams`（react-router-dom），读取 `const from = searchParams.get('from')`。
- 计算 `const fromQuestions = from === 'questions'`。
- 当 `fromQuestions` 为真时：

  | 元素 | 现状 | 改为 |
  | --- | --- | --- |
  | 「存入题库」按钮（:143-152） | 显示 | **隐藏**（`fromQuestions &&` 前置门控） |
  | 返回链接（:97-99） | `← 全部面试` → `/` | `← 返回题库页` → `/questions` |
  | AppNav `tab`（:95） | `"interviews"` | `"questions"` |

- 从其他入口（列表页等）进入时行为完全不变。

## 非目标

- 不改后端。
- 不改题库页布局。
- 不做其他来源（如报告页）的来源感知。
- 不改 AppNav 组件本身。

## 验收标准

- [ ] 题库页分组「查看」链接带 `?from=questions`
- [ ] 从题库进详情页：无「存入题库」按钮
- [ ] 从题库进详情页：返回链接为「← 返回题库页」，点击回 `/questions`
- [ ] 从题库进详情页：顶部导航高亮「题库」
- [ ] 从列表进详情页：行为与现状一致（有存入题库、返回「← 全部面试」、高亮「面试」）
- [ ] `npm test`、`npm run build` 通过
