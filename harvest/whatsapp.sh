#!/bin/bash
# Servizio sempre acceso: riceve gli allegati del WhatsApp personale e li mette in coda per l'archivio.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HERE_BOOT="$(cd "$(dirname "$0")" && pwd)"
source "$HERE_BOOT/trova-node.sh"
NODE="$(trova_node)" || { avvisa_senza_node; echo "node non trovato" >&2; exit 78; }
export HARVEST_QUIET=1
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "$NODE" "$HERE/whatsapp-daemon.mjs" "$@"
