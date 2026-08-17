# V7 错题本专项训练（薄弱维度组卷）— 设计规格

**Date:** 2026-08-17  
**Status:** Implemented on feat/v7-focused-practice
**Parent:** V1 MVP + V2 题库/语音/成长 + V3 画像出题 + V4 PWA + V5 人格 + V6 匹配预检  
**Approach:** 题库题目打维度标签（LLM 自动分类），新建页画像卡一键按薄弱维度从题库组卷开练

---

## 1. Goal

把 V3 的定向出题做成完整闭环：题库题目有维度标签，用户从画像卡一键发起「只练薄弱维度」的专项面试（从题库按维度筛题组卷，优先收藏题），无需手动选题目。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 专项机制 | **题库维度组卷**：题目打四维标签，按薄弱维度筛选组卷，from-bank 开练 |
| 维度标签来源 | **LLM 自动分类**：ImportFromSession 导入题库时 LLM 一次性批量分类（一次调用）；分类失败降级（题目照常入库，dimension 为 NULL） |
| 入口 | **画像卡一键组卷**：新建页画像卡（有薄弱维度时）显示「针对薄弱点开始练习」按钮；题库页同步加维度筛选 |
| 组卷规则 | 每个薄弱维度取至多 N 题（默认 5，优先 starred，按 created_at DESC），总题数 ≤ 10；不足时取可用的 |
| from-bank 约束 | 保持**不走 LLM 出题**（组卷是筛选已有题库，非生成） |
| 无对应题目 | 提示「题库中没有该薄弱维度的题目，建议先导入」，不创建会话 |
| 兼容性 | 存量题目 dimension 为 NULL：列表不受影响（维度筛选时被过滤）；专项组卷只含已打标题 |
| 执行顺序 | 分支 `feat/v7-focused-practice` from main HEAD |

---

## 3. Non-goals (V7)

- 手动编辑题目维度（导入时 LLM 自动分类；不做编辑 UI）
- 报告 weaknesses 文本 → 题目的追溯映射
- 专项练习会话的特殊 UI（复用现有面试房间）
- 按维度管理题库的批量操作（删除/收藏按维度）

---

## 4. Data model

迁移 `006_question_dimension.sql`（沿用先例）：

```sql
ALTER TABLE question_bank
  ADD COLUMN dimension VARCHAR(16) NULL AFTER job_tag;
```

- `dimension` ∈ `expression | logic | content | job_match`，NULL 表示未分类（存量/分类失败）
- `Item` 结构体加 `Dimension *string`；列表/详情响应带 `dimension` 字段
- 索引：专项组卷查询 `(user_id, dimension)` 低频（用户点按钮时），不强制加索引；若实现中发现查询热点再加

---

## 5. LLM 维度分类

### 5.1 prompt（`llm` 包）

```go
func ClassifyDimensionsSystem() string
func ClassifyDimensionsUser(questions []string) string
```

- 输出严格 JSON：`{"classifications":[{"question":"...","dimension":"logic"}]}`（question 原文回显，dimension ∈ 四维之一）
- 无法归类时 dimension 用 `"content"`（内容质量兜底）或允许模型选最接近的一维

### 5.2 接入 ImportFromSession

- `question.Service` 增加 `llm llm.Client` 字段（`NewService` 与 `RegisterRoutes` 加参数）
- ImportFromSession 导入成功后：LLM 批量分类这批题 → 按 `question` 原文回显映射 → `UPDATE question_bank SET dimension = ? WHERE id = ?`（每题一次 UPDATE 或批量）
- **失败降级**：LLM 调用出错 → 题目照常入库（dimension NULL），不阻塞导入、不报错给用户
- 逐题更新用事务或循环均可，量小（≤8 题）

---

## 6. 专项组卷接口

### 6.1 `GET /api/questions?dimension=logic`（扩展既有列表）

- `ListFilter` 加 `Dimension string`；repo `List` 的 WHERE 条件在 `dimension` 非空时加 `AND dimension = ?`

### 6.2 `POST /api/question-bank/focused`（新接口，供一键组卷）

JWT 保护。请求：

```json
{ "dimensions": ["logic", "expression"], "limit_per_dimension": 5 }
```

- `dimensions` 非空（否则 400）；`limit_per_dimension` 默认 5，范围 1–10
- 每个维度：取该用户 `starred = 1` 优先、`created_at DESC` 的至多 N 题；若 starred 不足 N 题，补非 starred 的至多 N 题
- 总题数 ≤ 10
- 响应：`{"items":[{...Item}]}`（含 ID，前端直接取 ID 列表调 from-bank）
- 无任何匹配 → 200 + 空 `items`

---

## 7. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| `CreateInterviewPage` 画像卡 | 有 `weak_dimensions` 时显示「针对薄弱点开始练习」按钮 |
| `QuestionBankPage` | 筛选区加「维度」下拉（全部/四维），触发列表刷新 |
| `api/questions.ts` | `Item` 类型加 `dimension`；`listQuestions` 支持 `dimension` 参数；`fetchFocusedQuestions` |
| `api/interviews.ts` | 无改动（复用 from-bank） |

**一键组卷流程（CreateInterviewPage）：**
1. 点击「针对薄弱点开始练习」→ `POST /api/question-bank/focused`（dimensions=weak_dimensions，每维 5 题）
2. 返回空 → 提示「题库中没有该薄弱维度的题目，建议先导入」；不创建
3. 返回有题 → `POST /api/interviews/from-bank`（question_ids + 当前 input_mode + persona）→ 跳转房间
4. 加载态与错误提示；按钮仅在有薄弱维度时显示

**题库页维度筛选：** 下拉选择维度 → `listQuestions({ dimension })` 刷新；保持既有筛选（starred/job_tag/query）组合可用

---

## 8. Acceptance

| ID | Expectation |
|----|-------------|
| R1 | ImportFromSession 后题库题目带 dimension（LLM 分类成功时）；分类失败 → 题目照常入库、dimension NULL，导入不报错 |
| R2 | `GET /api/questions?dimension=X` 只返回该维度题目 |
| R3 | `POST /api/question-bank/focused` 按维度组卷：starred 优先、每维 ≤N、总 ≤10；空维度/非法参数 → 400 |
| R4 | 画像卡「针对薄弱点开始练习」：有题 → 创建 from-bank 会话跳转；无题 → 提示不创建 |
| R5 | 题库页维度筛选生效，与既有筛选组合可用 |
| R6 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |
| R7 | from-bank 路径不出题（无 LLM 出题调用）——存量行为不变 |

---

## 9. Implementation notes

- Backend: `llm/prompts.go`（两个分类函数）；`question` 包（models/repo/service/handler：dimension 列、List 过滤、focused 接口、ImportFromSession 接 LLM）
- `question.RegisterRoutes` 签名加 `llmClient`（main.go 同步）；`question.NewService(db, llmClient)`
- 迁移 `006_question_dimension.sql`
- `interview` 包无改动（from-bank 已支持 question_ids；画像卡组卷走既有 CreateFromBank）
- Tests: llm 分类 prompt 单测；question 集成测试（分类成功/失败降级、List 维度过滤、focused 组卷 starred 优先与数量上限）；前端 build
- Prefer branch `feat/v7-focused-practice` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（题库组卷、LLM 自动分类、画像卡入口、失败降级、from-bank 不出题）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除手动编辑/weakness 追溯/专项 UI
- [x] 存量题目兼容（NULL 维度）、组卷规则（starred 优先/数量上限）、降级语义显式
