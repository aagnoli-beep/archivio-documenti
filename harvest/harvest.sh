#!/bin/bash
# Lanciato da launchd ogni notte: cerca sul Mac i documenti di famiglia nuovi e li manda all'archivio.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HARVEST_QUIET=1
HERE="$(cd "$(dirname "$0")" && pwd)"
# Prima i documenti personali da WhatsApp Web (se la sessione è collegata), poi la raccolta vera e propria.
node "$HERE/whatsapp-web.mjs" || true
exec node "$HERE/daily-harvest.mjs" "$@"
