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
                                           + descrizione/proprietà Drive          (+ export .xlsx settimanale in "Backup")
                                                              │
                                    Web app Apps Script (mobile-first, login Google)
                                    ricerca / filtri / anteprima / download / correzione metadati
                                                              │
                     Mac (ogni 15 min) ──▶ iCloud Drive/Archivio Documenti ──▶ app File su iPhone della famiglia
```

**Dove stanno i file**: l'originale è su Google Drive (lì lavora lo scanner e la classificazione). iCloud Drive è una copia specchio aggiornata dal Mac. Il sito non conserva nulla: legge l'indice e mostra i file di Drive.

**Perché così**: non c'è nessun server da pagare o mantenere. Google Drive e il foglio indice sono la copia che sopravvive a tutto: anche se il sito o la chiave API smettessero di funzionare, i file restano su Drive con nome parlante, e il foglio (più l'export Excel settimanale) contiene tutto l'archivio.

**Se la chiave Claude smette di funzionare** (credito finito, chiave revocata): i documenti restano intatti in `00_Inbox`, il foglio `Log` registra l'errore e arriva un'email di avviso (al massimo una al giorno). Appena il problema è risolto, il trigger riprende da solo. Lo script **non cancella mai** un documento.

## Installazione fatta (8 settembre 2026)

Account Google dell'archivio: **andrea.agnoli.1984@gmail.com**.

| Cosa | Link |
|---|---|
| Sito web (famiglia) | https://script.google.com/macros/s/AKfycbzFON9VwVZtyPAcsZqVuj-P-SWHuklhJ4YRj3yDmG3USSskVutTblGyswqxkZ1XXGzppg/exec |
| Foglio indice | https://docs.google.com/spreadsheets/d/1D-yGxNaE58fpZ9xANT29jXiqRpt0MIC2BbRMYdulW34/edit |
| Cartella Inbox (destinazione ScanSnap Cloud) | https://drive.google.com/drive/folders/1cSY8IMJlMCVOuF8r2Hw4kGoEDe-W1Xwl |
| Editor Apps Script | https://script.google.com/home/projects/12E9zjj4Uw8QeFdst_BsSscqSa8KQVAQlzTkyZt1RoNxvyixaKsjQt5xA/edit |

Stato: API Apps Script attiva, codice caricato, `setupProject` eseguito (cartelle, fogli, trigger), chiave API impostata, prima classificazione reale riuscita (bolletta di prova → `Utenze / Luce`, confidenza 0.95), sito pubblicato come app web (esegui come utente che accede, chiunque con account Google).

**Se il sito mostra la pagina Drive "Impossibile aprire il file in questo momento"**: è un difetto noto di Google quando nel browser sono collegati più account Google contemporaneamente. Aprilo in una finestra in incognito (o in un profilo Chrome con il solo account di famiglia) e accedi con l'account giusto; alla prima apertura premi *Rivedi autorizzazioni → Avanzate → Apri Archivio Documenti (non sicura) → Seleziona tutto → Continua*. Sul telefono, dove di solito c'è un solo account, il problema non si presenta.

## Struttura su Drive

```
Archivio Documenti/
  00_Inbox/          ← destinazione di ScanSnap Cloud (e degli upload dal sito)
  Archivio/          ← tutti i documenti rinominati, in un'unica cartella
  Backup/            ← Indice_YYYY-MM-DD.xlsx (ultimi 12)
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
3. Il setup crea le cartelle su Drive, i fogli con le intestazioni e due trigger (`processInbox` ogni 5 minuti, `exportIndexXlsx` ogni lunedì alle 3). Nel log di esecuzione trovi il link alla cartella `00_Inbox`.

Facoltativo: nel foglio **Config** puoi cambiare email per gli avvisi, soglia di confidenza, modello e nomi dei familiari; nel foglio **Categorie** puoi aggiungere o rinominare categorie e sottocategorie. Nessuna modifica al codice.

### 5. Pubblica il sito
Nell'editor Apps Script: **Distribuisci** → *Nuova distribuzione* → tipo **App web**:
- *Esegui come*: **Utente che accede all'app web**
- *Chi può accedere*: **Chiunque con un account Google**

Copia l'URL. Sul telefono aprilo in Chrome/Safari e usa *Aggiungi alla schermata Home*: diventa un'icona come un'app.

