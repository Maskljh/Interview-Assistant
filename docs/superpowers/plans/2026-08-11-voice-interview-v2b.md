# V2-B Voice Interview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional voice interviews: choose text/voice at session creation; voice rooms use Aliyun ASR/TTS via REST while the existing text WebSocket Q&A loop stays unchanged.

**Architecture:** `input_mode` on `interview_sessions`; new `internal/speech` with `SpeechClient` + Aliyun REST impl + JWT routes `/api/speech/asr|tts`; frontend voice room records audio → ASR → auto-sends WS `answer`, plays TTS on questions. No audio persistence.

**Tech Stack:** Go/Gin, MySQL migration, existing JWT/WS, React/Vite, Aliyun NLS REST (一句话识别 + 流式 TTS), MediaRecorder.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-11-voice-interview-v2b-design.md`
- `input_mode` ∈ `text` | `voice`; default `text`; invalid → 400
- WS protocol unchanged; `answer` content is always text
- Audio **not** stored in DB/OSS; only ASR text in `interview_turns`
- TTS response: `audio/mpeg` binary stream only
- ASR: multipart upload; empty audio → 400; missing Aliyun config / upstream fail → 502
- Chinese UI for new voice copy; text-mode room behavior must match V1
- Branch: `feat/v2b-voice` from `feat/v2a-question-bank` HEAD
- Tests use **fake** `SpeechClient`; no CI dependency on real Aliyun keys
- On Windows if `git commit` wrapper fails, use `git commit-tree` plumbing

---

## File map

| Path | Responsibility |
|------|----------------|
| `backend/migrations/003_input_mode.sql` | Add `input_mode` column |
| `backend/internal/interview/models.go` | `InputMode` type + constants |
| `backend/internal/interview/repo.go` | Read/write `input_mode` in CRUD + CreateReadyWithQuestions |
| `backend/internal/interview/handler.go` | Accept/return `input_mode` on create/from-bank/get |
| `backend/internal/interview/service.go` | Validate `input_mode` in Create / CreateFromBank |
| `backend/internal/interview/service_test.go` | input_mode tests |
| `backend/internal/speech/client.go` | `SpeechClient` interface |
| `backend/internal/speech/aliyun.go` | Aliyun NLS REST (ASR + TTS) |
| `backend/internal/speech/fake.go` | Test double |
| `backend/internal/speech/handler.go` | `RegisterRoutes` ASR/TTS |
| `backend/internal/speech/handler_test.go` | Handler tests with fake client |
| `backend/internal/config/config.go` | Aliyun env fields |
| `backend/cmd/server/main.go` | Wire speech routes + inject client |
| `.env.example` | Aliyun keys placeholders |
| `frontend/src/api/speech.ts` | `transcribeAudio`, `synthesizeSpeech` |
| `frontend/src/api/interviews.ts` | `input_mode` on types + create/from-bank |
| `frontend/src/lib/voiceRecorder.ts` | MediaRecorder helper |
| `frontend/src/lib/voicePlayer.ts` | Play TTS blob |
| `frontend/src/pages/CreateInterviewPage.tsx` | 作答方式 selector |
| `frontend/src/pages/QuestionBankPage.tsx` | 作答方式 on practice |
| `frontend/src/pages/InterviewRoomPage.tsx` | Voice UI branch |
| `frontend/src/pages/InterviewDetailPage.tsx` | 作答方式 label |
| `README.md` | Aliyun env + voice mode note |

---

### Task 1: Migration `input_mode`

**Files:**
- Create: `backend/migrations/003_input_mode.sql`

**Interfaces:**
- Produces: column `interview_sessions.input_mode VARCHAR(16) NOT NULL DEFAULT 'text'`

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE interview_sessions
  ADD COLUMN input_mode VARCHAR(16) NOT NULL DEFAULT 'text' AFTER mode;
```

- [ ] **Step 2: Apply to local DB**

```powershell
Get-Content backend/migrations/003_input_mode.sql -Raw |
  docker exec -i template-mall-mysql mysql -uroot -proot interview
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(v2b): add interview_sessions.input_mode migration"
```

---

### Task 2: Interview `input_mode` (backend)

**Files:**
- Modify: `backend/internal/interview/models.go`, `repo.go`, `handler.go`, `service.go`, `service_test.go`

