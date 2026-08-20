#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" fill e19 "前端工程师，要求熟悉 React、TypeScript 和 WebSocket，负责实时交互界面开发。"
"$PWCLI" select e30 "语音"
sleep 1
"$PWCLI" snapshot 2>&1 | head -15