# V6 简历 × JD 匹配度预检 — 设计规格

**Date:** 2026-08-16  
**Status:** Implemented on feat/v6-precheck
**Parent:** V1 MVP + V2 题库/语音/成长 + V3 画像出题 + V4 手机端 PWA + V5 面试官人格  
**Approach:** 新建面试页可选「匹配度检测」，LLM 即时输出匹配分与差距项；差距项随创建持久化，Start 出题时作为即时画像注入

---

## 1. Goal

面试开始前，让用户先了解自己简历与目标 JD 的匹配程度和差距，并有针对性地练习：预检结果展示在新建页，其差距项随会话持久化并在出题时注入，引导面试官针对匹配短板提问。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 触发时机 | **手动按钮**：JD/简历填好后点「匹配度检测」，不自动触发 |
| 结果用途 | **展示 + 注入出题**：结果卡片展示；差距项随创建持久化，Start 出题时注入（即时画像，与 V3 历史画像的 weak 注入并列） |
| 结果传递 | **随创建持久化**：前端点开始面试时把检测得到的 gaps 提交 create，存 `interview_sessions.precheck_gaps`，Start 出题读取；不重复调用 LLM |
| 无简历 | **允许**：未传简历也可检测，prompt 输出岗位能力要点与练习建议，gaps 退化为 JD 要点 |
| 注入范围 | 仅**出题**（`GenerateQuestionsUser`）；追问与报告不变 |
| 兼容性 | `precheckGaps` 为空 → prompt 输出与现状**逐字节一致** |
| 执行顺序 | 分支 `feat/v6-precheck` from main HEAD（V4/V5 已合并） |

---

## 3. Non-goals (V6)

- 自动触发 / 页面加载即检测
- 预检结果影响追问决策或评分报告
- 历史会话的 gaps 回填 / 迁移改写
- 检测结果缓存 / 多次检测历史（每次检测是即时诊断，无新表，仅存到当次会话）

---

## 4. Data model

迁移 `005_precheck.sql`（沿用 003/004 先例）：

```sql
ALTER TABLE interview_sessions
  ADD COLUMN precheck_gaps JSON NULL AFTER persona;
```

`Session` 结构体加 `PrecheckGaps []string`；session JSON 响应（详情/创建/列表）带 `precheck_gaps` 字段（空为 `null` 或省略）。

---

## 5. LLM 预检（`llm` 包，新增 prompt）

### 5.1 `PreCheckSystem()`

```go
func PreCheckSystem() string
```

输出严格 JSON schema（无 markdown fences）：

```json
{"match_score":0,"gaps":["..."],"suggestions":["..."]}
```

规则：
- `match_score`：0–100 整数，简历对 JD 的整体匹配度
- `gaps`：简历与 JD 之间的具体差距（如缺某项技能、经验不足），非空数组
- `suggestions`：可执行的补足/准备建议，非空数组

### 5.2 `PreCheckUser(jobJD, resume string)`

含 JD 与简历原文。**简历缺失时 prompt 注明**「未提供简历：输出该岗位的核心能力要点作为 gaps、练习建议作为 suggestions，match_score 给出该岗位的基础难度参考」。

---

## 6. 预检 API（新模块 `internal/precheck`）

- `type Service struct { llm llm.Client }`；`func NewService(llmClient llm.Client) *Service`
- `type PreCheckOut struct { MatchScore int `json:"match_score"`; Gaps []string `json:"gaps"`; Suggestions []string `json:"suggestions"` }`
- `func (s *Service) Check(ctx context.Context, jobJD, resume string) (PreCheckOut, error)` — 调 `llm.ChatJSON(PreCheckSystem(), PreCheckUser(jobJD, resume), &out)`；`jobJD` 为空 → 校验失败
- `func RegisterRoutes(r *gin.Engine, llmClient llm.Client, secret string)` — **`POST /api/precheck`**，JWT 保护，body `{"job_jd": "...", "resume_text": "..."}`；LLM 失败 → 502 `{"error":"precheck failed"}`；`job_jd` 缺失 → 400
- 不涉及数据库，纯即时诊断

