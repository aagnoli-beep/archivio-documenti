/**
 * Pipeline.gs - processInbox(): trigger ogni 5 minuti.
 *
 * Per ogni file nella cartella 00_Inbox:
 *   1. classifica con Claude (Classifier.gs)
 *   2. costruisce il nuovo nome, rinomina e sposta il file in Archivio
 *   3. scrive descrizione/proprietà sul file Drive
 *   4. aggiunge la riga nel foglio Indice
 * Se qualcosa va storto il file resta in Inbox (mai cancellato) e l'errore finisce nel foglio Log.
 */

var MAX_RUN_MS = 4.5 * 60 * 1000;   // il limite Apps Script è 6 minuti: lasciamo margine
var MAX_ATTEMPTS = 5;                // dopo N tentativi falliti il file viene archiviato come "Non classificato"

function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.log('processInbox: esecuzione già in corso, salto.'); return; }
  try {
    var cfg = getConfig();
    var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
    var archive = DriveApp.getFolderById(getProp_(PROP.ARCHIVE_FOLDER_ID, true));
    var start = Date.now();
    var files = inbox.getFiles();
    var done = 0;

    while (files.hasNext()) {
      if (Date.now() - start > MAX_RUN_MS) { logEvent('INFO', '', 'Tempo esaurito, continuo al prossimo giro'); break; }
      var file = files.next();
      if (file.isTrashed()) continue;
      if (file.getSize() === 0 || Date.now() - file.getLastUpdated().getTime() < cfg.minFileAgeMs) continue; // upload in corso

      try {
        processFile_(file, cfg, archive);
        done++;
      } catch (e) {
        if (e.name === 'ClassifierError' && (e.code === 'auth' || e.code === 'credit')) {
          logEvent('ERROR', file.getName(), 'Classificazione ferma (' + e.code + '): ' + e.message);
          alertApiProblem(e);
          break;   // inutile provare gli altri file
        }
        var attempts = bumpAttempts_(file.getId());
        var retryable = (e.name === 'ClassifierError') ? e.retryable : true;
        if (retryable && attempts < MAX_ATTEMPTS) {
          logEvent('WARN', file.getName(), 'Tentativo ' + attempts + ' fallito, riprovo al prossimo giro: ' + e.message);
          continue;
        }
        logEvent('ERROR', file.getName(), 'Archiviato senza classificazione dopo ' + attempts + ' tentativi: ' + e.message);
        archiveUnclassified_(file, archive, e.message);
        sendAlertOnce('unclassified', 'Un documento non è stato classificato',
          'Il file "' + file.getName() + '" è stato spostato in Archivio senza metadati (stato "Non classificato").\n' +
          'Motivo: ' + e.message + '\n\nPuoi correggerlo a mano dalla web app.');
      }
    }
    if (done) console.log('processInbox: ' + done + ' documenti classificati');
  } finally {
    lock.releaseLock();
  }
}

function processFile_(file, cfg, archive) {
  var raw = classifyDocument(file, cfg);
  var meta = normalizeMeta_(raw, file, cfg);
  var ext = fileExtension_(file);
  var newName = uniqueNameInFolder(archive, buildFileName(meta, ext), file.getId());

  meta.id = file.getId();
  meta.nomeFile = newName;
  meta.link = driveViewUrl_(file.getId());

  file.setName(newName);
  file.moveTo(archive);
  try { setFileMetadata(file.getId(), meta); } catch (e) { logEvent('WARN', newName, 'Descrizione Drive non scritta: ' + e.message); }
  appendIndexRow(meta);
  clearAttempts_(file.getId());

  var u = raw._usage || {};
  logEvent('INFO', newName, 'Classificato: ' + meta.categoria + ' / ' + meta.sottocategoria +
    ' | conf ' + meta.confidenza + ' | token in/out ' + (u.input_tokens || '?') + '/' + (u.output_tokens || '?') +
    ' | ' + raw._model);
}

/** Converte l'output JSON di Claude nelle colonne dell'Indice, con validazioni. */
function normalizeMeta_(raw, file, cfg) {
  var scanDate = file.getDateCreated();
  var conf = Math.max(0, Math.min(1, parseFloat(raw.confidenza) || 0));
  var categoria = String(raw.categoria || '').trim();
  if (cfg.categoryNames.indexOf(categoria) < 0) {
    categoria = 'Altro';
    conf = Math.min(conf, 0.5);
  }
  var dataDoc = isoDate_(raw.data_documento, null);
  var meta = {
    dataDocumento: dataDoc || isoDate_(scanDate),
    dataScansione: Utilities.formatDate(scanDate, 'Europe/Rome', 'yyyy-MM-dd HH:mm'),
    categoria: categoria,
    sottocategoria: String(raw.sottocategoria || '').trim(),
    sottoSottocategoria: String(raw.sotto_sottocategoria || '').trim(),
    tipoDocumento: String(raw.tipo_documento || '').trim(),
    mittente: String(raw.mittente || '').trim(),
    destinatario: String(raw.destinatario || '').trim(),
    soggetti: Array.isArray(raw.soggetti) ? raw.soggetti.map(function (s) { return String(s).trim(); }).filter(Boolean).join(', ') : String(raw.soggetti || ''),
    titolo: String(raw.titolo_breve || '').trim() || 'Documento',
    riassunto: String(raw.riassunto || '').trim(),
    importo: String(raw.importo || '').trim(),
    scadenza: isoDate_(raw.scadenza, null),
    pagine: parseInt(raw.numero_pagine, 10) || '',
    confidenza: Math.round(conf * 100) / 100,
    stato: conf < cfg.confidenceThreshold ? STATO.DA_VERIFICARE : STATO.AUTO,
    nomeOriginale: file.getName(),
    paroleChiave: Array.isArray(raw.parole_chiave) ? raw.parole_chiave.map(function (s) { return String(s).trim(); }).filter(Boolean).join(', ') : ''
  };
  // Data mancante sul documento: si usa la data di scansione senza segnalare nulla (scelta di Andrea).
  return meta;
}

