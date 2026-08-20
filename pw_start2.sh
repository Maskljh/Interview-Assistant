#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" click e37
sleep 30
"$PWCLI" snapshot 2>&1 | head -50