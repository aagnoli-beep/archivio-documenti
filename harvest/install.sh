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

# Il vecchio servizio con dispositivo collegato (QR) non serve piu': gli allegati arrivano dal
# connettore WhatsApp gia' installato, letto dal giro notturno.
launchctl unload "$HOME/Library/LaunchAgents/it.agnoli.archivio-whatsapp.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/it.agnoli.archivio-whatsapp.plist"

echo "Raccolta automatica attiva ogni notte alle 3:20. Log: ~/Library/Logs/archivio-harvest.log"
echo "Prova subito senza caricare nulla:  node $HERE/daily-harvest.mjs --dry-run --days 7 --verbose"
