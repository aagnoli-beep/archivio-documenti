#!/bin/bash
# Lanciato da launchd ogni notte: cerca sul Mac i documenti di famiglia nuovi e li manda all'archivio.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HARVEST_QUIET=1
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/daily-harvest.mjs" "$@"