**Interfaces:**
- Consumes: migration applied
- Produces:
  - `type InputMode string` with `InputModeText`, `InputModeVoice`
  - `func ValidateInputMode(m InputMode) error`
  - `Session.InputMode InputMode`
  - Create / CreateFromBank accept optional `input_mode` (default text)
  - All `sessionResponse` include `input_mode`

- [ ] **Step 1: Write failing tests**

```go
func TestCreateDefaultsInputModeText(t *testing.T) { /* POST create without field → input_mode text */ }
func TestCreateVoiceInputMode(t *testing.T) { /* body input_mode voice → persisted */ }
func TestCreateInvalidInputMode400(t *testing.T) { /* input_mode foo → 400 */ }
func TestCreateFromBankVoiceInputMode(t *testing.T) { /* from-bank with voice */ }
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd backend && go test ./internal/interview/ -count=1 -run InputMode
```

- [ ] **Step 3: Implement**

`models.go`:

```go
type InputMode string
const (
  InputModeText  InputMode = "text"
  InputModeVoice InputMode = "voice"
)
func ValidateInputMode(m InputMode) error { /* invalid → ErrInvalidInput */ }
```

Update `Repo.Create`, `CreateReadyWithQuestions`, `scanSession` SQL to include `input_mode`.

`createRequest` / `fromBankRequest` add `InputMode *InputMode` or `InputMode InputMode` with empty → text.

- [ ] **Step 4: Run full interview tests — PASS**

```bash
cd backend && go test ./internal/interview/ -count=1
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(v2b): persist and validate interview input_mode"
```

---

### Task 3: Speech module (fake + Aliyun + handlers)

**Files:**
- Create: `backend/internal/speech/client.go`, `fake.go`, `aliyun.go`, `handler.go`, `handler_test.go`
- Modify: `backend/internal/config/config.go`, `backend/cmd/server/main.go`, `.env.example`

**Interfaces:**
- Produces:

```go
// client.go
type Client interface {
  Transcribe(ctx context.Context, audio []byte, format string) (string, error)
  Synthesize(ctx context.Context, text string) ([]byte, error)
}
func NewAliyunClient(cfg AliyunConfig) (Client, error) // returns error if keys missing
func NewFakeClient() Client
```

```go
// handler.go — RegisterRoutes(r, secret string, client Client)
// POST /api/speech/asr  multipart field "audio"
// POST /api/speech/tts  JSON { "text": "..." } max 500 runes
```

**Aliyun endpoints (lock in impl):**
- **TTS:** `POST https://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/tts` — query/body per NLS REST doc; response MP3 bytes; `Content-Type: audio/mpeg`
- **ASR:** NLS **一句话识别** REST for uploaded short audio (≤60s); send audio as body/base64 per official REST spec; map webm/wav content-type to format param

If Aliyun REST signing is verbose, use minimal token flow documented for NLS REST (AK/SK sign + `X-NLS-Token` or gateway appkey pattern — follow current Aliyun NLS REST doc at implement time).

Config fields:

```go
AliyunAccessKeyID     string
AliyunAccessKeySecret string
AliyunNLSAppKey       string
```

`main.go`: if all three set → `speech.NewAliyunClient`; else `client = nil` and handlers return 502 with `{"error":"speech service unavailable"}`.

- [ ] **Step 1: Write failing handler tests** (`handler_test.go` with `NewFakeClient`)

```go
func TestASRReturnsText(t *testing.T) { /* upload bytes → 200 {"text":"你好"} */ }
func TestASREmptyAudio400(t *testing.T)
func TestTTSReturnsMPEG(t *testing.T) { /* Content-Type audio/mpeg, body non-empty */ }
func TestTTSEmptyText400(t *testing.T)
func TestSpeechUnavailable502(t *testing.T) { /* nil client */ }
```

- [ ] **Step 2: Run — FAIL**

```bash
cd backend && go test ./internal/speech/ -count=1
```

- [ ] **Step 3: Implement fake + handler + config + wire**

