# Interview Assistant

AI-powered mock interview practice: create sessions from a job description, answer questions over WebSocket, and receive scored feedback.

## Prerequisites

- **Go** 1.22+
- **Node.js** 18+ and npm
- **Docker** (recommended for MySQL and Redis), or an existing MySQL 8 instance on port 3306

## Architecture (local)

| Service | Default address | Purpose |
|---------|-----------------|---------|
| API (Go/Gin) | `http://127.0.0.1:8080` | REST + WebSocket |
| Frontend (Vite) | `http://localhost:5173` | React UI |
| MySQL 8 | `127.0.0.1:3306` | Users, sessions, turns |
| Redis 7 | `127.0.0.1:6379` | Live interview state |

## 1. Start MySQL and Redis

### Option A — Docker Compose (this repo)

```bash
docker compose up -d
```

This starts MySQL (`root` / `root`, database `interview`) and Redis on the default ports.

### Option B — Existing MySQL host

If you already run MySQL on `127.0.0.1:3306`, create the database and point `MYSQL_DSN` at it:

```sql
CREATE DATABASE IF NOT EXISTS interview CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Redis must still be reachable at `REDIS_ADDR` (start via compose Redis only, or your own instance).

## 2. Apply database migrations

Apply **all** migration files in `backend/migrations/` in numeric order (`001_init.sql` … `011_question_import.sql`). On a fresh database, run every file once; on an existing database, apply only the ones after your current schema version (new ones like `011_question_import.sql` add the `question_bank.reference` column used by question import).

From the repo root:

```bash
for f in backend/migrations/*.sql; do
  docker compose exec -T mysql mysql -uroot -proot interview < "$f"
done
```

If using an external MySQL host, run the same SQL files with your client (in numeric order):

```bash
for f in backend/migrations/*.sql; do
  mysql -h 127.0.0.1 -u root -p interview < "$f"
done
```

## 3. Environment variables

The server reads **process environment only** (`os.Getenv`); it does not load a `.env` file. Copy `.env.example` as a reference.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **yes** | — | Secret for signing JWT access tokens |
| `HTTP_ADDR` | no | `:8080` | API listen address |
| `MYSQL_DSN` | no | `root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4` | MySQL connection string |
| `REDIS_ADDR` | no | `127.0.0.1:6379` | Redis address |
| `DEEPSEEK_API_KEY` | no* | — | DeepSeek API key for question generation and reports |
| `DEEPSEEK_BASE_URL` | no | `https://api.deepseek.com` | DeepSeek API base URL |
| `DEEPSEEK_MODEL` | no | `deepseek-chat` | Model name for LLM calls |
| `ALIYUN_ACCESS_KEY_ID` | no** | — | Aliyun access key for speech ASR/TTS |
| `ALIYUN_ACCESS_KEY_SECRET` | no** | — | Aliyun access key secret for speech ASR/TTS |
| `ALIYUN_NLS_APP_KEY` | no** | — | Aliyun Intelligent Speech (NLS) app key |
| `ALIYUN_OCR_ACCESS_KEY_ID` | no† | — | Aliyun access key for image import OCR (falls back to `ALIYUN_ACCESS_KEY_ID`) |
| `ALIYUN_OCR_ACCESS_KEY_SECRET` | no† | — | Aliyun access key secret for image import OCR (falls back to `ALIYUN_ACCESS_KEY_SECRET`) |
| `ALIYUN_OCR_ENDPOINT` | no | `https://ocr-api.cn-hangzhou.aliyuncs.com/` | Aliyun OCR endpoint |

\* Without `DEEPSEEK_API_KEY`, **start interview** returns `502` and reports stay unavailable. Auth, CRUD, and ownership checks still work.

\*\* Without the three Aliyun variables, text-mode interviews work normally; the speech routes `/api/speech/asr` and `/api/speech/tts` return `502` with `{"error":"speech service unavailable"}`. Voice rooms still show the question text and keep typing as a fallback.

\† Without `ALIYUN_OCR_ACCESS_KEY_ID`/`ALIYUN_OCR_ACCESS_KEY_SECRET`, image import (screenshot upload) returns `502` with a "please use text input" hint; text-paste import still works. Both fall back to the shared `ALIYUN_ACCESS_KEY_ID`/`ALIYUN_ACCESS_KEY_SECRET`.

**PowerShell (Windows):**

```powershell
$env:JWT_SECRET = "dev-change-me"
$env:MYSQL_DSN = "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
$env:REDIS_ADDR = "127.0.0.1:6379"
# Optional — required for full interview flow:
# $env:DEEPSEEK_API_KEY = "sk-..."
# Optional — required for voice interviews:
# $env:ALIYUN_ACCESS_KEY_ID = "LTAI..."
# $env:ALIYUN_ACCESS_KEY_SECRET = "..."
# $env:ALIYUN_NLS_APP_KEY = "..."
# Optional — required for image (screenshot) import OCR:
# $env:ALIYUN_OCR_ACCESS_KEY_ID = "LTAI..."   # falls back to ALIYUN_ACCESS_KEY_ID
# $env:ALIYUN_OCR_ACCESS_KEY_SECRET = "..."
```

**bash / zsh:**

```bash
export JWT_SECRET=dev-change-me
export MYSQL_DSN='root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4'
export REDIS_ADDR=127.0.0.1:6379
# export DEEPSEEK_API_KEY=sk-...
# Voice interviews (optional):
# export ALIYUN_ACCESS_KEY_ID=LTAI...
# export ALIYUN_ACCESS_KEY_SECRET=...
# export ALIYUN_NLS_APP_KEY=...
# Image (screenshot) import OCR (optional):
# export ALIYUN_OCR_ACCESS_KEY_ID=LTAI...   # falls back to ALIYUN_ACCESS_KEY_ID
# export ALIYUN_OCR_ACCESS_KEY_SECRET=...
```

## 4. Run the API server

```bash
cd backend
go run ./cmd/server
```

Verify:

```bash
curl http://127.0.0.1:8080/healthz
# {"ok":true}
```

On Windows PowerShell, use `curl.exe` if `curl` aliases to `Invoke-WebRequest`.

### Backend tests

Most backend integration tests require a reachable MySQL (they use the `interview` DB and clean up only their own test users). Point them at your instance via `MYSQL_DSN` (defaults to `root:root@tcp(127.0.0.1:3306)/interview`):

```bash
MYSQL_DSN='root:YOUR_PASSWORD@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4' go test ./...
```

Run with `-p 1` when the DB is shared by other processes/parallel jobs — the default parallel package execution across one MySQL instance can occasionally hit transient `Error 1213` deadlocks:

```bash
MYSQL_DSN='root:YOUR_PASSWORD@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4' go test ./... -p 1
```

### CORS

REST responses allow origins `http://localhost:5173` and `http://127.0.0.1:5173` with `Authorization` and `Content-Type` headers. WebSocket uses the same JWT via `?token=` query param (no CORS preflight).

## 5. Run the frontend

```bash
cd frontend
cp .env.example .env   # or set VITE_API_BASE manually
npm install
npm run dev
```

Frontend env (`.env` or shell):

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE` | `http://127.0.0.1:8080` | Backend REST base URL (WS origin derived from this) |

Open [http://localhost:5173](http://localhost:5173).

## Demo account flow

1. **Register** at `/register` (password ≥ 8 characters), or **login** at `/login`.
2. **Create interview** — paste a job description, pick mode (`behavioral`, `technical`, or `mixed`), optional resume text.
3. **Start** from the interview detail page (requires `DEEPSEEK_API_KEY` on the server).
4. **Interview room** — WebSocket delivers questions; type answers and submit. Reconnect preserves pending state from Redis.
5. **Voice interviews (optional)** — when creating an interview or starting a question-bank practice, choose **text** or **voice** as the input mode. Voice rooms read questions aloud via TTS, and you can hold the record button to speak an answer that is transcribed and auto-sent; typing remains available as a fallback. This requires the three Aliyun speech environment variables.
6. **End** — finish normally via WS or force end from the UI.
7. **Report** — view scores (expression, logic, content, job match), strengths, weaknesses, suggestions. Retry if generation failed.

### Quick API smoke test

```bash
# Register
curl -s -X POST http://127.0.0.1:8080/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"password123"}'

# Login (save token from response)
curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@example.com","password":"password123"}'

# Create interview (replace TOKEN)
curl -s -X POST http://127.0.0.1:8080/api/interviews \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"job_jd":"Backend engineer with Go and SQL","mode":"technical"}'
```

## Acceptance checklist

See [docs/superpowers/plans/acceptance-checklist.md](docs/superpowers/plans/acceptance-checklist.md) for MVP acceptance results (A1–A6).

## Known limitations

This MVP intentionally omits several production hardening features:

- **No `failed` status on abandon** — closing the browser or disconnecting mid-session does not mark the interview `failed`; use **End interview** (HTTP force-end works even when the WebSocket is down).
- **No per-user concurrency cap** — a user may have multiple `in_progress` sessions; only one live room per session is enforced via Redis.
- **Sync evaluation may delay the last `done`** — the WebSocket `done` message is sent after synchronous post-interview scoring; slow LLM calls can add noticeable latency before navigation to the report.
- **Rare concurrent `BeginLive` race** — two simultaneous WebSocket connects for the same session could briefly duplicate the first question; reconnect is idempotent in normal use.
- **A3/A6 need `DEEPSEEK_API_KEY`** — full end-to-end acceptance (start interview + scored report) requires a valid DeepSeek API key on the server.

## Project layout

```
backend/          Go API, migrations, internal packages
frontend/         Vite + React SPA
docker-compose.yml
.env.example
```
