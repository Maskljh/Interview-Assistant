#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
sleep 25
"$PWCLI" snapshot 2>&1 | head -60