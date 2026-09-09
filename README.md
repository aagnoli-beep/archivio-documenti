# Archivio Documenti di famiglia

Ogni documento cartaceo che arriva a casa viene scansionato con lo **ScanSnap iX2500**, finisce su **Google Drive**, viene letto e classificato da **Claude** (categoria, sottocategoria, tipo, mittente, destinatario, soggetti, date, riassunto), rinominato con i metadati nel nome e indicizzato in un **Google Sheet**. Il Mac copia l'archivio anche su **iCloud Drive**, così la famiglia trova i documenti nell'app **File** dell'iPhone. Un piccolo **sito web** permette in più di cercare con filtri e correggere i metadati.

```
ScanSnap iX2500 ──ScanSnap Cloud (Wi-Fi, senza PC)──▶ Drive: Archivio Documenti/00_Inbox
                                                              │
                        Google Apps Script (trigger ogni 5 minuti, gira su Google, gratis)
                                                              │
      ┌───────────────────────────────────────────────────────┼──────────────────────────┐
      ▼                                                       ▼                          ▼
 Claude API (PDF → JSON metadati)          rinomina + sposta in "Archivio"        riga nel Google Sheet "Indice"
                                           + descrizione/proprietà Drive          (+ export .xlsx ogni notte in "Backup")
                                                              │
                     Sito su GitHub Pages (docs/) con "Accedi con Google" ──▶ backend JSON Apps Script
                     ricerca / filtri / anteprima / download / correzioni / "Chiedi all'archivio" (Claude)
                                                              │
                     Mac (ogni 15 min) ──▶ iCloud Drive/Archivio Documenti ──▶ app File su iPhone della famiglia
```

**Dove stanno i file**: l'originale è su Google Drive (lì lavora lo scanner e la classificazione). iCloud Drive è una copia specchio aggiornata dal Mac. Il sito non conserva nulla: legge l'indice e mostra i file di Drive.

**Perché così**: non c'è nessun server da pagare o mantenere. Google Drive e il foglio indice sono la copia che sopravvive a tutto: anche se il sito o la chiave API smettessero di funzionare, i file restano su Drive con nome parlante, e il foglio (più l'export Excel settimanale) contiene tutto l'archivio.

**Se la chiave Claude smette di funzionare** (credito finito, chiave revocata): i documenti restano intatti in `00_Inbox`, il foglio `Log` registra l'errore e arriva un'email di avviso (al massimo una al giorno). Appena il problema è risolto, il trigger riprende da solo. Lo script **non cancella mai** un documento.

## Link dell'installazione

I link e gli ID della tua installazione (sito, foglio, cartelle, editor) sono nel file locale `PRIVATE.md`, che resta fuori dal repository.

## Struttura su Drive

```
Archivio Documenti/
  00_Inbox/          ← destinazione di ScanSnap Cloud (e degli upload dal sito)
  Archivio/          ← tutti i documenti rinominati, in un'unica cartella
  Backup/            ← Indice_YYYY-MM-DD.xlsx (ultimi 12, uno per notte)
  Archivio Documenti - Indice   ← Google Sheet con i fogli Indice, Config, Categorie, Log
```

Nome file: `YYYY-MM-DD_Categoria_Sottocategoria_Mittente_Destinatario_Titolo.pdf`
Esempio: `2026-03-12_Salute_Visita-specialistica_Dott-Mario-Rossi_Andrea-Agnoli_Referto-cardiologia.pdf`

Gli stessi metadati vengono scritti anche nella **descrizione** del file su Drive: la ricerca dell'app Google Drive li trova, e trova anche il testo dentro i PDF (lo ScanSnap fa l'OCR).

## Installazione (una volta sola, circa 30 minuti)

### 1. Chiave Claude
1. Vai su https://console.anthropic.com, crea un account e una **API key**.
2. In *Billing* carica un credito prepagato di 10–20 €. Un documento di 2–3 pagine costa circa 0,04–0,06 € con il modello predefinito (`claude-opus-5`); 300 documenti l'anno ≈ 15 €. Controlla in console la scadenza del credito prepagato.

### 2. Strumenti sul Mac
```bash
npm install
```
```bash
npx clasp login
```
Poi abilita l'API Apps Script per il tuo account: https://script.google.com/home/usersettings → *Google Apps Script API* → **On**.

### 3. Crea il foglio e lo script
```bash
npx clasp create --type sheets --title "Archivio Documenti - Indice" --rootDir src
```
Questo crea il Google Sheet e il progetto Apps Script collegato (e il file `.clasp.json`, che resta fuori da git). Poi carica il codice:
```bash
npx clasp push
```
Rispondi `y` se chiede di sovrascrivere il manifest.