Quando in futuro modifichi il codice: `npx clasp push`, poi **Distribuisci → Gestisci distribuzioni → modifica → Nuova versione**.

### 6. Condividi con la famiglia
Su Drive, condividi la cartella **Archivio Documenti** (tutta) e il foglio **Archivio Documenti - Indice**:
- Serena: **Editor** (può correggere i metadati e caricare dal sito)
- bambini: **Visualizzatore** (cercano, vedono, scaricano)

Ognuno apre l'URL del sito con il proprio account Google e alla prima volta autorizza lo script (stesso avviso "app non verificata" → Avanzate → continua). Chi non ha la cartella condivisa non vede nulla, anche se conosce l'URL.

### 7. Configura lo scanner
Nell'app **ScanSnap Home** (Mac) o nell'app ScanSnap sul telefono:
1. Attiva **ScanSnap Cloud** e collega l'**account Google** di Andrea (quello che possiede la cartella).
2. Crea un profilo **"Archivio casa"** con destinazione **Google Drive → `Archivio Documenti/00_Inbox`**.
3. Impostazioni consigliate: PDF con **OCR (PDF ricercabile)**, colore automatico, **fronte/retro**, 300 dpi, rimozione pagine bianche.
4. Sul touchscreen dello scanner seleziona il profilo e premi Scan: lo scanner carica direttamente su Drive via Wi-Fi, senza computer acceso.

Importante: **un documento per scansione** (un job = un file). Se metti nell'ADF più documenti diversi in un colpo solo, verranno classificati come un unico documento. Se vuoi scansionare in blocco, attiva in ScanSnap Home la separazione con pagina bianca o con codice di separazione.

### 8. Copia su iCloud Drive per l'app File (famiglia Apple)
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

## Uso quotidiano
1. Arriva una lettera → la metti nello scanner → Scan.
2. Entro 5 minuti il file è in `Archivio`, rinominato, con la riga nel foglio e visibile nel sito; entro altri 15 minuti (Mac acceso) compare anche nell'app File.
3. Se la classificazione è incerta (confidenza bassa o data mancante) il documento è segnato **Da verificare**: nel sito appare il banner giallo, apri la scheda, premi *Modifica*, correggi e salva. Il file viene rinominato e lo stato diventa *Verificato*.
4. Dal telefono puoi anche fotografare un documento e caricarlo dal sito (bottone *Carica*): entra nella stessa coda dello scanner.

## Manutenzione e problemi
- **Foglio `Log`**: ogni classificazione, avviso ed errore, con data e nome file.
- **Email "Classificazione ferma"**: controlla chiave e credito su console.anthropic.com; i file aspettano in `00_Inbox`.
- **File rimasto in Inbox** senza email: probabilmente il trigger non gira. In Apps Script → *Trigger* controlla che esistano; altrimenti esegui `installTriggers()`.
- **Documento in Archivio senza riga nel foglio**: esegui `reindexMissing()` in Apps Script.
- **Test manuale della classificazione** senza spostare nulla: metti un PDF in Inbox ed esegui `testClassifyFirstInboxFile()`, il risultato JSON è nel log di esecuzione.
- **Cambiare modello o costi**: nel foglio `Config` la riga `MODEL` (es. `claude-haiku-4-5` costa circa 5 volte meno, con classificazioni un po' meno precise).
- **Backup**: ogni lunedì un file Excel dell'indice in `Backup/`. Puoi anche generarlo subito eseguendo `exportIndexXlsx()`.

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
| `Setup.gs` | `setupProject()` e `installTriggers()` |
| `WebApp.gs` | `doGet()`, dati per il sito, correzione metadati, upload in Inbox |
| `index.html`, `style.html`, `app.html` | Il sito (HTML, CSS, JavaScript), senza dipendenze esterne |
| `../sync/sync-icloud.sh`, `install.sh` | Copia Google Drive → iCloud Drive dal Mac, con avvio automatico launchd |
| `../test/run.js` | 32 scenari della pipeline in un Apps Script simulato: `npm test` |

Il codice è versionato in questo repository; su Google viene pubblicato con `npx clasp push`. La chiave API vive solo nelle Script Properties, mai nel repository.
