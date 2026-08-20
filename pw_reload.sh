#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
cd /mnt/c/Users/l/Desktop/Interview\ Assistant
rm -f .playwright-cli/console-*.log
"$PWCLI" reload 2>&1 | head -5
sleep 25
ls -t .playwright-cli/console-*.log 2>/dev/null | head -1 | xargs cat 2>/dev/null | tail -25