# V2-A 题库系统 — 设计规格

**Date:** 2026-08-10  
**Status:** Implemented on `feat/v2a-question-bank`  
**Parent:** V1 MVP (`2026-08-10-interview-assistant-mvp-design.md`)  
**Approach:** 独立 `question_bank` 表 + 面试沉淀 + 勾选再练

---

## 1. Goal

在 V1 闭环之上增加**用户专属题库**：面试结束后沉淀主问题；支持收藏、按岗位标签筛选、删除；支持从题库多选组卷再练。开面默认路径仍为 **JD 即时出题**（不变）。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| V2 首刀 | 完整题库（语音、面试对比延后） |
| 与开面关系 | 沉淀为主；JD 即时出题保留 |
| 入库方式 | 仅面试结束后一键存入（无手写新建 / AI 单独入库 / OCR） |
| 再练 | 题库多选 → 组卷开面 |
| 列表能力 | 列表 + 收藏 + job_tag 筛选 + 删除 + 多选开练 |
| 架构 | 独立 `question_bank`，与本场 `interview_questions` 解耦 |

---

## 3. Non-goals (V2-A)

- 手写新建 / 编辑题干 UI
- AI 单独「生成进题库」不开面
- OCR / 截图 / 文档导入抽题
- 标签多对多实体、组卷模板、题目版本历史
- 语音 ASR/TTS、面试对比分析、成长曲线

---

## 4. Data model

### 4.1 Table `question_bank`

| Column | Type | Notes |
|--------|------|-------|
| `id` | BIGINT PK | |
| `user_id` | BIGINT FK → users | 归属 |
| `question` | TEXT NOT NULL | 题干 |
| `answer` | TEXT NULL | 可选参考答案/笔记；V2-A 存入时可空 |
| `source` | VARCHAR | `interview`（预留扩展） |
| `source_session_id` | BIGINT NULL | 来源面试 |
| `job_tag` | VARCHAR(64) NULL | 岗位标签；存入时取 JD 截断（如前 40 字） |
| `starred` | TINYINT(1) | 默认 0 |
| `created_at` | TIMESTAMP | |

Indexes: `(user_id, created_at)`, `(user_id, starred)`, `(user_id, job_tag)`.

**Dedup:** 允许同一用户重复题干（简化实现）。

**Copy rule:** 仅复制本场**主问题**（`interview_questions`），不含追问 turns。

---

## 5. API

All routes require JWT; enforce `user_id` ownership (missing/foreign → 404).

### 5.1 Question bank

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/questions` | 列表。Query: `starred=1`, `job_tag=`, `q=`（题干模糊可选） |
| POST | `/api/questions/from-session/:sessionId` | 将 session 主问题批量写入题库。返回 `{ imported: n }` |
| PATCH | `/api/questions/:id` | Body: `{ starred: bool }` |
| DELETE | `/api/questions/:id` | 删除 |

**from-session rules:**

- Session 必须属于当前用户。
- Session 须已有至少一条 `interview_questions`（建议允许 `ready` / `in_progress` / `completed`；无题则 400）。
- `job_tag`：取 `job_jd` trim 后截断（例如 rune/字 40，超出加 `…`）。
- 每条插入：`source=interview`, `source_session_id=sessionId`, `starred=false`。

### 5.2 Practice from bank

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/interviews/from-bank` | Body: `{ question_ids: number[], mode }` |

**Behavior:**

1. Validate `mode` ∈ behavioral|technical|mixed。
2. Validate `question_ids` 非空、均属当前用户（否则 400/404）。
3. 按请求数组**顺序**创建 `interview_sessions`：`job_jd` 可用固定文案如「题库练习」或拼接题数；`resume_text` null；`status=ready`（跳过 draft/LLM GenerateQuestions）。
4. 写入 `interview_questions`（seq 从 1，`asked=false`）。
5. 返回 session（与 create/start 后类似），前端进入 `/interviews/:id/room` 走现有 WS。

**Unchanged:** `POST /api/interviews` + `POST /:id/start`（JD 即时出题）。

---

## 6. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| 顶栏 | 增加「题库」链接 → `/questions` |
| `/questions` | 列表、多选、收藏、job_tag/仅收藏筛选、删除、「开始练习」 |
| 开练确认 | 弹层或页内：已选 N 题 + mode → `from-bank` → room |
| 面试详情 / 报告 | 「存入题库」按钮 → `from-session` |
| `/interviews/new` | 不变（JD + 简历文件 + mode） |

---

## 7. Acceptance

| ID | Expectation |
|----|-------------|
| B1 | 有本场题的面试可存入题库，列表可见 |
| B2 | 收藏与 job_tag 筛选生效 |
| B3 | 删除仅影响本人题目 |
| B4 | 多选开练进房，题序与所选一致，可答完出报告 |
| B5 | JD 即时出题路径仍可用 |
| B6 | 用户 B 不可见用户 A 的题库条目 |

---

## 8. Implementation notes

- Backend module: `internal/question`（repo/handler/service），挂到现有 Gin 路由。
- Reuse: WS `BeginLive` / `HandleAnswer` / Analysis 无需改协议；`from-bank` 产出的 session 与 `start` 后同为 `ready`。
- Migration: `002_question_bank.sql`.
- Prefer branch `feat/v2a-question-bank` from current `feat/mvp-v1` HEAD when implementing.

---

## Spec self-review

- [x] No unresolved TBD
- [x] Consistent with locked decisions
- [x] Scope limited to V2-A; voice/compare excluded
- [x] Ownership and V1 path compatibility explicit
