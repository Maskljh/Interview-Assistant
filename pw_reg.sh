#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" open http://localhost:5174/register 2>&1 | head -8