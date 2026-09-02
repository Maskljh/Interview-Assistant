#!/usr/bin/env bash
# 一键启动开发环境：Docker(MySQL+Redis) + 后端
# 用法：bash start-dev.sh  （在 Git Bash 中执行）
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 从 docker-compose.yml 自动读取 MySQL 密码（与 MYSQL_ROOT_PASSWORD 保持同步）
MYSQL_PWD=$(grep -oE 'MYSQL_ROOT_PASSWORD:[[:space:]]*[^#[:space:]]+' docker-compose.yml | grep -oE '[^[:space:]:]+$' | head -1)
if [ -z "$MYSQL_PWD" ]; then
  echo "!! 无法从 docker-compose.yml 读取 MySQL 密码"; exit 1
fi

# ---------- 1. 确保 Docker 引擎运行 ----------
if ! docker info >/dev/null 2>&1; then
  echo ">> 启动 Docker Desktop ..."
  "/c/Program Files/Docker/Docker/Docker Desktop.exe" &
  for i in $(seq 1 60); do
    sleep 2
    if docker info >/dev/null 2>&1; then break; fi
    if [ "$i" -eq 60 ]; then echo "!! Docker 引擎启动超时，请手动打开 Docker Desktop"; exit 1; fi
  done
fi
echo ">> Docker 引擎就绪"

# ---------- 2. 启动 MySQL / Redis 容器 ----------
docker compose up -d

# ---------- 3. 等待 MySQL 就绪 ----------
echo ">> 等待 MySQL 就绪 ..."
for i in $(seq 1 30); do
  if docker exec interviewassistant-mysql-1 mysqladmin ping -uroot -p"$MYSQL_PWD" >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then echo "!! MySQL 启动超时"; exit 1; fi
  sleep 2
done

# ---------- 4. 首次启动自动执行数据库迁移 ----------
TABLES=$(docker exec interviewassistant-mysql-1 mysql -uroot -p"$MYSQL_PWD" -N -e \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='interview'" 2>/dev/null || echo "0")
if [ "$TABLES" = "0" ]; then
  echo ">> 首次启动，执行数据库迁移 ..."
  for f in backend/migrations/*.sql; do
    docker exec -i interviewassistant-mysql-1 mysql -uroot -p"$MYSQL_PWD" interview < "$f"
  done
fi

# ---------- 5. 编译并启动后端 ----------
echo ">> 停止已在运行的后端（避免端口占用）..."
netstat -ano 2>/dev/null | grep LISTENING | grep ":18080" | awk '{print $NF}' | sort -u | while read pid; do
  taskkill //PID "$pid" //F >/dev/null 2>&1 || true
done
sleep 1

echo ">> 编译后端 ..."
mkdir -p backend/.gotmp/cache
cd backend
GOTMPDIR="$ROOT/backend/.gotmp" GOCACHE="$ROOT/backend/.gotmp/cache" \
  go build -o server_docker.exe ./cmd/server

echo ">> 启动后端 :18080 ..."
nohup ./server_docker.exe > server_docker.log 2>&1 &

# 轮询等待后端监听端口（最多 20 秒）
for i in $(seq 1 20); do
  if netstat -ano 2>/dev/null | grep LISTENING | grep -q ":18080"; then
    echo "== 完成：后端 http://127.0.0.1:18080 =="
    exit 0
  fi
  sleep 1
done
echo "!! 后端启动异常，请查看 backend/server_docker.log"