### 4. Configura ed esegui il setup
```bash
npx clasp open
```
Nell'editor Apps Script:
1. **Impostazioni progetto** (ingranaggio) → *Proprietà dello script* → aggiungi `ANTHROPIC_API_KEY` = la chiave del punto 1.
2. Apri `Setup.gs`, seleziona la funzione `setupProject` e premi **Esegui**. Alla prima esecuzione Google chiede di autorizzare lo script (Drive, Fogli, email, chiamate esterne): accetta. Se compare "app non verificata" → *Avanzate* → *Vai a … (non sicuro)*: è normale per gli script personali.
3. Il setup crea le cartelle su Drive, i fogli con le intestazioni e due trigger (`processInbox` ogni 5 minuti, `exportIndexXlsx` ogni notte alle 3). Nel log di esecuzione trovi il link alla cartella `00_Inbox`.

Facoltativo: nel foglio **Config** puoi cambiare email per gli avvisi, soglia di confidenza, modello e nomi dei familiari; nel foglio **Categorie** puoi aggiungere o rinominare categorie e sottocategorie. Nessuna modifica al codice.

### 5. Pubblica il sito (GitHub Pages + Accedi con Google)
Il sito è una pagina statica in `docs/`, pubblicata da GitHub Pages; parla con Apps Script tramite un deployment "esegui come me, accesso a chiunque", e l'accesso è protetto dal token di "Accedi con Google" verificato dal backend contro la lista `ALLOWED_EMAILS`.

1. In Apps Script: **Distribuisci → Nuova distribuzione → App web**, *Esegui come: Me*, *Chi può accedere: Chiunque*. Copia l'URL `/exec`.
2. In Google Cloud Console (stesso account): **Google Auth Platform** → Branding (nome app, email) → Pubblico *Esterno* + utenti di prova (le email della famiglia) → **Client** → *Applicazione web* con origine JavaScript autorizzata `https://<utente>.github.io`. Copia il Client ID.
3. Nel foglio **Config**: `GOOGLE_CLIENT_ID`, `ALLOWED_EMAILS` (chi entra), `EDITOR_EMAILS` (chi può correggere e caricare), `SITE_URL`.
4. In `docs/config.js` inserisci `CLIENT_ID` e `API_URL`, poi push su GitHub e attiva Pages dalla cartella `docs/` (branch main).

Sul telefono: apri il sito, accedi con Google, poi "Aggiungi alla schermata Home".

Nota: le app web Apps Script aperte *direttamente* nel browser possono mostrare "Impossibile aprire il file" quando nel browser ci sono più account Google; il sito su GitHub Pages non ha questo problema perché non passa dal login interno di Google.

### 6. Condividi con la famiglia
Su Drive, condividi la cartella **Archivio Documenti** (tutta) e il foglio **Archivio Documenti - Indice**:
- Serena: **Editor** (può correggere i metadati e caricare dal sito)
- bambini: **Visualizzatore** (cercano, vedono, scaricano)

Ognuno apre il sito e accede con il proprio account Google: entrano solo le email elencate in `ALLOWED_EMAILS` nel foglio Config.

### 7. Configura lo scanner
Nell'app **ScanSnap Home** (Mac) o nell'app ScanSnap sul telefono:
1. Attiva **ScanSnap Cloud** e collega l'**account Google** di Andrea (quello che possiede la cartella).
2. Crea un profilo **"Archivio casa"** con destinazione **Google Drive → `Archivio Documenti/00_Inbox`**.
3. Impostazioni consigliate: PDF con **OCR (PDF ricercabile)**, colore automatico, **fronte/retro**, 300 dpi, rimozione pagine bianche.
4. Sul touchscreen dello scanner seleziona il profilo e premi Scan: lo scanner carica direttamente su Drive via Wi-Fi, senza computer acceso.

Importante: **un documento per scansione** (un job = un file). Se metti nell'ADF più documenti diversi in un colpo solo, verranno classificati come un unico documento. Se vuoi scansionare in blocco, attiva in ScanSnap Home la separazione con pagina bianca o con codice di separazione.

### 8. Copia su iCloud Drive per l'app File (famiglia Apple)
La copia scarica i documenti direttamente dal backend (non dipende da Google Drive per desktop). Serve la **chiave di famiglia**: nel progetto Apps Script → Impostazioni → Proprietà dello script aggiungi `MCP_SECRET` con una stringa lunga e casuale, e sul Mac crea `~/.config/archivio-documenti/config.json`:
```json
{ "apiUrl": "https://script.google.com/macros/s/.../exec", "secret": "la-stessa-stringa" }
```
Poi attiva l'automatismo ogni 15 minuti con `bash sync/install.sh` (log in `~/Library/Logs/archivio-sync.log`). Su iPhone: app File → iCloud Drive → tieni premuto "Archivio Documenti" → Condividi → Collabora con la famiglia.