---

## 7. 随创建持久化 + Start 注入

### 7.1 迁移与模型

`005_precheck.sql` 见 §4；`Session.PrecheckGaps []string`（读取时 JSON 列反序列化，NULL → 空 slice）。

### 7.2 Create / CreateFromBank

`createRequest` / `fromBankRequest` 加可选 `precheck_gaps []string`（不校验内容，空 → NULL）；`Create`/`CreateFromBank` 签名追加 `precheckGaps []string`；repo INSERT 写入 JSON 列（用 `json.Marshal`，空 slice 存 NULL）。

### 7.3 出题注入

`GenerateQuestionsUser(jobJD, resume, mode string, weak []string, persona string, precheckGaps []string)` — 第 6 参数。`precheckGaps` 非空时在 prompt 追加：

```
Targeted focus (pre-check): the candidate's JD-match gaps are {gap1, gap2}. Include questions that probe these gaps.
```

与 weak、persona 的注入段**共存**（各段独立追加，顺序：weak → persona → precheck），互不干扰；为空 → 输出与现状逐字节一致。`Start` 出题传 `session.PrecheckGaps`。`DecideNextUser` 不变。

---

## 8. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| `CreateInterviewPage` | JD 输入框下方「匹配度检测」按钮 + 结果卡片；开始面试时把刚检测的 gaps 提交 `precheck_gaps` |
| 其他页面 | 不变 |

**交互：**
- 按钮：点击 → 加载态（「正在检测…」）→ 成功显示结果卡片；失败显示错误文案（不阻断正常创建）
- 结果卡片：`match_score` 分数（如「匹配度 72 / 100」）+ gaps 列表（「差距」）+ suggestions 列表（「建议」）
- **不检测 → 不带 `precheck_gaps`**（会话以常规方式出题）
- 检测后修改 JD/简历 → 结果视为过期，前端提示「JD/简历已修改，建议重新检测」（重新检测后才可提交新 gaps；或提交时以当前页面文本重新检测，二选一，实施时取更简单的）

---

## 9. Acceptance

| ID | Expectation |
|----|-------------|
| Q1 | `POST /api/precheck` 返回 match_score + gaps + suggestions；`job_jd` 缺失 → 400；LLM 失败 → 502 |
| Q2 | 无简历也能检测（prompt 含「未提供简历」分支） |
| Q3 | create 持久化 `precheck_gaps`；空 → NULL；响应带回字段 |
| Q4 | `GenerateQuestionsUser` 带 gaps 时注入 pre-check 指令；空 gaps 输出与现状逐字节一致；与 weak/persona 注入共存 |
| Q5 | Start 出题使用会话已存的 gaps（无重复 LLM 调用） |
| Q6 | 前端：按钮 + 结果卡片渲染；带 gaps 创建成功；不检测时创建行为与现状一致 |
| Q7 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |

---

## 10. Implementation notes

- Backend: `internal/precheck`（service.go + handler.go + 测试）；`llm/prompts.go` 新增两个函数 + `GenerateQuestionsUser` 第 6 参数；`interview` 的 models/repo/service/handler 加 `precheck_gaps`
- 迁移：`backend/migrations/005_precheck.sql`
- `main.go`：`precheck.RegisterRoutes(r, llmClient, cfg.JWTSecret)`（放 `analysis.RegisterRoutes` 附近）
- Tests: llm prompt 单测（含/不含简历、gaps 注入、与 weak/persona 共存）；precheck handler 测试（fake LLM）；interview create 持久化 + Start 注入测试（fake LLM）
- Prefer branch `feat/v6-precheck` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（手动触发、展示+注入、随创建持久化、无简历允许、仅出题）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除自动触发/影响追问报告/历史回填
- [x] 兼容性语义显式（空 gaps → 逐字节一致）；无简历分支、JSON 列 NULL 语义有说明
