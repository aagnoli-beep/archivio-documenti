#!/bin/bash
# Installa (o reinstalla) la raccolta automatica notturna. Per rimuoverla: bash harvest/install.sh --uninstall
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/it.agnoli.archivio-harvest.plist"
if [ "${1:-}" = "--uninstall" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  launchctl unload "$HOME/Library/LaunchAgents/it.agnoli.archivio-whatsapp.plist" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/it.agnoli.archivio-whatsapp.plist"
  echo "Raccolta automatica e servizio WhatsApp rimossi."
  exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
# Verifico subito che node sia raggiungibile anche senza il PATH dell'utente (launchd non ce l'ha)
source "$HERE/trova-node.sh"
NODE_TROVATO="$(trova_node)" || { echo "ERRORE: non trovo node. Installalo o esporta NODE_BIN=/percorso/di/node e riprova."; exit 1; }
echo "Uso node: $NODE_TROVATO"
chmod +x "$HERE/harvest.sh"
launchctl unload "$PLIST" 2>/dev/null || true
sed -e "s#__SCRIPT__#$HERE/harvest.sh#" -e "s#__HOME__#$HOME#" "$HERE/it.agnoli.archivio-harvest.plist" > "$PLIST"
launchctl load "$PLIST"

# Servizio WhatsApp sempre acceso (si riavvia da solo se cade o se il Mac riparte).
# Con --solo-raccolta si installa solo il lavoro notturno (utile se WhatsApp non e' ancora collegato).
if [ "${1:-}" = "--solo-raccolta" ]; then
  echo "Raccolta automatica attiva ogni notte alle 3:20. Servizio WhatsApp non installato."
  exit 0
fi
PLIST_WA="$HOME/Library/LaunchAgents/it.agnoli.archivio-whatsapp.plist"
chmod +x "$HERE/whatsapp.sh"
launchctl unload "$PLIST_WA" 2>/dev/null || true
sed -e "s#__SCRIPT__#$HERE/whatsapp.sh#" -e "s#__HOME__#$HOME#" "$HERE/it.agnoli.archivio-whatsapp.plist" > "$PLIST_WA"
launchctl load "$PLIST_WA"

echo "Raccolta automatica attiva ogni notte alle 3:20. Log: ~/Library/Logs/archivio-harvest.log"
echo "Servizio WhatsApp attivo in sottofondo."
echo "Se non l'hai ancora fatto, collega WhatsApp una volta sola:  node $HERE/whatsapp-daemon.mjs --login"
echo "Prova subito senza caricare nulla:  node $HERE/daily-harvest.mjs --dry-run --days 7 --verbose"
