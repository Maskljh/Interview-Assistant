#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" fill e17 "后端工程师，要求熟悉 Go 语言、MySQL 和 Redis，负责高并发 API 服务开发。"
"$PWCLI" select e28 "语音"
sleep 1
"$PWCLI" snapshot 2>&1 | head -30