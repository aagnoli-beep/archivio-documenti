#!/bin/bash
# Wrapper lanciato da launchd ogni 15 minuti: usa lo script Node (scarica dal backend).
# Se manca ~/.config/archivio-documenti/config.json lo script Node salta e non fa nulla.
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || ls "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | tail -n 1)"
if [ -z "$NODE" ]; then echo "$(date '+%Y-%m-%d %H:%M:%S') ERRORE: node non trovato" >> "$HOME/Library/Logs/archivio-sync.log"; exit 1; fi
exec "$NODE" "$HERE/sync-icloud.mjs"
