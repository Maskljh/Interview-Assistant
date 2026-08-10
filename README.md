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

## 2. Apply database migration

From the repo root:

```bash
docker compose exec -T mysql mysql -uroot -proot interview < backend/migrations/001_init.sql
```

If using an external MySQL host, run the same SQL file with your client:

```bash
mysql -h 127.0.0.1 -u root -p interview < backend/migrations/001_init.sql
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

\* Without `DEEPSEEK_API_KEY`, **start interview** returns `502` and reports stay unavailable. Auth, CRUD, and ownership checks still work.

**PowerShell (Windows):**

```powershell
$env:JWT_SECRET = "dev-change-me"
$env:MYSQL_DSN = "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
$env:REDIS_ADDR = "127.0.0.1:6379"
# Optional — required for full interview flow:
# $env:DEEPSEEK_API_KEY = "sk-..."
```

**bash / zsh:**

```bash
export JWT_SECRET=dev-change-me
export MYSQL_DSN='root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4'
export REDIS_ADDR=127.0.0.1:6379
# export DEEPSEEK_API_KEY=sk-...
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
5. **End** — finish normally via WS or force end from the UI.
6. **Report** — view scores (expression, logic, content, job match), strengths, weaknesses, suggestions. Retry if generation failed.

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

## Project layout

```
backend/          Go API, migrations, internal packages
frontend/         Vite + React SPA
docker-compose.yml
.env.example
```
