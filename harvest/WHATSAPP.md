# Come l'archivio legge WhatsApp (scheda per chi ci mette mano)

Scopo: salvare gli allegati (documenti e foto) che arrivano sul WhatsApp **personale** del proprietario e
passarli alla pipeline dell'archivio. Solo lettura: non si inviano messaggi, non si segna nulla come letto.

## Come funziona oggi (dal 15/10/2026)

Gli allegati **non** li prende più un nostro dispositivo collegato. Sul Mac è installato il **connettore
WhatsApp** (cartella `~/Desktop/Claude Code Progetti/Whatsapp`), che:
- è collegato ai due account, personale e lavoro, e resta collegato per conto suo;
- tiene un database SQLite per account (`data/personale/whatsapp.db`: tabelle `messages`, `chats`, `contacts`);
- espone un servizio locale su `127.0.0.1:3791` che consegna l'allegato di un messaggio, con il token
  che sta in `data/personale/token.txt`.

`harvest/whatsapp-connettore.mjs` (lanciato dal giro notturno, prima della raccolta) fa tre cose:
1. legge il database **in sola lettura** (`sqlite3 -readonly`) cercando i messaggi con allegato degli ultimi giorni;
2. scarta quello che non serve: tipi non ammessi, file sotto i 15 KB o sopra i 25 MB, roba inviata da noi
   (tranne in corsia diretta), e quello già visto (stato in `~/.config/archivio-documenti/whatsapp-connettore-state.json`);
3. scarica i superstiti dal servizio locale e li mette in `whatsapp-inbox` oppure, per il gruppo
   **"Documenti"** e la chat con se stessi, in `whatsapp-diretti` (corsia diretta, niente selezione).

Si usa solo l'account **personale**: quello di lavoro non viene mai letto.

## Perché abbiamo cambiato

La prima versione usava `@whiskeysockets/baileys` e registrava il Mac come dispositivo collegato (QR).
Ha funzionato, ma: WhatsApp chiude la sessione con codice 515 subito dopo l'abbinamento e va riconnessa;
la versione del protocollo va tenuta aggiornata o la connessione viene rifiutata con 405; i posti per i
dispositivi collegati sono quattro e si esauriscono; dopo qualche tentativo WhatsApp blocca gli
abbinamenti ("impossibile collegare nuovi dispositivi in questo momento"); ed è formalmente contro le
condizioni d'uso. Il 9 ottobre il servizio è morto e non si è più potuto ricollegare.
Il connettore risolve tutto questo: è già collegato, non consuma un nostro posto e non va mantenuto da noi.

## Il dettaglio che era costato di più (vale ancora)

I messaggi che il proprietario invia da un altro dispositivo arrivano con un'etichetta diversa da quelli
ricevuti. Ignorarli significava non vedere mai i documenti caricati **da lui** nel gruppo "Documenti".
Nel database del connettore la differenza è la colonna `from_me`: in corsia diretta si prendono comunque.

## Due corsie

| Corsia | Quando | Dove finisce | Cosa succede |
|---|---|---|---|
| normale | qualsiasi chat | `~/.config/archivio-documenti/whatsapp-inbox` | passa dalla selezione notturna |
| diretta | gruppo in `harvest.gruppiArchivio` (default `["Documenti"]`) o chat con se stessi | `~/.config/archivio-documenti/whatsapp-diretti` | archiviato senza selezione, file rimosso dopo il caricamento |

## Il giro giornaliero

`launchd` → `it.agnoli.archivio-harvest`, ogni notte alle 3:20, esegue `harvest/harvest.sh`, che lancia
prima `whatsapp-connettore.mjs --giorni 3` e poi `daily-harvest.mjs`. Quest'ultimo tratta le due cartelle
come sorgenti insieme a Scrivania, Download, Documenti, iCloud Drive, libreria Foto e caselle personali:
estrae il testo in locale (OCR compreso), scarta il rumore, e manda **solo il testo** all'azione `judge`
del backend, dove Claude decide. Gli approvati vanno nell'Inbox di Drive, al massimo 25 al giorno.
A fine giro viene registrato il battito `whatsapp`: se manca per più di 2 giorni, il controllo serale avvisa.

## Impostazioni (`~/.config/archivio-documenti/config.json`, sezione `harvest`)

| Chiave | Significato |
|---|---|
| `connettoreWhatsApp` | cartella dati dell'account personale del connettore |
| `portaConnettore` | porta del servizio locale (3791) |
| `gruppiArchivio` | gruppi in corsia diretta (default `["Documenti"]`) |
| `numeroPersonale` | numero usato per riconoscere la chat con se stessi |

## Limiti

- Se il connettore viene spento o scollegato, il giro notturno non trova allegati nuovi: il battito manca
  e dopo due giorni arriva l'email di avviso.
- Dal database si vedono solo i messaggi che il connettore ha registrato: quelli precedenti alla sua
  installazione non ci sono.
- Registro unico: `~/Library/Logs/archivio-harvest.log`, righe con prefisso `[whatsapp]`.
