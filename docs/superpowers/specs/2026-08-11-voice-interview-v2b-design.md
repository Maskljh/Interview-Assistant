# V2-B 语音面试 — 设计规格

**Date:** 2026-08-11  
**Status:** Implemented on `feat/v2b-voice` — implementation plan at `docs/superpowers/plans/2026-08-11-voice-interview-v2b.md`  
**Parent:** V1 MVP + V2-A question bank  
**Approach:** A — REST 语音适配（阿里云 ASR/TTS）+ 现有文本 WebSocket

---

## 1. Goal

在现有文本面试闭环上增加**可选语音场**：开面时选择作答方式；语音场内题干/追问经 TTS 播报，用户停录后 ASR 转写并自动作为答案进入现有自适应问答环；保留打字兜底。音频不落盘。

---

## 2. Locked decisions

| 决策点 | 选择 |
|--------|------|
| 能力范围 | 完整语音环：TTS 播题 + ASR 作答 + 打字兜底 |
| 进场方式 | 开面/题库开练时选 `text` \| `voice`（非全局开关、非每房强制） |
| ASR/TTS | 服务端第三方：**阿里云智能语音**；`SpeechClient` 可替换 |
| 录音交互 | 停止录音 → ASR 成功 → **自动发送** WS `answer`；失败可重录 |
| 音频存储 | **不落盘**；仅文本进 `interview_turns` |
| 架构 | REST `/api/speech/asr|tts` + 现有 WS 文本协议不变 |

---

## 3. Non-goals (V2-B)

- 流式边说边出字 / 实时 ASR 流
- 音频 OSS 存档与回放
- 视频、虚拟人、表情识别
- 浏览器 Web Speech 作为主路径
- 面试对比分析（V2-C）
- 更换 JD 即时出题 / 题库主路径逻辑（仅增加 `input_mode`）

---

## 4. Architecture

```text
Browser ──REST /api/speech/asr|tts──► Go speech ──► 阿里云智能语音
Browser ──WSS 文本 question/answer──► Go interview/ws（与 V1 相同）
```

| 单元 | 职责 |
|------|------|
| `internal/speech` | `SpeechClient` 接口、Aliyun 实现、HTTP handlers |
| `interview` | Create / from-bank 接受 `input_mode`；session 响应带回 |
| `ws` | **不改协议**；不感知音频 |
| 前端房间 | `voice`：TTS 播放 + 录音→ASR→自动 `answer`；`text`：V1 行为 |

无阿里云密钥时：文本场完全可用；语音 API 返回 502，语音场前端提示并可打字完成。

---

## 5. Data model

### 5.1 `interview_sessions` 增量

| Column | Type | Notes |
|--------|------|-------|
| `input_mode` | VARCHAR(16) NOT NULL DEFAULT `'text'` | `text` \| `voice` |

Migration: `003_input_mode.sql`（已有行回填 `text`）。

`question_bank`、`interview_questions`、`interview_turns`：**不变**（无 audio 字段）。

---

## 6. API

All speech routes require JWT.

### 6.1 Speech

| Method | Path | Request | Success |
|--------|------|---------|---------|
| POST | `/api/speech/asr` | `multipart/form-data`：`audio`（webm/wav/mp3 等） | `{ "text": "..." }` |
| POST | `/api/speech/tts` | JSON `{ "text": "..." }`（限长，如 ≤500 字） | `audio/mpeg` 二进制流 |

Errors: 空音频/空文本 → 400；缺配置或上游失败 → 502；未登录 → 401。

### 6.2 Interview（增量）

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/interviews` | Body 可选 `input_mode`（默认 `text`）；非法 → 400 |
| POST | `/api/interviews/from-bank` | 同上 |
| GET | `/api/interviews/:id`（及 create/start/from-bank 响应） | 含 `input_mode` |

### 6.3 WebSocket

不变：`answer` / `question` / `follow_up` / `done` / `status`；`content` 始终为文本。

---

## 7. Frontend (Chinese UI)

| Surface | Change |
|---------|--------|
| 新建面试 / 题库开练确认 | 「作答方式」：文本 / 语音 |
| 房间 `text` | 与 V1 相同 |
| 房间 `voice` | 题/追问到 → TTS（可静音/重播/跳过）；录音停止 → ASR → 自动发；保留文本框；状态：录音中 / 识别中 / 发送中 / 错误可重录 |
| 详情 | 展示作答方式标签；无音频回放 |

**语音房规则：**

- ASR 空文本：不自动发送，提示重录。
- TTS 失败：仍显示题干文字，不阻断作答。
- ASR/TTS 502：中文提示「语音服务暂不可用」，打字可继续直至出报告。

---

## 8. Config

| Variable | Required for voice | Description |
|----------|-------------------|-------------|
| `ALIYUN_ACCESS_KEY_ID` | yes (voice) | 阿里云 AK |
| `ALIYUN_ACCESS_KEY_SECRET` | yes (voice) | 阿里云 SK |
| `ALIYUN_NLS_APP_KEY` | yes (voice) | 智能语音 AppKey |

写入 `.env` / `.env.example`（示例留空）；`godotenv` 已有则复用。

---

## 9. Acceptance

| ID | Expectation |
|----|-------------|
| V1 | 文本场创建与面试行为与 V1 一致 |
| V2 | 语音场：题干可播报；停录转写后进入下一题/追问环 |
| V3 | ASR/TTS 失败有中文提示，打字可完成并出报告 |
| V4 | 无阿里云密钥时文本场可用；语音 API 502 |
| V5 | `from-bank` + `voice` 可进房练习 |
| V6 | 音频不出现在 DB / 长期磁盘存储 |

---

## 10. Implementation notes

- Prefer branch `feat/v2b-voice` from current `feat/v2a-question-bank`（或已合并的含题库 HEAD）。
- TTS 响应固定为 **audio/mpeg 流**（不要 JSON+base64 双模式）。
- 前端录音优先 MediaRecorder `audio/webm`；后端按 Content-Type/扩展名交给阿里云一句话识别（或文件转写 API，实现计划里钉死具体 endpoint）。
- 单元测试：speech handler 用 fake `SpeechClient`；interview `input_mode` 校验；不强制 CI 调真实阿里云。

---

## Spec self-review

- [x] No unresolved TBD（阿里云具体 REST endpoint 名留实现计划钉死，不阻塞规格）
- [x] Consistent with locked decisions
- [x] Scope limited to V2-B；流式/存档/视频/对比排除
- [x] V1 文本路径与 WS 兼容性明确