### 9. Server MCP: chiedere all'archivio da Claude
In `mcp/` c'è un server MCP locale (Node) che espone 6 strumenti: `cerca_documenti`, `dettaglio_documento`, `documenti_recenti`, `chiedi_archivio`, `scarica_documento`, `correggi_documento`. Usa la stessa chiave di famiglia letta da `~/.config/archivio-documenti/config.json`.
```bash
cd mcp && npm install && npm test
```
Claude Desktop: in `~/Library/Application Support/Claude/claude_desktop_config.json` aggiungi
```json
{ "mcpServers": { "archivio-di-casa": { "command": "node", "args": ["/percorso/al/repo/mcp/server.mjs"] } } }
```
e riavvia Claude Desktop. Claude Code: `claude mcp add archivio-di-casa -- node /percorso/al/repo/mcp/server.mjs`.

### 10. Connettore MCP remoto (claude.ai su web e telefono)
In `remote/` c'è un Cloudflare Worker (piano gratuito) che espone gli stessi strumenti come **connettore MCP remoto** con OAuth 2.1: claude.ai lo aggiunge da *Impostazioni → Connettori → Aggiungi connettore personalizzato* con l'indirizzo `https://<nome>.<sottodominio>.workers.dev/mcp`. Al primo uso si apre la pagina di accesso in cui si inserisce nome e **chiave di famiglia**; il Worker la verifica col backend e la conserva solo cifrata nel token del client.
```bash
cd remote && npm install --legacy-peer-deps
npx wrangler login
npx wrangler kv namespace create OAUTH_KV     # copia l'id in wrangler.jsonc
npx wrangler deploy
REMOTE_URL=https://<il-tuo-worker>.workers.dev node test.mjs   # test end-to-end (OAuth + MCP)
```
Claude Code: `claude mcp add --transport http archivio-di-casa https://<il-tuo-worker>.workers.dev/mcp`.

#### Vecchia copia via Google Drive per desktop
1. Installa **Google Drive per desktop** sul Mac (https://www.google.com/drive/download/) e accedi con l'account Google di Andrea. Nel Finder compare `Google Drive/Il mio Drive/Archivio Documenti`.
2. Nel Finder, tasto destro sulla cartella `Archivio Documenti` → **Disponibile offline** (così i file sono davvero sul disco e non solo segnaposto).
3. Attiva la sincronizzazione automatica ogni 15 minuti:
```bash
bash sync/install.sh
```
   Il primo passaggio parte subito; poi ogni 15 minuti copia `Archivio` e l'ultimo indice Excel in `iCloud Drive/Archivio Documenti`. Log in `~/Library/Logs/archivio-sync.log`. Per disattivare: `bash sync/install.sh --uninstall`.
4. Sul Mac o sull'iPhone, app File → iCloud Drive → `Archivio Documenti` → **Condividi** → *Collabora* → aggiungi Serena e i bambini (solo visualizzazione va benissimo). Da quel momento la cartella compare nel loro iCloud Drive.

Sul telefono: app File → iCloud Drive → Archivio Documenti, oppure Spotlight scrivendo una parola del nome (es. "Enel", "referto", "Andrea"). Il file `Indice.xlsx` si apre con Numbers.

Protezioni dello script: legge soltanto da Google Drive; se Drive non è montato o la cartella è vuota non fa nulla; se la sorgente ha meno della metà dei file della copia si ferma e scrive nel log invece di cancellare.

### 11. Rendiconto giornaliero via email
Ogni sera (ora `DIGEST_HOUR`, default 20) lo script manda ai destinatari di `DIGEST_EMAILS` (foglio Config) un'email con i documenti scansionati dall'ultimo invio: fino a 10 con due righe discorsive scritte da Claude e i link, da 11 a 30 una tabella, oltre 30 solo il conteggio. Nessuna email se non è arrivato nulla. I documenti "da verificare" sono evidenziati. Per provarla subito: esegui `sendDailyDigest` dall'editor Apps Script.

### 12. Altri modi per inserire documenti (oltre allo scanner)
- **Email**: inoltra qualsiasi email con PDF o foto a `andrea.agnoli.1984+archivio@gmail.com` (Config `MAIL_INTAKE_ADDRESS`); dal telefono, Foto → Condividi → Mail a quel contatto. Entrano solo i mittenti di `MAIL_SENDERS`. Se l'email non ha allegati, diventa lei stessa un PDF. Ogni 5 minuti (`processMailIntake`), messaggi etichettati `Archivio/Elaborate` o `Archivio/Ignorate`, mai cancellati. Richiede lo scope Gmail (autorizzazione una tantum dall'editor).
- **Cartella iCloud "Archivio"**: basta mettere file e foto direttamente lì (anche da iPhone con "Salva su File"), mescolati agli altri. Lo script del Mac riconosce i file che non ha scritto lui (tiene la lista in `.archivio-sync.json`), li invia alla Inbox di Drive entro 15 minuti e li toglie; una volta classificati ricompaiono con il nome giusto. Le foto HEIC vengono convertite in JPEG dal Mac (`sips`); se un HEIC arriva a Drive per altre vie, lo converte lo script usando l'anteprima di Drive.
- **Bottone + del sito**: carica PDF o foto direttamente nella Inbox.
- **WhatsApp**: non attivo. Servirebbe l'API ufficiale Meta (account Meta Business, app sviluppatore, numero di telefono dedicato non già usato su WhatsApp) e un webhook sul Worker: fattibile in un secondo momento.

