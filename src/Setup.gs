/**
 * Setup.gs - da eseguire UNA volta dall'editor Apps Script: crea cartelle, fogli e trigger.
 * Si può rieseguire senza danni: non ricrea ciò che esiste già.
 */

function setupProject() {
  var props = getProps_();

  // 1. Cartelle su Drive
  var root = getOrCreateFolder_(DriveApp.getRootFolder(), FOLDER_NAMES.ROOT, props.getProperty(PROP.ROOT_FOLDER_ID));
  var inbox = getOrCreateFolder_(root, FOLDER_NAMES.INBOX, props.getProperty(PROP.INBOX_FOLDER_ID));
  var archive = getOrCreateFolder_(root, FOLDER_NAMES.ARCHIVE, props.getProperty(PROP.ARCHIVE_FOLDER_ID));
  var backup = getOrCreateFolder_(root, FOLDER_NAMES.BACKUP, props.getProperty(PROP.BACKUP_FOLDER_ID));
  props.setProperties({
    ROOT_FOLDER_ID: root.getId(),
    INBOX_FOLDER_ID: inbox.getId(),
    ARCHIVE_FOLDER_ID: archive.getId(),
    BACKUP_FOLDER_ID: backup.getId()
  });

  // 2. Foglio indice (quello a cui lo script è collegato, oppure uno nuovo)
  var ss = null;
  var ssId = props.getProperty(PROP.SPREADSHEET_ID);
  if (ssId) { try { ss = SpreadsheetApp.openById(ssId); } catch (e) { ss = null; } }
  if (!ss) ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    // Progetto indipendente: riusa il foglio già presente nella cartella, se c'è.
    var existing = root.getFilesByName(FOLDER_NAMES.ROOT + ' - Indice');
    while (existing.hasNext()) { var f = existing.next(); if (f.getMimeType() === MimeType.GOOGLE_SHEETS && !f.isTrashed()) { ss = SpreadsheetApp.openById(f.getId()); break; } }
  }
  if (!ss) ss = SpreadsheetApp.create(FOLDER_NAMES.ROOT + ' - Indice');
  props.setProperty(PROP.SPREADSHEET_ID, ss.getId());
  var ssFile = DriveApp.getFileById(ss.getId());
  if (!isInFolder_(ssFile, root)) ssFile.moveTo(root);

  // 3. Fogli con intestazioni
  var index = getOrCreateSheet_(ss, SHEET.INDEX);
  ensureHeaders_(index, indexHeaders_());
  index.setFrozenRows(1);
  if (!index.getFilter() && index.getLastRow() >= 1) {
    index.getRange(1, 1, Math.max(index.getLastRow(), 2), INDEX_COLUMNS.length).createFilter();
  }

  var config = getOrCreateSheet_(ss, SHEET.CONFIG);
  ensureHeaders_(config, ['Chiave', 'Valore', 'Descrizione']);
  if (config.getLastRow() < 2) {
    config.getRange(2, 1, DEFAULT_CONFIG.length, 3).setValues(DEFAULT_CONFIG);
  }
  config.setFrozenRows(1);
  ensureConfigDefaults_();

  var cats = getOrCreateSheet_(ss, SHEET.CATEGORIES);
  ensureHeaders_(cats, ['Categoria', 'Sottocategorie (separate da virgola)']);
  if (cats.getLastRow() < 2) {
    cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 2).setValues(DEFAULT_CATEGORIES);
  }
  cats.setFrozenRows(1);

  var log = getOrCreateSheet_(ss, SHEET.LOG);
  ensureHeaders_(log, ['Quando', 'Livello', 'File', 'Messaggio']);
  log.setFrozenRows(1);

  var defaultSheet = ss.getSheetByName('Foglio1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  [index, config, cats, log].forEach(function (sh) { sh.autoResizeColumns(1, sh.getLastColumn()); });

  // 4. Trigger
  installTriggers();

  var apiKey = props.getProperty(PROP.ANTHROPIC_API_KEY);
  logEvent('INFO', '', 'setupProject eseguito. Inbox: ' + inbox.getId() + (apiKey ? '' : ' - ATTENZIONE: ANTHROPIC_API_KEY non impostata'));
  console.log('Setup completato.\nCartella Inbox (destinazione ScanSnap Cloud): ' + inbox.getUrl() +
    '\nFoglio indice: ' + ss.getUrl() +
    (apiKey ? '' : '\n\nRICORDA: imposta la Script Property ANTHROPIC_API_KEY (Impostazioni progetto > Proprietà dello script).'));
}

/** (Re)installa i trigger: processInbox ogni 5 minuti, export Excel ogni notte alle 3. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['processInbox', 'exportIndexXlsx', 'sendDailyDigest'].indexOf(t.getHandlerFunction()) >= 0) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('sendDailyDigest').timeBased().everyDays(1).atHour(getConfig().digestHour).create();
  ScriptApp.newTrigger('exportIndexXlsx').timeBased().everyDays(1).atHour(3).create();
}

function getOrCreateFolder_(parent, name, knownId) {
  if (knownId) {
    try {
      var f = DriveApp.getFolderById(knownId);
      if (!f.isTrashed()) return f;
    } catch (e) { /* cartella sparita: la ricreiamo */ }
  }
  var it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    var existing = it.next();
    if (!existing.isTrashed()) return existing;
  }
  return parent.createFolder(name);
}

function isInFolder_(file, folder) {
  var parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folder.getId()) return true;
  }
  return false;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function ensureHeaders_(sheet, headers) {
  var current = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
  var same = headers.every(function (h, i) { return current[i] === h; });
  if (!same) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
}

/** Rimuove tutti i trigger di questo progetto (usato quando il backend viene spostato su un altro progetto). */
function removeAllTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  console.log('Rimossi ' + n + ' trigger');
}
