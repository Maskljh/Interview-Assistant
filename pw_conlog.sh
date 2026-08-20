#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
cd /mnt/c/Users/l/Desktop/Interview\ Assistant
ls -t .playwright-cli/console-*.log 2>/dev/null | head -1 | xargs cat 2>/dev/null | tail -30