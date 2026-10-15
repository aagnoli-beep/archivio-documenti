#!/bin/bash
# Lanciato da launchd ogni notte: cerca sul Mac i documenti di famiglia nuovi e li manda all'archivio.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE_BOOT="$(cd "$(dirname "$0")" && pwd)"
source "$HERE_BOOT/trova-node.sh"
NODE="$(trova_node)" || { avvisa_senza_node; echo "node non trovato" >&2; exit 78; }
export HARVEST_QUIET=1
HERE="$(cd "$(dirname "$0")" && pwd)"
# Prima gli allegati nuovi del WhatsApp personale, letti dal connettore gia' installato sul Mac,
# poi la raccolta vera e propria.
"$NODE" "$HERE/whatsapp-connettore.mjs" --giorni 3 || true

exec "$NODE" "$HERE/daily-harvest.mjs" "$@"
