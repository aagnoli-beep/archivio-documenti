/**
 * Index.gs - foglio Indice (una riga per documento), foglio Log, export .xlsx settimanale.
 */

function indexHeaders_() {
  return INDEX_COLUMNS.map(function (c) { return c.header; });
}

function metaToRow_(meta) {
  return INDEX_COLUMNS.map(function (c) {
    var v = meta[c.key];
    return (v === undefined || v === null) ? '' : v;
  });
}

function rowToMeta_(row) {
  var meta = {};
  INDEX_COLUMNS.forEach(function (c, i) {
    var v = row[i];
    if (v instanceof Date) v = Utilities.formatDate(v, 'Europe/Rome', 'yyyy-MM-dd');
    meta[c.key] = (v === undefined || v === null) ? '' : v;
  });
  return meta;
}

/** Aggiunge una riga all'Indice. */
function appendIndexRow(meta) {
  var sh = getSheet_(SHEET.INDEX);
  sh.appendRow(metaToRow_(meta));
}

/** Restituisce il numero di riga (1-based) del documento con quell'ID Drive, o -1. */
function findIndexRowById_(fileId) {
  var sh = getSheet_(SHEET.INDEX);
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(fileId)) return i + 2;
  }
  return -1;
}

/** Legge i metadati di un documento dall'Indice (null se assente). */
function getIndexRow(fileId) {
  var r = findIndexRowById_(fileId);
  if (r < 0) return null;
  var sh = getSheet_(SHEET.INDEX);
  return rowToMeta_(sh.getRange(r, 1, 1, INDEX_COLUMNS.length).getValues()[0]);
}

/** Sovrascrive la riga di un documento con i nuovi metadati. */
function updateIndexRow(fileId, meta) {
  var r = findIndexRowById_(fileId);
  if (r < 0) throw new Error('Documento non trovato nell\'Indice: ' + fileId);
  var sh = getSheet_(SHEET.INDEX);
  sh.getRange(r, 1, 1, INDEX_COLUMNS.length).setValues([metaToRow_(meta)]);
}

/** Tutte le righe dell'Indice come array di oggetti (usato dalla web app). */
function getAllIndexRows() {
  var sh = getSheet_(SHEET.INDEX);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, INDEX_COLUMNS.length).getValues();
  return values.filter(function (r) { return r[0]; }).map(rowToMeta_);
}

/** Scrive una riga nel foglio Log (tiene le ultime 2000). */
function logEvent(level, fileName, message) {
  try {
    var sh = getSheet_(SHEET.LOG);
    sh.appendRow([new Date(), level, fileName || '', String(message || '').substring(0, 2000)]);
    var extra = sh.getLastRow() - 2001;
    if (extra > 0) sh.deleteRows(2, extra);
  } catch (e) {
    console.error('logEvent fallito: ' + e);
  }
  if (level === 'ERROR') console.error(fileName + ': ' + message); else console.log(fileName + ': ' + message);
}

/**
 * Esporta il foglio Indice in formato Excel nella cartella Backup.
 * Trigger giornaliero (03:00). Tiene solo gli ultimi N export.
 */
function exportIndexXlsx() {
  var cfg = getConfig();
  var ss = getSpreadsheet_();
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Export xlsx fallito: HTTP ' + resp.getResponseCode());
  }
  var backup = DriveApp.getFolderById(getProp_(PROP.BACKUP_FOLDER_ID, true));
  var name = 'Indice_' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd') + '.xlsx';
  var existing = backup.getFilesByName(name);
  while (existing.hasNext()) existing.next().setTrashed(true);
  var file = backup.createFile(resp.getBlob().setName(name));

  // Tiene solo gli ultimi N backup (i più vecchi vanno nel cestino di Drive).
  var all = [];
  var it = backup.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (/^Indice_\d{4}-\d{2}-\d{2}\.xlsx$/.test(f.getName())) all.push(f);
  }
  all.sort(function (a, b) { return a.getName() < b.getName() ? 1 : -1; });
  all.slice(cfg.backupKeep).forEach(function (f) { f.setTrashed(true); });

  logEvent('INFO', name, 'Backup Excel creato (' + file.getId() + ')');
  return file.getUrl();
}
