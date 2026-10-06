# Come l'archivio legge WhatsApp (scheda per chi ci mette mano)

Scopo: salvare gli allegati (documenti e foto) che arrivano sul WhatsApp **personale** del proprietario e
passarli alla pipeline dell'archivio. Solo lettura: non si inviano messaggi, non si segna nulla come letto.

## Scelta tecnica

Non si legge la pagina di WhatsApp Web. Il Mac si registra come **dispositivo collegato** (companion
device) e parla il protocollo multi-device: WebSocket + crittografia Signal, tramite
`@whiskeysockets/baileys` **6.7.18**. Quindi i cambi di grafica di WhatsApp non lo toccano.

Due strade scartate, con il motivo:
- **Scraping del DOM con Playwright**: funzionava, ma i selettori cambiano a ogni restyling. Abbandonato.
- **`whatsapp-web.js` 1.34.7**: si collega e legge i contatti, ma `getChats()` muore con un errore
  minificato `r` su WhatsApp Web 2.3000.104x. Inutile insistere, anche fissando `webVersionCache`.
- **Baileys 7.0.0-rc**: l'abbinamento viene rifiutato dal telefono. Serve la 6.7.18.

## Collegamento (una volta sola)

File: `harvest/whatsapp-daemon.mjs`. Credenziali in `~/.config/archivio-documenti/whatsapp-auth`
(`useMultiFileAuthState`, ~33 file: `creds.json`, pre-key, app-state-sync).

```bash
node harvest/whatsapp-daemon.mjs --login              # QR nel terminale + PNG sulla Scrivania
node harvest/whatsapp-daemon.mjs --pair 39XXXXXXXXXX  # codice di 8 caratteri da digitare sul telefono
```

Dettagli che fanno la differenza:
- **Subito dopo l'abbinamento WhatsApp chiude la connessione con codice 515.** È normale: bisogna
  riconnettersi immediatamente. Se il processo esce, sul telefono resta "Accesso in corso" e sembra
  che non funzioni. La riconnessione automatica è dentro `avviaConnessione()`.
- Il **codice numerico scade in poco più di un minuto**: va digitato con la schermata già aperta.
- `browser: ['Archivio di casa', 'Chrome', '121.0.0']` è il nome che il proprietario vede in
  *Dispositivi collegati*: serve perché sappia cos'è e possa staccarlo.

## Servizio sempre acceso

`launchd` → `it.agnoli.archivio-whatsapp` (`harvest/it.agnoli.archivio-whatsapp.plist`), con
`KeepAlive.SuccessfulExit = false`, `ThrottleInterval 120`, avviato da `harvest/whatsapp.sh`.
Node **non è nel PATH di launchd** (sta sotto `~/.nvm/...`): lo risolve `harvest/trova-node.sh`.
Caduta di connessione → attesa crescente e nuovo tentativo. `loggedOut` → credenziali cancellate ed
email di avviso. A ogni collegamento, e poi ogni 6 ore, chiama l'azione `heartbeat` del backend: se il
battito manca per più di 2 giorni, il controllo serale manda un'email.

## Lettura dei messaggi

Evento `messages.upsert`. **Si accettano sia `notify` sia `append`**: `notify` sono i messaggi ricevuti,
`append` quelli inviati dal proprietario da un altro dispositivo. Ignorare `append` è stato un bug reale:
il gruppo "Documenti" restava sempre vuoto, perché i documenti li caricava lui.

- Ricevuto o proprio: `m.key.fromMe`. I propri si scartano, **tranne** in corsia diretta.
- Nomi dei gruppi: `groupFetchAllParticipating()` al collegamento, messi in una `Map` (355 gruppi).
  Non chiederli per messaggio: la chiamata può fallire proprio mentre arriva il documento.
- Allegati: `documentMessage`, `documentWithCaptionMessage.message.documentMessage`, `imageMessage`.
- Scarico: `downloadMediaMessage(m, 'buffer')`. Se fallisce con *"Cannot derive from empty media key"*
  (capita con gli inoltri) si chiama `sock.updateMediaMessage(m)`, che fa rimandare il file dal telefono,
  e si riprova una volta.
- Ammessi: PDF, JPEG, PNG, HEIC, DOC, DOCX, XLSX. Minimo 15 KB (5 KB in corsia diretta), massimo 25 MB.
- Stato in `whatsapp-state.json`, chiave `m.key._serialized`: niente doppioni fra riavvii.

## Due corsie

| Corsia | Quando | Dove finisce | Cosa succede |
|---|---|---|---|
| normale | qualsiasi chat | `~/.config/archivio-documenti/whatsapp-inbox` | passa dalla selezione notturna |
| diretta | gruppo in `harvest.gruppiArchivio` (default `["Documenti"]`) o chat con se stessi | `~/.config/archivio-documenti/whatsapp-diretti` | archiviato senza selezione, file rimosso dopo il caricamento |

Il transito normale si ripulisce dopo 14 giorni.

## Il giro giornaliero

`launchd` → `it.agnoli.archivio-harvest`, ogni notte alle 3:20, esegue `harvest/daily-harvest.mjs`, che
tratta quelle due cartelle come sorgenti insieme a Scrivania, Download, Documenti, iCloud Drive, libreria
Foto e caselle di posta personali:

1. estrae il testo in locale (`pdftotext`; `pdftoppm` + `tesseract -l ita+eng` per scansioni e foto; `sips` per HEIC);
2. filtro locale a costo zero (nomi di famiglia, parole da documento, esclusioni);
3. i superstiti vanno all'azione backend **`judge`** (`src/Judge.gs`, modello `claude-sonnet-5`): riceve
   **solo testo**, mai il file, così la chiave API resta nelle Script Properties di Apps Script;
4. la corsia diretta salta i punti 2 e 3;
5. gli approvati vanno nell'Inbox di Drive con l'azione `upload` (massimo 25 al giorno, `harvest.massimoAlGiorno`),
   e da lì parte la classificazione normale dell'archivio.

## Limiti da sapere

- Client non ufficiale: formalmente contro le condizioni di WhatsApp. Uso personale, in sola lettura e a
  basso volume: rischio basso ma non nullo (al limite, limitazioni sull'account).
- **Niente storico**: arrivano solo i messaggi successivi al collegamento. Quelli di prima non si recuperano.
- A Mac spento i messaggi restano in coda sul telefono e vengono consegnati alla riconnessione.
- Registro unico: `~/Library/Logs/archivio-harvest.log`, righe con prefisso `[whatsapp]`.