/** Sposta in Archivio un file che non si è riuscito a classificare, con una riga minima nell'Indice. */
function archiveUnclassified_(file, archive, reason) {
  var scanDate = file.getDateCreated();
  var ext = fileExtension_(file);
  var base = isoDate_(scanDate) + '_NonClassificato_' + slugify(file.getName().replace(/\.[^.]+$/, ''), 60) + '.' + ext;
  var newName = uniqueNameInFolder(archive, base, file.getId());
  var meta = {
    id: file.getId(),
    nomeFile: newName,
    link: driveViewUrl_(file.getId()),
    dataDocumento: isoDate_(scanDate),
    dataScansione: Utilities.formatDate(scanDate, 'Europe/Rome', 'yyyy-MM-dd HH:mm'),
    categoria: 'Altro',
    titolo: file.getName(),
    riassunto: 'Classificazione automatica fallita: ' + String(reason || '').substring(0, 300),
    confidenza: 0,
    stato: STATO.NON_CLASSIFICATO,
    nomeOriginale: file.getName()
  };
  file.setName(newName);
  file.moveTo(archive);
  appendIndexRow(meta);
  clearAttempts_(file.getId());
}

function bumpAttempts_(fileId) {
  var props = getProps_();
  var key = 'ATTEMPTS_' + fileId;
  var n = (parseInt(props.getProperty(key), 10) || 0) + 1;
  props.setProperty(key, String(n));
  return n;
}

function clearAttempts_(fileId) {
  getProps_().deleteProperty('ATTEMPTS_' + fileId);
}

/**
 * Manutenzione: aggiunge all'Indice i file presenti in Archivio ma senza riga
 * (es. se una scrittura sul foglio è fallita). Da eseguire a mano quando serve.
 */
function reindexMissing() {
  var archive = DriveApp.getFolderById(getProp_(PROP.ARCHIVE_FOLDER_ID, true));
  var known = {};
  getAllIndexRows().forEach(function (r) { known[r.id] = true; });
  var it = archive.getFiles();
  var added = 0;
  while (it.hasNext()) {
    var f = it.next();
    if (known[f.getId()]) continue;
    var p = {};
    try { p = Drive.Files.get(f.getId(), { fields: 'appProperties', supportsAllDrives: true }).appProperties || {}; } catch (e) { }
    appendIndexRow({
      id: f.getId(),
      nomeFile: f.getName(),
      link: driveViewUrl_(f.getId()),
      dataDocumento: p.dataDocumento || isoDate_(f.getDateCreated()),
      dataScansione: Utilities.formatDate(f.getDateCreated(), 'Europe/Rome', 'yyyy-MM-dd HH:mm'),
      categoria: p.categoria || 'Altro',
      sottocategoria: p.sottocategoria || '',
      tipoDocumento: p.tipoDocumento || '',
      mittente: p.mittente || '',
      destinatario: p.destinatario || '',
      soggetti: p.soggetti || '',
      titolo: f.getName().replace(/\.[^.]+$/, ''),
      riassunto: f.getDescription() || '',
      confidenza: 0,
      stato: p.categoria ? STATO.DA_VERIFICARE : STATO.NON_CLASSIFICATO,
      nomeOriginale: f.getName()
    });
    added++;
  }
  logEvent('INFO', '', 'reindexMissing: aggiunte ' + added + ' righe');
  console.log('Aggiunte ' + added + ' righe');
}

/**
 * Manutenzione: riporta a "Auto" tutti i documenti segnati "Da verificare".
 * Da eseguire a mano dall'editor quando si vuole azzerare le segnalazioni.
 */
function unflagAll() {
  var sh = getSheet_(SHEET.INDEX);
  var last = sh.getLastRow();
  if (last < 2) { console.log('Indice vuoto'); return; }
  var col = INDEX_COLUMNS.map(function (c) { return c.key; }).indexOf('stato') + 1;
  var range = sh.getRange(2, col, last - 1, 1);
  var values = range.getValues();
  var n = 0;
  values.forEach(function (r) { if (r[0] === STATO.DA_VERIFICARE) { r[0] = STATO.AUTO; n++; } });
  range.setValues(values);
  logEvent('INFO', '', 'unflagAll: ' + n + ' documenti riportati ad Auto');
  console.log(n + ' documenti riportati ad Auto');
}
