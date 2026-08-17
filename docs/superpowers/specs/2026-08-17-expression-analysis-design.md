# V8 语音表达分析 — 设计规格

**Date:** 2026-08-17  
**Status:** Implemented on feat/v8-expression-analysis
**Parent:** V1 MVP + V2 题库/语音/成长 + V3 画像 + V4 PWA + V5 人格 + V6 预检 + V7 专项训练  
**Approach:** 语音答案的录音时长随 WS 答案入库，报告页新增「表达分析」区：语速（字/分钟）、口头禅、句长；纯计算、无 LLM

---

## 1. Goal

把 V2B 语音作答积累的转写文本变成可量化的表达指标：语音答案记录录音时长，报告页展示语速、口头禅、平均句长，帮助用户觉察「语速是否过快/口头禅是否密集」。文字场次也能得到口头禅与句长指标（无语速）。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 语速数据源 | **录音时长入库**：前端按住说话结束时记时长，随 WS `answer` 消息附带，存 `interview_turns.voice_duration_ms` |
| 停顿指标 | **不做**：现有 ASR 不返回停顿信息，避免改 Transcribe 接口与 Aliyun 客户端 |
| 输出位置 | **报告页内展示**：ReportPage 加「表达分析」区，复用既有报告加载模式，不新增页面 |
| 计算方式 | **纯规则计算**（无 LLM）：语速=总字数/总时长，口头禅=预设词表计数，句长=按句末标点切分 |
| 降级 | 文字场次/无语音答案：`voice_answers=0`、`speech_rate_cpm` 为 null，仍出 fillers 与句长 |
| 兼容性 | 存量 turns 的 `voice_duration_ms` 为 NULL（无语音指标），不影响文字分析 |
| 评分口径 | 报告评分（四维）不变，表达分析为附加展示 |
| 执行顺序 | 分支 `feat/v8-expression-analysis` from main HEAD |

---

## 3. Non-goals (V8)

- 停顿次数/语气分析（需详细 ASR 时间戳，明确排除）
- 独立表达分析页面 / 历史汇总趋势
- 口头禅词表可配置（预设固定词表）
- 语速与评分联动（展示参考区间，不改分数）
- 音频文件持久化（只存文本与时长）

---

## 4. Data model

迁移 `007_voice_duration.sql`（沿用先例）：

```sql
ALTER TABLE interview_turns
  ADD COLUMN voice_duration_ms INT NULL;
```

- `voice_duration_ms`：录音时长毫秒数；NULL = 文字答案或存量数据
- `Turn` 结构体加 `VoiceDurationMs *int`；turns JSON 响应带 `voice_duration_ms`（可选）

---

## 5. 录音时长采集（WS 协议 + 前端）

### 5.1 WS 协议

`ClientMsg` 加可选字段：

```go
type ClientMsg struct {
	Type            string `json:"type"`
	Content         string `json:"content"`
	VoiceDurationMs *int64 `json:"voice_duration_ms,omitempty"`
}
```

- `ws/handler.go` 调 `HandleAnswer` 时把 `clientMsg.VoiceDurationMs` 传入
- `HandleAnswer(ctx, userID, sessionID, content string, voiceDurationMs *int64)` → `AppendTurn(sessionID, "candidate", "answer", content, voiceDurationMs)`
- `AppendTurn` INSERT 加 `voice_duration_ms` 列（NULL 存 NULL）

### 5.2 前端

- `interviewSocket.ts`：`sendAnswer(content, voiceDurationMs?)`，消息体带 `voice_duration_ms`
- `InterviewRoomPage`：`startRecordingSession`（按住说话开始时）记 `recordStartRef = Date.now()`；`handleVoiceSend`（松开发送，转写成功后）算 `Date.now() - recordStartRef` 作为时长传给 `sendAnswer`；文字提交不带时长
- 录音取消/失败不发送

---

## 6. 表达分析（新模块 `internal/expression`，纯计算）

### 6.1 API

`GET /api/interviews/:id/expression`（JWT，session 归属校验——无归属 → 404）：

```json
{
  "available": true,
  "voice_answers": 4,
  "total_duration_ms": 94000,
  "speech_rate_cpm": 128,
  "fillers": [{"word": "然后", "count": 6}, {"word": "那个", "count": 4}],
  "avg_answer_chars": 62,
  "avg_sentence_chars": 18
}
```