## Uso quotidiano
1. Arriva una lettera → la metti nello scanner → Scan.
2. Entro 5 minuti il file è in `Archivio`, rinominato, con la riga nel foglio e visibile nel sito; entro altri 15 minuti (Mac acceso) compare anche nell'app File.
3. Se la classificazione è incerta (confidenza bassa) il documento è segnato **Da verificare**: nel sito appare il banner giallo, apri la scheda, premi *Modifica*, correggi e salva. Il file viene rinominato e lo stato diventa *Verificato*.
4. Dal telefono puoi anche fotografare un documento e caricarlo dal sito (bottone *+*): entra nella stessa coda dello scanner.
5. Nella scheda **Chiedi** fai domande in italiano ("quando scade l'assicurazione?"): l'assistente risponde usando le schede dei documenti e ti mostra quelli citati.

## Manutenzione e problemi
- **Foglio `Log`**: ogni classificazione, avviso ed errore, con data e nome file.
- **Email "Classificazione ferma"**: controlla chiave e credito su console.anthropic.com; i file aspettano in `00_Inbox`.
- **File rimasto in Inbox** senza email: probabilmente il trigger non gira. In Apps Script → *Trigger* controlla che esistano; altrimenti esegui `installTriggers()`.
- **Documento in Archivio senza riga nel foglio**: esegui `reindexMissing()` in Apps Script.
- **Test manuale della classificazione** senza spostare nulla: metti un PDF in Inbox ed esegui `testClassifyFirstInboxFile()`, il risultato JSON è nel log di esecuzione.
- **Cambiare modello o costi**: nel foglio `Config` la riga `MODEL` (es. `claude-haiku-4-5` costa circa 5 volte meno, con classificazioni un po' meno precise).
- **Backup**: ogni notte un file Excel dell'indice in `Backup/`, copiato anche su iCloud come `Indice.xlsx`. Puoi anche generarlo subito eseguendo `exportIndexXlsx()`.

## Struttura del codice (`src/`)
| File | Cosa fa |
|---|---|
| `appsscript.json` | Manifest: fuso orario, scopi OAuth, servizio Drive v3, impostazioni web app |
| `Config.gs` | Costanti, Script Properties, lettura dei fogli Config e Categorie |
| `Pipeline.gs` | `processInbox()`: ciclo su Inbox, gestione errori e tentativi, `reindexMissing()` |
| `Classifier.gs` | Chiamata HTTP a Claude con PDF/immagine in base64 e output JSON vincolato |
| `DriveUtils.gs` | Nome file, slug ASCII, descrizione/proprietà Drive, OCR via Drive |
| `Index.gs` | Foglio Indice e Log, export Excel |
| `Alerts.gs` | Email di avviso (una al giorno per tipo) |
| `Digest.gs` | Rendiconto giornaliero via email dei documenti scansionati |
| `MailIntake.gs` | Ingresso documenti via email (allegati o email → PDF) |
| `Setup.gs` | `setupProject()` e `installTriggers()` |
| `Api.gs` | Backend JSON del sito: verifica del token Google, indice, file, correzioni, upload |
| `Ask.gs` | "Chiedi all'archivio": risposte alle domande sui documenti con Claude |
| `../docs/` | Il sito (HTML, CSS, JavaScript) pubblicato su GitHub Pages |
| `../sync/sync-icloud.mjs`, `install.sh` | Copia dal backend a iCloud Drive dal Mac, con avvio automatico launchd |
| `../mcp/server.mjs`, `tools.mjs` | Server MCP locale (stdio) e strumenti condivisi (`npm test` in `mcp/`) |
| `../remote/src/index.js` | Connettore MCP remoto su Cloudflare Workers con OAuth (`node test.mjs` in `remote/`) |
| `../test/run.js` | 32 scenari della pipeline in un Apps Script simulato: `npm test` |

Il codice è versionato in questo repository; su Google viene pubblicato con `npx clasp push`. La chiave API vive solo nelle Script Properties, mai nel repository.
