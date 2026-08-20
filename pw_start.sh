#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" click e35
sleep 4
"$PWCLI" snapshot 2>&1 | head -40