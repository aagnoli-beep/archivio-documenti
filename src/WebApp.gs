/**
 * WebApp.gs - sito per la famiglia (HTML Service).
 *
 * Distribuito come "Esegui come: utente che accede" + "Chiunque con un account Google":
 * ogni familiare vede solo ciò che gli è condiviso su Drive, e chi ha diritti di modifica
 * sul foglio può correggere i metadati.
 */

function doGet() {
  var t = HtmlService.createTemplateFromFile('index');
  return t.evaluate()
    .setTitle('Archivio Documenti')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** L'utente corrente può modificare il foglio indice? (quindi anche i file, se la cartella è condivisa in modifica) */
function canEdit_() {
  try {
    var f = Drive.Files.get(getProp_(PROP.SPREADSHEET_ID, true), { fields: 'capabilities(canEdit)', supportsAllDrives: true });
    return !!(f.capabilities && f.capabilities.canEdit);
  } catch (e) {
    return false;
  }
}

/** Dati iniziali per la web app. */
function getIndex() {
  var cfg = getConfig();
  return {
    docs: getAllIndexRows(),
    categories: cfg.categories,
    family: cfg.family,
    canEdit: canEdit_(),
    user: Session.getActiveUser().getEmail() || '',
    sheetUrl: getSpreadsheet_().getUrl(),
    archiveUrl: 'https://drive.google.com/drive/folders/' + getProp_(PROP.ARCHIVE_FOLDER_ID, true),
    generatedAt: new Date().toISOString()
  };
}

var EDITABLE_FIELDS = ['categoria', 'sottocategoria', 'sottoSottocategoria', 'tipoDocumento', 'mittente',
  'destinatario', 'soggetti', 'dataDocumento', 'titolo', 'riassunto', 'importo', 'scadenza'];

/**
 * Salva le correzioni fatte dalla web app: aggiorna la riga, rinomina il file, aggiorna la descrizione Drive.
 * @return {Object} i metadati aggiornati
 */
function updateDocument(fileId, fields) {
  if (!canEdit_()) throw new Error('Non hai i permessi per modificare l\'archivio.');
  var meta = getIndexRow(fileId);
  if (!meta) throw new Error('Documento non trovato nell\'Indice.');

  EDITABLE_FIELDS.forEach(function (k) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, k)) meta[k] = String(fields[k] || '').trim();
  });
  var cfg = getConfig();
  if (cfg.categoryNames.indexOf(meta.categoria) < 0) meta.categoria = 'Altro';
  meta.dataDocumento = isoDate_(meta.dataDocumento, null) || meta.dataDocumento;
  meta.scadenza = isoDate_(meta.scadenza, null);
  meta.stato = STATO.VERIFICATO;

  var file = DriveApp.getFileById(fileId);
  var archive = DriveApp.getFolderById(getProp_(PROP.ARCHIVE_FOLDER_ID, true));
  var newName = buildFileName(meta, fileExtension_(file));
  if (newName !== file.getName()) {
    newName = uniqueNameInFolder(archive, newName, fileId);
    file.setName(newName);
  }
  meta.nomeFile = newName;
  meta.link = driveViewUrl_(fileId);
  try { setFileMetadata(fileId, meta); } catch (e) { logEvent('WARN', newName, 'Descrizione Drive non aggiornata: ' + e.message); }
  updateIndexRow(fileId, meta);
  logEvent('INFO', newName, 'Metadati corretti da ' + (Session.getActiveUser().getEmail() || 'utente'));
  return meta;
}

/** Carica un file (PDF o foto) nella Inbox: entrerà nella stessa pipeline dello scanner. */
function uploadToInbox(base64Data, fileName, mimeType) {
  if (!base64Data) throw new Error('Nessun file ricevuto.');
  var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType || 'application/pdf', fileName || 'documento.pdf');
  var file = inbox.createFile(blob);
  logEvent('INFO', file.getName(), 'Caricato dalla web app da ' + (Session.getActiveUser().getEmail() || 'utente'));
  return { id: file.getId(), name: file.getName() };
}

/** Metadati aggiornati di un singolo documento. */
function getDocument(fileId) {
  return getIndexRow(fileId);
}
