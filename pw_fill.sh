#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" fill e10 "uitest_$(date +%s)@example.com"
"$PWCLI" fill e13 "password123"
"$PWCLI" click e14
sleep 3
"$PWCLI" snapshot 2>&1 | head -30