- `speech_rate_cpm`：`∑(答案字数) / (∑voice_duration_ms / 60000)`，四舍五入整数；无语音答案 → `null`
- `fillers`：预设词表 `嗯、呃、那个、这个、然后、就是` 在**全部答案文本**（含文字答案）中 `strings.Count`，count>0 才列出，按 count 降序
- `avg_answer_chars`：全部答案的平均字数（rune 数），四舍五入
- `avg_sentence_chars`：按句末标点（`。！？.?!`）切分全部答案后的平均句长（rune），四舍五入；无句子 → 0
- 空会话/无答案 → `available: true`，各数值为 0/null（不报错）

### 6.2 结构

- `Service{ repo *interview.Repo }`（读 turns；复用 `interview.NewRepo`）
- `Analyze(ctx, userID, sessionID) (Result, error)`：校验归属 → 取答案轮次（`role='candidate' AND kind='answer'`）→ 计算
- `RegisterRoutes(r, db, secret)` → 挂 `/api/interviews/:id/expression`（用 `interview` 的 Repo，无循环依赖：`expression` → `interview.Repo`）

---

## 7. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| `InterviewRoomPage` | 语音答案提交带 `voice_duration_ms` |
| `ReportPage` | 新增「表达分析」区（feedback 区下方）：加载 `GET .../expression` |
| `api/expression.ts` | `ExpressionResult` 类型 + `fetchExpression(id)` |

**表达分析区展示：**
- 语音指标（`speech_rate_cpm` 非 null 时）：「语速 X 字/分钟」（附参考区间提示「一般 100–200 字/分钟」）
- 口头禅：「高频口头禅：然后 ×6、那个 ×4」（无 → 「口头禅较少，继续保持」）
- 句长：「平均每答 X 字 / 平均句长 Y 字」（无答案 → 「暂无答案数据」）
- 加载失败：静默不显示（不阻断报告）
- 复用 design tokens，无新页面

---

## 8. Acceptance

| ID | Expectation |
|----|-------------|
| S1 | WS `answer` 带 `voice_duration_ms` 时落库；不带 → NULL；文字答案不受影响 |
| S2 | 前端语音提交带时长（按住说话时长），文字提交不带 |
| S3 | `GET /api/interviews/:id/expression` 返回语速/口头禅/句长；无语音答案 → `speech_rate_cpm` null、`voice_answers` 0 |
| S4 | 口头禅按预设词表计数降序；句长按标点切分 |
| S5 | 用户隔离：他人 session → 404 |
| S6 | 报告页展示表达分析区；加载失败静默 |
| S7 | 无回归：`go test ./... -count=1 -p 1` 全绿 + `npm run build` 通过 |

---

## 9. Implementation notes

- Backend: `internal/expression`（service.go + handler.go + 测试）；`interview` 的 Turn/AppendTurn/HandleAnswer/ws handler 加时长；迁移 `007_voice_duration.sql`
- `ws/handler.go` 的 `HandleAnswer` 调用点（约 75 行）加时长参数；`service.go` 的 `HandleAnswer` 签名与内部 `AppendTurn` 调用（约 332 行）同步
- `interview/repo.go` `AppendTurn`（约 289 行）INSERT 加列；`scanTurn`/`ListTurns` SELECT 加列；`turnResponse` 带 `voice_duration_ms`
- `main.go`：`expression.RegisterRoutes(r, sqlDB, cfg.JWTSecret)`（放 interview 路由附近）
- Tests: `AppendTurn` 时长落库（ws 或 service 级）；expression 计算单测（语速/口头禅/句长/降级/隔离）；前端 build
- 口头禅词表放 `internal/expression`（单一来源），中文词无需 i18n
- Prefer branch `feat/v8-expression-analysis` from main HEAD

---

## Spec self-review

- [x] 无 TBD / 占位符
- [x] 与 locked decisions 一致（时长入库、不做停顿、报告页展示、纯计算、降级、评分不变）
- [x] 范围聚焦单一实施计划；Non-goals 明确排除停顿/独立页/可配词表/音频持久化
- [x] NULL 语义（存量/文字答案）、语速公式、切分规则、降级输出显式
