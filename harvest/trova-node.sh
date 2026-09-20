#!/bin/bash
# Trova l'eseguibile di node anche quando il lavoro parte da launchd, che non conosce il PATH
# dell'utente (con nvm, fnm o volta node NON sta in /usr/local/bin). Se non lo trova, avvisa per email
# usando solo curl, così il guasto non resta silenzioso.
trova_node() {
  local candidati=(
    "$NODE_BIN"
    /opt/homebrew/bin/node
    /usr/local/bin/node
    /usr/bin/node
    "$HOME/.volta/bin/node"
  )
  for c in "${candidati[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  # nvm e fnm: prendo la versione più recente installata
  local ultimo
  ultimo=$(ls -1d "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1)
  [ -n "$ultimo" ] && [ -x "$ultimo" ] && { echo "$ultimo"; return 0; }
  return 1
}

avvisa_senza_node() {
  local cfg="$HOME/.config/archivio-documenti/config.json"
  [ -f "$cfg" ] || return 0
  local url chiave
  url=$(sed -n 's/.*"apiUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -1)
  chiave=$(sed -n 's/.*"secret"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$cfg" | head -1)
  [ -n "$url" ] && [ -n "$chiave" ] || return 0
  curl -s -L --max-time 60 "$url" --data "{\"action\":\"avviso\",\"secret\":\"$chiave\",\"chiave\":\"node\",\"oggetto\":\"Il Mac non trova Node\",\"testo\":\"I lavori automatici dell'archivio non partono perche' non trovo il programma node sul Mac. Probabilmente e' stato aggiornato o rimosso. Il resto dell'archivio continua a funzionare.\"}" > /dev/null || true
}
