# 模拟面试助手 V1 MVP — 设计规格

**Date:** 2026-08-10  
**Status:** Draft for user review  
**Source:** PRD V2.0（工程落地版）+ 需求澄清决策  
**Approach:** 方案 B — React + Go 单体模块化 + WebSocket 实时面试

---

## 1. Goal

在 2–4 周内交付可演示的**面试训练闭环**：登录用户填写 JD（简历可选）、选择面试类型、AI 生成本场题、文本自适应多轮面试、结束后结构化报告、历史回看。

**非目标（V1）：** 完整题库产品、OCR/文档导入、语音/视频、成长曲线、第三方登录、付费配额、微服务拆分。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 身份 | 必须登录；邮箱 + 密码 |
| 出题 | 本场即时生成（session-scoped）；完整题库延后 V2 |
| 面试组织 | 自适应追问；服务端决定下一题/结束 |
| 开场输入 | JD 必填，简历可选（纯文本） |
| 面试类型 | 行为 / 技术 / 综合（三选一） |
| 首发目标 | 可演示完整闭环，功能宁少但稳 |
| 架构 | 单体模块化 + REST 启停 + WS 问答 |

---

## 3. Architecture

### 3.1 Runtime

```text
React SPA ──HTTPS REST──┐
                         ├──► Go (Gin) ──► MySQL
         ──WSS───────────┘         ├──► Redis
                                   └──► DeepSeek API
```

- 单 Go 进程；V1 不接 OSS / ASR / TTS。
- 框架默认 **Gin**（与 Fiber 等价，选定其一即可）。

### 3.2 In-process modules

| Module | Responsibility |
|--------|----------------|
| **User** | 注册、登录、JWT；无 OAuth、无 RBAC |
| **Interview** | 创建会话、本场出题、WS 状态机、turns 落库；热状态在 Redis |
| **Analysis** | 结束后同步评测，写入 `feedback_json`；失败可单独重试 |
| **Question Bank** | V1 不实现；本场题存在 `interview_questions` |

### 3.3 Transport split

- **REST：** 鉴权、创建/开始/结束会话、历史、详情、报告、报告重试。
- **WebSocket：** 多轮 `answer` ↔ `question` / `follow_up` / `status` / `done`。

服务端是唯一状态权威；客户端不决定下一题或结束（除显式调用 REST `end`）。

### 3.4 Main path

登录 → 创建 session（JD / resume? / mode）→ `start`（DeepSeek 出题 → `ready`）→ WS 进房 → 自适应多轮 → 结束 → Analysis 报告 → 列表/详情回看。

---

## 4. Data model

### 4.1 MySQL

**users**

- `id`, `email` (unique), `password_hash`, `created_at`

**interview_sessions**

- `id`, `user_id`
- `job_jd` (text), `resume_text` (nullable)
- `mode`: `behavioral` | `technical` | `mixed`
- `status`: `draft` | `ready` | `in_progress` | `completed` | `failed`
- `score` (nullable int)
- `feedback_json` (nullable JSON)
- `raw_feedback` (nullable text, optional debug)
- `started_at`, `ended_at`, `created_at`

**interview_questions**

- `id`, `session_id`, `seq`, `question`, `intent` (nullable), `asked` (bool)

**interview_turns**

- `id`, `session_id`, `seq`
- `role`: `interviewer` | `candidate` | `system`
- `kind`: `question` | `follow_up` | `answer` | `status`
- `content`, `created_at`

**Relationships:** users 1—N sessions；session 1—N questions；session 1—N turns（按 `seq` 有序）。无全局 `question_bank` 表。

### 4.2 Redis

- Key: `interview:session:{id}`
- Value: 当前题序、追问深度、结束判定辅助计数、WS 连接代际等热状态
- TTL：结束后约 1h；权威 transcript 以 MySQL `interview_turns` 为准

### 4.3 Session status machine

```text
draft → ready → in_progress → completed
              ↘ failed (任意步骤不可恢复失败)
```

- `in_progress` 仅允许正常/强制结束或失败标记。
- 报告挂在 session 上，V1 不另建 report 表。

### 4.4 `feedback_json` schema

```json
{
  "total_score": 0,
  "dimensions": {
    "expression": 0,
    "logic": 0,
    "content": 0,
    "job_match": 0
  },
  "strengths": ["..."],
  "weaknesses": ["..."],
  "suggestions": ["..."],
  "model_version": "..."
}
```

各维度与总分均为 0–100。

---

## 5. API & WebSocket protocol

