# 成长分析跳转报告页的来源感知 — 设计文档

日期：2026-08-20 · 版本：v1

## 背景与目标

成长分析页（`/trends`）的得分趋势图节点可点击，跳到对应面试的报告页（`/interviews/{id}/report`）。但报告页无来源感知，从成长分析进来的用户看到的返回链接仍是「← 全部面试」，应返回成长分析页。

目标：报告页能感知来源，从成长分析进来时返回链接改为「← 返回成长分析」、顶部导航高亮「成长分析」。其他入口（列表「看报告」、房间结束自动跳转）行为不变。

## 现状

| 文件 | 位置 | 行为 |
| --- | --- | --- |
| `TrendsPage.tsx` | :200 | 节点点击 `navigate(\`/interviews/${payload.session_id}/report\`)` |
| `ReportPage.tsx` | :140 | `<AppNav tab="interviews" />` |
| `ReportPage.tsx` | :142-144 | 返回链接「← 全部面试」→ `/` |
| `detailSource.ts` | 全局 | 现有 `detailSourceFrom`/`isFromQuestions`（question-bank 专用） |

## 改动设计

### 1. 来源检测函数泛化（`frontend/src/lib/detailSource.ts`）

将 `DetailSource` 联合扩展为 `'list' | 'questions' | 'trends'`，并把 `detailSourceFrom` 的 if-chain 改为对象查找（最终审查建议，避免第 3 个来源时 ternary 失控）：

```ts
export type DetailSource = 'list' | 'questions' | 'trends';

const SOURCE_TO_DETAIL: Record<string, DetailSource> = {
  questions: 'questions',
  trends: 'trends',
};

export function detailSourceFrom(from: string | null): DetailSource {
  return from ? SOURCE_TO_DETAIL[from] ?? 'list' : 'list';
}

export function isFromQuestions(from: string | null): boolean {
  return detailSourceFrom(from) === 'questions';
}

export function isFromTrends(from: string | null): boolean {
  return detailSourceFrom(from) === 'trends';
}
```

现有 `isFromQuestions` 调用方（`InterviewDetailPage.tsx`）不受影响（行为与签名不变）。

### 2. 成长分析页 `TrendsPage.tsx`

节点点击跳转（:200）加来源参数：

```tsx
onClick={() => navigate(`/interviews/${payload.session_id}/report?from=trends`)}
```

### 3. 报告页 `ReportPage.tsx`

- 引入 `useSearchParams`，读取 `const from = searchParams.get('from')`，计算 `const fromTrends = isFromTrends(from)`。
- 当 `fromTrends` 为真时：

  | 元素 | 现状 | 改为 |
  | --- | --- | --- |
  | 返回链接（:142-144） | 「← 全部面试」→ `/` | 「← 返回成长分析」→ `/trends` |
  | AppNav `tab`（:140） | `"interviews"` | `"trends"` |

- 其他入口（无 `from` 参数）行为不变。

## 非目标

- 不改后端。
- 不改成长分析页布局。
- 不改 AppNav 组件本身。
- 不做除成长分析外的其他来源感知（后续可扩展）。
- 不改报告页内容与重试逻辑。

## 验收标准

- [ ] 成长分析页节点跳转链接带 `?from=trends`
- [ ] 从成长分析进报告页：返回链接为「← 返回成长分析」，点击回 `/trends`
- [ ] 从成长分析进报告页：顶部导航高亮「成长分析」
- [ ] 从列表/房间进报告页：行为与现状一致（「← 全部面试」、高亮「面试」）
- [ ] 现有 `detailSource` 测试全部通过（含新增 `isFromTrends` 测试）
- [ ] `npm test`、`npm run build` 通过
