#!/bin/bash
# Installa (o reinstalla) la raccolta automatica notturna. Per rimuoverla: bash harvest/install.sh --uninstall
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/it.agnoli.archivio-harvest.plist"
if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Raccolta automatica rimossa."
  exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
chmod +x "$HERE/harvest.sh"
launchctl unload "$PLIST" 2>/dev/null || true
sed -e "s#__SCRIPT__#$HERE/harvest.sh#" -e "s#__HOME__#$HOME#" "$HERE/it.agnoli.archivio-harvest.plist" > "$PLIST"
launchctl load "$PLIST"
echo "Raccolta automatica attiva ogni notte alle 3:20. Log: ~/Library/Logs/archivio-harvest.log"
echo "Prova subito senza caricare nulla:  node $HERE/daily-harvest.mjs --dry-run --days 7 --verbose"
