# V3 针对性出题（用户画像）— 设计规格

**Date:** 2026-08-16  
**Status:** Draft for user review  
**Parent:** V1 MVP + V2-A 题库 + V2-B 语音 + V2-C 成长分析  
**Approach:** 独立 `internal/profile` 画像模块 + JD 出题时按薄弱维度定向分配

---

## 1. Goal

根据用户**历史面试评分的自动画像**，在 JD 即时出题时针对薄弱维度定向分配题量，帮助用户重点练习短板。开面流程与交互不变，仅影响题目生成。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 画像来源 | 历史已完成面试 `feedback_json` 四维评分**自动计算**，无需用户手动填写 |
| 出题机制 | **生成时定向分配**：LLM prompt 注入薄弱维度，强调题量分配；题目不打结构化维度标签 |
| 展示 | 新建面试页顶部展示画像卡；**无历史数据自动降级**为通用出题 |
| 画像范围 | 最近 5 场 completed 且有 feedback 的面试；四维均值最低的维度为薄弱点（最多 2 个） |
| 架构 | 独立 `internal/profile`（含 API + 计算逻辑），`interview.Start` 出题时查询注入 |
| 数据 | 复用 `interview_sessions.feedback_json`，**无新表** |

---

## 3. Non-goals (V3)

- 题目打维度标签 / 结构化维度标注输出
- 题库组卷（from-bank）按维度筛选（题库无维度字段）
- 手动编辑画像 / 用户自选薄弱点
- LLM 生成画像说明文字（仅展示薄弱维度名）
- 简历画像 / 岗位画像（仅评分画像）

---

## 4. Data model

无新表、无迁移。复用 `interview_sessions.feedback_json`（嵌套结构 `dimensions: {expression, logic, content, job_match}`，与 V2-C 相同）。

---

## 5. Profile 计算规则

**输入：** `userID`

**步骤：**
1. 取该用户最近 **5 场** `status='completed'` 且 `feedback_json` 可解析的面试，按 `created_at DESC`
2. 四维各自取这 ≤5 场的**均值**（每场 0–100 分）
3. 计算四维均值的中位数或平均线：取四个维度的**平均分**
4. 薄弱维度 = 维度均值 **低于四维平均分** 的维度，按差距降序，**最多取 2 个**
5. 无任何可解析场次 → 空画像

**输出：**
```json
{
  "weak_dimensions": ["logic"],
  "based_on_sessions": 5
}
```
- `weak_dimensions` ∈ `[]string`，值为 `expression | logic | content | job_match`
- `based_on_sessions` = 实际参与计算的场次数（0–5）
- 空画像：`{ "weak_dimensions": [], "based_on_sessions": 0 }`

---

## 6. API

### 6.1 `GET /api/profile`

需 JWT；仅当前用户。

Query 参数（可选）：`sessions=N` — 画像窗口场次数，默认 5，范围 1–10。

**响应：** 见 §5 输出。无历史 → 200 + 空数组。

---

## 7. 出题注入

`interview.Service.Start`（`backend/internal/interview/service.go:168`）出题调用：

```go
llm.GenerateQuestionsSystem(), llm.GenerateQuestionsUser(session.JobJD, resume, string(session.Mode))
```

**改造：**
1. `Start` 先调 `profile.Service.Weaknesses(ctx, userID)`（空画像返回空 slice，不阻塞出题）
2. `llm.GenerateQuestionsUser(jobJD, resume, mode string, weak []string)` 增加第四个参数
3. `weak` 非空时，prompt 追加：

```
Targeted focus: this user's weak dimensions are {逻辑结构, 表达能力}. Generate at least half of the questions to assess these weak dimensions.
```

4. 维度中文名映射：`expression→表达能力`, `logic→逻辑结构`, `content→内容质量`, `job_match→岗位匹配`（放 profile 模块或 llm 包，单一来源）

**不变：** `GenerateQuestionsSystem` 的 5–8 题规则、JSON schema、`from-bank` 路径（不走 LLM，不注入）。

---

## 8. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| `CreateInterviewPage` | 顶部画像卡 |
| `QuestionBankPage` | 不变（from-bank 不走画像） |

**画像卡（`CreateInterviewPage` 顶部，JD 输入框上方）：**
- 有画像：「针对性出题已开启：根据你最近 N 场面试，薄弱点是【逻辑结构】」
- 无画像（based_on_sessions=0）：「暂无历史画像，将按通用方式出题」
- 加载失败：不显示卡片（静默降级，不阻断开面）

前端进入新建页时 `GET /api/profile`，仅展示，不参与提交。

---

## 9. Acceptance

| ID | Expectation |
|----|-------------|
| P1 | 有历史评分的用户画像正确：薄弱维度为四维均值低于平均线的维度（≤2 个） |
| P2 | 无历史数据返回空画像，前端显示降级文案 |
| P3 | `Start` 出题时注入薄弱维度；无画像时不注入（prompt 与旧版一致） |
| P4 | `GenerateQuestionsUser` 带薄弱参数时 prompt 含定向分配指令 |
| P5 | 画像仅基于本人数据（用户隔离） |
| P6 | `sessions` 参数生效，窗口 ≤10 |
| P7 | 前端 build 通过；新建页画像卡按有无画像渲染 |

---

## 10. Implementation notes

- Backend: `internal/profile`（service.go 含计算 + handler.go 含路由 + service_test.go 集成测试），挂 `GET /api/profile`
- `interview.Service` 构造增加 `profileService`（或注入只读函数接口，避免循环依赖：`interview` → `profile` → 无反向依赖）
- `llm/prompts.go` 增加中文维度名映射常量（与 profile 模块共用，放 llm 包导出）
- Tests: profile 计算单测 + 集成（镜像 analytics 测试模式，email 前缀 `test-profile-%`）；interview Start 注入测试（fake LLM 断言 prompt 含/不含定向指令）；前端 build
- Prefer branch `feat/v3-profile` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（自动画像、生成时定向、展示+降级、独立模块、无新表）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除打标签/题库筛选/手动画像
- [x] 归属、窗口、降级语义显式；`from-bank` 不受影响