### 5.1 REST

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/auth/register` | 注册 |
| POST | `/api/auth/login` | 登录，返回 JWT |
| POST | `/api/interviews` | 创建 `draft`：`job_jd`, `resume_text?`, `mode` |
| POST | `/api/interviews/:id/start` | 出题 → `ready` |
| POST | `/api/interviews/:id/end` | 用户强制结束（可选） |
| POST | `/api/interviews/:id/report/retry` | 评测失败后重试 |
| GET | `/api/interviews` | 当前用户历史列表 |
| GET | `/api/interviews/:id` | 详情 + turns（+ questions） |
| GET | `/api/interviews/:id/report` | 完成后的报告 |

所有 interview 路由校验 `user_id` 归属。

### 5.2 WebSocket

- Connect: `/ws/interviews/:id?token=<JWT>`
- 仅 `in_progress`（或 start 后立刻升为 `in_progress`）接受业务消息。

**Client → Server**

```json
{ "type": "answer", "content": "..." }
```

**Server → Client**

| type | Meaning |
|------|---------|
| `session_started` | 进房成功；可带当前待答 |
| `question` | 主问题 |
| `follow_up` | 追问 |
| `status` | 如 `thinking` / 错误提示 |
| `done` | 面试结束；客户端拉 report |

### 5.3 In-interview state machine

```text
AskMain → WaitAnswer → Decide → (FollowUp → WaitAnswer → Decide)* → NextMain | Finish
```

`DecideNext` 结构化输出：

- `action`: `follow_up` | `next_question` | `finish`
- `follow_up_text`（当 action=`follow_up`）

### 5.4 Hard limits (defaults)

| Rule | Default |
|------|---------|
| 本场主问题数 | 5–8（按 mode 生成） |
| 单题最大追问 | 2 |
| 整场最大 turns | ~30 |
| 单场最长时长 | 45 分钟 |
| 单次 answer 长度 | 截断至 token 上限 |
| 单用户并发面试 | 1 |

任一结束条件满足即 Finish：题单完成、Decide=`finish`、触达硬上限、用户 `end`、断线策略（已有足够 turns 则评测完成，否则 `failed`）。

### 5.5 Reconnect

同 session + 有效 JWT 可重连；服务端推送当前待答 `question`/`follow_up` 一条。全量历史通过 GET 详情，不在 WS 重放。

---

## 6. LLM contracts & error handling

### 6.1 Three DeepSeek calls

| Call | When | Output contract |
|------|------|-----------------|
| `GenerateQuestions` | `POST start` | `{ "questions": [{ "seq", "question", "intent?" }] }` |
| `DecideNext` | after each answer | `{ "action", "follow_up_text?" }` |
| `EvaluateSession` | after finish | `feedback_json` schema above |

每次调用：要求 JSON → 解析失败重试 1 次 → 再失败走规则降级。禁止把半截自然语言直接当控制状态。

### 6.2 Decide fallbacks

- 追问已达 2 → 强制 `next_question`
- 主问题已问完 → 强制 `finish`
- turn/时长触顶 → 强制 `finish`
- 模型失败 → 有余题则 `next_question`，否则 `finish`

### 6.3 Evaluate quality bar

- 建议必须可执行；Prompt 中给出空话反例。
- 评测失败：turns 已落库；session 可 `completed` 且报告标记不可用，或保持可 `report/retry`。

### 6.4 Error matrix

| Scenario | Behavior |
|----------|----------|
| 邮箱重复 | 400 |
| JWT 无效 | 401；WS 拒绝握手 |
| 出题失败 | 不进 WS；可重试 `start` |
| Decide 超时/坏 JSON | 重试 1 次 → 规则降级 |
| WS 断开 | 提示重连；热状态保留 |
| 评测失败 | 可 `report/retry` |
| DeepSeek 限流 | 映射 429；服务端退避 |

### 6.5 Security baseline

- 密码 bcrypt；JWT access token
- 全部 session 操作校验归属
- 用户输入按「数据」注入 Prompt，不拼进系统指令角色
- 并发与 token/时长硬上限（§5.4）

---

## 7. Frontend pages

Visual direction: existing repo `DESIGN.md` (Vercel-inspired black/ink on near-white).

| Page | Purpose |
|------|---------|
| 登录 / 注册 | 邮箱密码 |
| 面试列表（首页） | 历史 + 新建入口 |
| 创建面试 | JD、可选简历、mode |
| 面试进行中 | WS 气泡流、进度、强制结束、thinking 禁用发送 |
| 报告页 | 总分、四维、优缺点、建议、报告重试 |
| 面试详情 | 只读 transcript + 链到报告 |

**Out of UI scope:** 题库管理、语音/视频控件、成长曲线、完整个人中心。

---

## 8. Acceptance criteria

| ID | Scenario | Expectation |
|----|----------|-------------|
| A1 | 注册登录 | 新用户可注册登录，JWT 保持会话 |
| A2 | 创建并开始 | JD + 三类型任一；可选简历；start 后有题单 |
| A3 | 自适应面 | 至少一次追问或按规则跳题；可正常结束 |
| A4 | 报告 | 四维分数与建议；历史可回看 |
| A5 | 归属隔离 | 用户 B 无法读写用户 A 的 session |
| A6 | 失败可恢复 | 出题/评测可重试；WS 重连不丢当前待答 |

### Testing (V1)

- Backend: 归属与 session 状态机单测；Decide 降级规则单测；WS 鉴权集成测
- Frontend: 关键页手测 + 一条完整闭环手工脚本
- 不做重型 E2E 基建

---

## 9. Explicit non-goals (V1)

- 完整题库 CRUD / 收藏 / 岗位分类产品
- OCR、PDF/Word 解析流水线
- ASR / TTS / 视频 / 表情识别
- 成长曲线与多次对比产品化
- OAuth、RBAC、计费
- 微服务、消息队列、对象存储

---

## 10. Open implementation defaults

下列为设计已选定的默认值，实现计划可微调数字但不改语义：

- HTTP 框架：Gin
- 报告：同步生成（UI loading）
- 简历：仅文本字段，不做服务端文件解析
- 断线：有足够 turns 则结束并评测，否则 `failed`

---

## Spec self-review

- [x] No TBD/TODO placeholders left unresolved
- [x] Architecture matches transport and module split
- [x] Scope limited to demoable closed loop in 2–4 weeks
- [x] Ambiguities resolved: auth method, question source, adaptive flow, inputs, modes, approach B
