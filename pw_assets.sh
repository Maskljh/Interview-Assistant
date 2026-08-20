#!/bin/bash
PWCLI=/mnt/c/Users/l/.codex/skills/playwright/scripts/playwright_cli.sh
"$PWCLI" eval "() => { return { url: location.href, scripts: Array.from(document.querySelectorAll('script[src]')).map(s=>s.src), swRegs: navigator.serviceWorker ? 'supported' : 'no' }; }" 2>&1 | head -30