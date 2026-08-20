#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" goto http://localhost:5174/interviews/new 2>&1 | head -4
sleep 1
"$PWCLI" snapshot 2>&1 | head -40