Fake returns deterministic text/audio. Aliyun client: HTTP calls only, no audio disk write.

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(v2b): speech ASR/TTS API with Aliyun client"
```

---

### Task 4: Frontend API + create/bank input_mode + detail label

**Files:**
- Create: `frontend/src/api/speech.ts`
- Modify: `frontend/src/api/interviews.ts`, `CreateInterviewPage.tsx`, `QuestionBankPage.tsx`, `InterviewDetailPage.tsx`, `frontend/src/lib/labels.ts` (if exists) or inline Chinese labels

**Interfaces:**
- `export type InputMode = 'text' | 'voice'`
- `transcribeAudio(blob: Blob): Promise<{ text: string }>` — FormData to `/api/speech/asr`
- `synthesizeSpeech(text: string): Promise<Blob>` — POST `/api/speech/tts`, response blob
- `createInterview` / `createInterviewFromBank` accept `input_mode?: InputMode`

- [ ] **Step 1: Add API types and helpers**

- [ ] **Step 2: CreateInterviewPage** — radio「作答方式」：文本 / 语音；pass `input_mode` to create

- [ ] **Step 3: QuestionBankPage** — practice dialog adds same selector; pass to `createInterviewFromBank`

- [ ] **Step 4: InterviewDetailPage** — show badge「文本作答」/「语音作答」

- [ ] **Step 5: Build**

```bash
cd frontend && npm run build
```

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(v2b): input_mode on create and bank practice UI"
```

---

### Task 5: Voice room UI (TTS + record + auto-send)

**Files:**
- Create: `frontend/src/lib/voiceRecorder.ts`, `frontend/src/lib/voicePlayer.ts`
- Modify: `frontend/src/pages/InterviewRoomPage.tsx`, `InterviewPages.css`

**Behavior (voice mode only):**

1. On mount, `GET /api/interviews/:id` to read `input_mode` (or pass via location state from create — prefer GET for refresh-safe).
2. On `question` / `follow_up` WS message with content → call `synthesizeSpeech` → play blob; on failure show「播报失败，请阅读文字」; show text in transcript as today.
3. **按住说话** (PTT): `mousedown/touchstart` start MediaRecorder `audio/webm`; `mouseup/touchend` stop → `transcribeAudio` → if text empty show「未识别到内容，请重录」; else auto `socket.send({type:'answer', content:text})` without extra click.
4. Keep text input + Send for fallback; disable record while `thinking` or `transcribing`.
5. States: `idle | recording | transcribing | sending`; Chinese status lines.
6. ASR/TTS 502 →「语音服务暂不可用」; typing still works.

`text` mode: **no changes** to current submit flow.

- [ ] **Step 1: Implement recorder/player helpers with cleanup on unmount**

- [ ] **Step 2: Branch InterviewRoomPage on `input_mode`**

- [ ] **Step 3: Manual smoke checklist** (document in task report)

- Voice JD create → room → hear TTS (fake/key) → hold speak → auto next question
- Text create unchanged

- [ ] **Step 4: `npm run build`**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(v2b): voice room TTS playback and ASR auto-send"
```

---

### Task 6: Docs, config example, acceptance verification

**Files:**
- Modify: `README.md`, `.env.example`, spec status line

- [ ] **Step 1: `.env.example`**

```env
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
ALIYUN_NLS_APP_KEY=
```

- [ ] **Step 2: README** — voice mode section: env vars, text mode works without them, speech routes 502 without keys

- [ ] **Step 3: Run full backend tests serially**

```bash
cd backend && go test ./... -count=1 -p 1
```

- [ ] **Step 4: Map acceptance V1–V6** in task report / brief comment

| ID | Verification |
|----|----------------|
| V1 | Existing interview tests + text room unchanged |
| V2 | Voice room manual + ASR fake test sends answer |
| V3 | Handler 502 + frontend error string |
| V4 | nil speech client 502; text create OK |
| V5 | from-bank voice test from Task 2 |
| V6 | No new audio columns/tables; handlers don't write files |

- [ ] **Step 5: Update spec status** → `Implemented on feat/v2b-voice` after merge-ready

- [ ] **Step 6: Commit**

```bash
git commit -m "docs(v2b): aliyun speech env and voice mode README"
```

---

## Spec coverage self-review

| Spec section | Task |
|--------------|------|
| §5 input_mode migration | T1 |
| §6.2 interview API | T2 |
| §6.1 speech API | T3 |
| §7 create/bank/detail UI | T4 |
| §7 voice room | T5 |
| §8 config | T3, T6 |
| §9 V1–V6 | T2–T6 tests + manual |
| Non-goals (stream/OSS/video) | not implemented |

## Placeholder scan

No TBD steps; Aliyun endpoint family named; fake client for tests; exact signing fields resolved at Task 3 implement time from current NLS REST doc.
