# Interview Assistant

## Prerequisites

- Go 1.22+
- Docker (for MySQL and Redis)

## Quick start

1. Set environment variables in your shell (required before `go run`).

   The server reads **process environment only** (`os.Getenv`); it does not load a `.env` file.
   Use `.env.example` as a reference for variable names and defaults.

   **PowerShell (Windows):**

   ```powershell
   $env:JWT_SECRET = "dev-change-me"
   # optional overrides:
   # $env:HTTP_ADDR = ":8080"
   # $env:MYSQL_DSN = "root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4"
   # $env:REDIS_ADDR = "127.0.0.1:6379"
   ```

   **bash / zsh (Unix):**

   ```bash
   export JWT_SECRET=dev-change-me
   # optional overrides:
   # export HTTP_ADDR=:8080
   # export MYSQL_DSN='root:root@tcp(127.0.0.1:3306)/interview?parseTime=true&charset=utf8mb4'
   # export REDIS_ADDR=127.0.0.1:6379
   ```

2. Start dependencies:

   ```bash
   docker compose up -d
   ```

3. Run the API server:

   ```bash
   cd backend
   go run ./cmd/server
   ```

4. Verify health:

   ```bash
   curl http://127.0.0.1:8080/healthz
   ```

   Expected: `{"ok":true}`

   On Windows PowerShell, use `curl.exe` if `curl` aliases to `Invoke-WebRequest`.
