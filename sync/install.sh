#!/bin/bash
# Installa (o reinstalla) l'avvio automatico della sincronizzazione Google Drive -> iCloud ogni 15 minuti.
# Per rimuoverlo: bash sync/install.sh --uninstall
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/it.agnoli.archivio-sync.plist"
if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Sincronizzazione automatica rimossa."
  exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
launchctl unload "$PLIST" 2>/dev/null || true
sed -e "s#__SCRIPT__#$HERE/sync-icloud.sh#" -e "s#__HOME__#$HOME#" "$HERE/it.agnoli.archivio-sync.plist" > "$PLIST"
launchctl load "$PLIST"
echo "Sincronizzazione automatica attiva ogni 15 minuti. Log: ~/Library/Logs/archivio-sync.log"
