/**
 * Api.gs - backend JSON per il sito (GitHub Pages).
 *
 * Deployment: "Esegui come: me" + "Chiunque" (anche anonimi). L'accesso è protetto dal token
 * di "Accedi con Google" che il sito invia in ogni richiesta: viene verificato qui contro il
 * Client ID e la lista ALLOWED_EMAILS del foglio Config. Chi non è in lista non vede nulla.
 *
 * Il sito manda sempre POST con body JSON (Content-Type text/plain, per evitare il preflight CORS):
 *   { action: 'index' | 'doc' | 'file' | 'update' | 'upload' | 'ask' | 'me', token: <id_token>, ... }
 */

var TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo?id_token=';
var FILE_MAX_BYTES = 25 * 1024 * 1024;

function doGet(e) { return handleRequest_(e, 'GET'); }
function doPost(e) { return handleRequest_(e, 'POST'); }

function handleRequest_(e, method) {
  var params = (e && e.parameter) || {};
  var body = {};
  if (method === 'POST' && e && e.postData && e.postData.contents) {
    try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  }
  var action = body.action || params.action;
  var cfg = getConfig();

  if (!action) {
    // Visita diretta dal browser: rimanda al sito.
    var html = cfg.siteUrl
      ? '<meta http-equiv="refresh" content="0;url=' + cfg.siteUrl + '"><p>Vai a <a href="' + cfg.siteUrl + '">' + cfg.siteUrl + '</a></p>'
      : '<p>Archivio Documenti: backend attivo. Imposta SITE_URL nel foglio Config.</p>';
    return HtmlService.createHtmlOutput(html).setTitle('Archivio Documenti');
  }

  try {
    var user = verifyUser_(body.token || params.token, cfg);
    var data = dispatch_(action, user, body, cfg);
    return json_({ ok: true, user: user, data: data });
  } catch (err) {
    return json_({ ok: false, error: err.message || String(err), code: err.code || 'error' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ApiError(code, message) { this.name = 'ApiError'; this.code = code; this.message = message; }
ApiError.prototype = Object.create(Error.prototype);

/** Verifica il token Google e restituisce l'utente { email, name, picture, canEdit }. */
function verifyUser_(token, cfg) {
  if (!token) throw new ApiError('login_required', 'Accesso richiesto');
  var cache = CacheService.getScriptCache();
  var key = 'tok_' + Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
  var cached = cache.get(key);
  if (cached) return JSON.parse(cached);

  var resp = UrlFetchApp.fetch(TOKENINFO_URL + encodeURIComponent(token), { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new ApiError('login_required', 'Sessione scaduta, accedi di nuovo');
  var info = JSON.parse(resp.getContentText());
  if (!cfg.googleClientId || info.aud !== cfg.googleClientId) throw new ApiError('forbidden', 'Token non valido per questo sito');
  if (String(info.email_verified) !== 'true') throw new ApiError('forbidden', 'Email non verificata');
  var exp = parseInt(info.exp, 10) * 1000;
  if (!exp || exp < Date.now()) throw new ApiError('login_required', 'Sessione scaduta, accedi di nuovo');

  var email = String(info.email || '').toLowerCase();
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var allowed = cfg.allowedEmails.slice();
  if (owner) allowed.push(owner);
  if (allowed.indexOf(email) < 0) throw new ApiError('forbidden', 'L\'account ' + email + ' non è tra quelli della famiglia');

  var canEdit = cfg.editorEmails.length ? (cfg.editorEmails.indexOf(email) >= 0 || email === owner) : true;
  var user = { email: email, name: info.name || email, picture: info.picture || '', canEdit: canEdit };
  var ttl = Math.max(60, Math.min(1800, Math.floor((exp - Date.now()) / 1000)));
  cache.put(key, JSON.stringify(user), ttl);
  return user;
}

function dispatch_(action, user, body, cfg) {
  switch (action) {
    case 'me':
      return { ok: true };
    case 'index':
      return { docs: getAllIndexRows(), categories: cfg.categories, family: cfg.family,
        archiveUrl: 'https://drive.google.com/drive/folders/' + getProp_(PROP.ARCHIVE_FOLDER_ID, true),
        sheetUrl: getSpreadsheet_().getUrl() };
    case 'doc':
      return getIndexRow(String(body.id || ''));
    case 'file':
      return getFilePayload_(String(body.id || ''));
    case 'update':
      if (!user.canEdit) throw new ApiError('forbidden', 'Non hai i permessi per modificare');
      return updateDocument(String(body.id || ''), body.fields || {}, user.email);
    case 'upload':
      if (!user.canEdit) throw new ApiError('forbidden', 'Non hai i permessi per caricare');
      return uploadToInbox(body.data, body.name, body.mime, user.email);
    case 'ask':
      return askArchive(String(body.question || ''), body.history || [], cfg);
    default:
      throw new ApiError('bad_request', 'Azione sconosciuta: ' + action);
  }
}

/** Contenuto di un documento dell'archivio (solo file presenti nell'Indice). */
function getFilePayload_(fileId) {
  var meta = getIndexRow(fileId);
  if (!meta) throw new ApiError('not_found', 'Documento non trovato');
  var file = DriveApp.getFileById(fileId);
  if (file.getSize() > FILE_MAX_BYTES) throw new ApiError('too_large', 'File troppo grande per l\'anteprima: aprilo da Drive');
  var blob = file.getBlob();
  return { name: file.getName(), mime: blob.getContentType() || 'application/pdf', size: file.getSize(), base64: Utilities.base64Encode(blob.getBytes()) };
}

var EDITABLE_FIELDS = ['categoria', 'sottocategoria', 'sottoSottocategoria', 'tipoDocumento', 'mittente',
  'destinatario', 'soggetti', 'dataDocumento', 'titolo', 'riassunto', 'importo', 'scadenza', 'paroleChiave'];

/** Salva le correzioni: aggiorna la riga, rinomina il file, aggiorna la descrizione Drive. */
function updateDocument(fileId, fields, who) {
  var meta = getIndexRow(fileId);
  if (!meta) throw new ApiError('not_found', 'Documento non trovato nell\'Indice.');
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
  logEvent('INFO', newName, 'Metadati corretti da ' + (who || 'utente'));
  return meta;
}

/** Carica un file (PDF o foto) nella Inbox: entrerà nella stessa pipeline dello scanner. */
function uploadToInbox(base64Data, fileName, mimeType, who) {
  if (!base64Data) throw new ApiError('bad_request', 'Nessun file ricevuto.');
  var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
  var blob = Utilities.newBlob(Utilities.base64Decode(base64Data), mimeType || 'application/pdf', fileName || 'documento.pdf');
  var file = inbox.createFile(blob);
  logEvent('INFO', file.getName(), 'Caricato dal sito da ' + (who || 'utente'));
  return { id: file.getId(), name: file.getName() };
}
