#!/bin/bash
# Copia la cartella "Archivio Documenti" da Google Drive (originale) a iCloud Drive (specchio per la famiglia).
# Lanciato da launchd ogni 15 minuti (vedi install.sh). Log in ~/Library/Logs/archivio-sync.log
#
# Sicurezza:
# - non tocca mai Google Drive (solo lettura);
# - se Google Drive non è montato o la cartella è vuota, non fa nulla;
# - se la sorgente ha molti meno file della copia (es. Drive disconnesso a metà), si ferma invece di cancellare;
# - i file rimossi o rinominati su Drive vengono rimossi anche da iCloud (Drive è la verità), ma solo dentro "Archivio".
set -u

LOG="$HOME/Library/Logs/archivio-sync.log"
DST="${ARCHIVIO_DST:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Archivio Documenti}"
SRC="${ARCHIVIO_SRC:-}"

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# 1. Trova la cartella su Google Drive per desktop (nome della cartella radice in italiano o inglese)
if [ -z "$SRC" ]; then
  for base in "$HOME"/Library/CloudStorage/GoogleDrive-*; do
    for mine in "Il mio Drive" "My Drive"; do
      if [ -d "$base/$mine/Archivio Documenti" ]; then SRC="$base/$mine/Archivio Documenti"; break 2; fi
    done
  done
fi
if [ -z "$SRC" ] || [ ! -d "$SRC/Archivio" ]; then
  log "SKIP: cartella 'Archivio Documenti/Archivio' non trovata su Google Drive (Google Drive per desktop installato e connesso?)"
  exit 0
fi

# 2. Conta i file: se la sorgente è vuota o sospettosamente più piccola della copia, fermati
src_n=$(find "$SRC/Archivio" -type f ! -name '.*' | wc -l | tr -d ' ')
dst_n=0
[ -d "$DST/Archivio" ] && dst_n=$(find "$DST/Archivio" -type f ! -name '.*' | wc -l | tr -d ' ')
if [ "$src_n" -eq 0 ]; then
  log "SKIP: 'Archivio' su Google Drive è vuoto (non ancora scaricato in locale?)"
  exit 0
fi
if [ "$dst_n" -gt 20 ] && [ "$src_n" -lt $((dst_n / 2)) ]; then
  log "STOP: la sorgente ha $src_n file, la copia iCloud ne ha $dst_n: troppo diverso, non cancello nulla. Controlla Google Drive."
  exit 1
fi

mkdir -p "$DST/Archivio"

# 3. Archivio: specchio esatto (aggiunte, rinomine, rimozioni)
out=$(rsync -a --delete --exclude '.*' "$SRC/Archivio/" "$DST/Archivio/" 2>&1); rc=$?
if [ $rc -ne 0 ]; then log "ERRORE rsync Archivio (rc=$rc): $out"; exit 1; fi

# 4. Indice Excel: copia l'export più recente come "Indice.xlsx"
latest=$(ls -1 "$SRC/Backup"/Indice_*.xlsx 2>/dev/null | sort | tail -n 1)
if [ -n "$latest" ]; then
  cp -p "$latest" "$DST/Indice.xlsx.tmp" && mv -f "$DST/Indice.xlsx.tmp" "$DST/Indice.xlsx"
fi

new_n=$(find "$DST/Archivio" -type f ! -name '.*' | wc -l | tr -d ' ')
log "OK: $new_n documenti in iCloud (sorgente $src_n)${latest:+, indice aggiornato da $(basename "$latest")}"
