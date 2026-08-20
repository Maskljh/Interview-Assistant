#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" eval "() => { const v = window.IVH; return { hasIVH: !!v, ivhKeys: v ? Object.keys(v).slice(0,20) : [] }; }" 2>&1 | head -20