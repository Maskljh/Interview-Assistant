#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" eval "() => { const el = document.querySelector('.video-persona-ivh'); return { hasContainer: !!el, ivhExists: !!window.IVH }; }" 2>&1 | head -12