/**
 * DriveUtils.gs - nomi file, slug ASCII, metadati Drive, OCR via Drive.
 */

var FILENAME_MAX = 180;

/**
 * Converte un testo in uno slug ASCII sicuro per i nomi file:
 * "Dott. Rossi & C." -> "Dott-Rossi-C". Vuoto -> "NA".
 */
function slugify(text, maxLen) {
  var s = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // accenti
    .replace(/[^A-Za-z0-9]+/g, '-')       // tutto il resto -> trattino
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (maxLen && s.length > maxLen) {
    s = s.substring(0, maxLen).replace(/-$/, '');
  }
  return s || 'NA';
}

/** Restituisce YYYY-MM-DD da una data (Date o stringa ISO); fallback su una data alternativa. */
function isoDate_(value, fallback) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Europe/Rome', 'yyyy-MM-dd');
  }
  var s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return fallback ? isoDate_(fallback) : '';
}

/**
 * Pattern: YYYY-MM-DD_Categoria_Sottocategoria_Mittente_Destinatario_Titolo.ext
 * @param {Object} meta metadati (chiavi come INDEX_COLUMNS)
 * @param {string} ext estensione senza punto
 */
function buildFileName(meta, ext) {
  var parts = [
    meta.dataDocumento || 'NA',
    slugify(meta.categoria, 25),
    slugify(meta.sottocategoria, 30),
    slugify(meta.mittente, 30),
    slugify(meta.destinatario, 30),
    slugify(meta.titolo, 45)
  ];
  var name = parts.join('_');
  var suffix = '.' + (ext || 'pdf').toLowerCase();
  if (name.length + suffix.length > FILENAME_MAX) {
    name = name.substring(0, FILENAME_MAX - suffix.length).replace(/[-_]$/, '');
  }
  return name + suffix;
}

/** Se in cartella esiste già un file con quel nome, aggiunge _2, _3, ... */
function uniqueNameInFolder(folder, name, ignoreFileId) {
  var base = name.replace(/\.[^.]+$/, '');
  var ext = name.substring(base.length);
  var candidate = name;
  var n = 2;
  while (nameExists_(folder, candidate, ignoreFileId)) {
    candidate = base + '_' + n + ext;
    n++;
  }
  return candidate;
}

function nameExists_(folder, name, ignoreFileId) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) {
    if (it.next().getId() !== ignoreFileId) return true;
  }
  return false;
}

function fileExtension_(file) {
  var name = file.getName();
  var m = name.match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return m[1].toLowerCase();
  var mime = file.getMimeType();
  if (mime === MimeType.PDF) return 'pdf';
  if (mime === MimeType.JPEG) return 'jpg';
  if (mime === MimeType.PNG) return 'png';
  return 'bin';
}

/** Testo descrittivo salvato nel campo "Descrizione" di Drive (così la ricerca di Drive lo trova). */
function formatDescription(meta) {
  var lines = [
    'Categoria: ' + [meta.categoria, meta.sottocategoria, meta.sottoSottocategoria].filter(Boolean).join(' > '),
    'Tipo: ' + (meta.tipoDocumento || ''),
    'Mittente: ' + (meta.mittente || ''),
    'Destinatario: ' + (meta.destinatario || ''),
    'Soggetti: ' + (meta.soggetti || ''),
    'Data documento: ' + (meta.dataDocumento || ''),
    'Data scansione: ' + (meta.dataScansione || ''),
    meta.importo ? 'Importo: ' + meta.importo : '',
    meta.scadenza ? 'Scadenza: ' + meta.scadenza : '',
    '',
    meta.riassunto || ''
  ];
  return lines.filter(function (l, i) { return l !== '' || i === 9; }).join('\n');
}

/** Scrive descrizione e appProperties sul file Drive (servizio avanzato Drive v3). */
function setFileMetadata(fileId, meta) {
  var props = {
    categoria: meta.categoria || '',
    sottocategoria: meta.sottocategoria || '',
    tipoDocumento: meta.tipoDocumento || '',
    mittente: meta.mittente || '',
    destinatario: meta.destinatario || '',
    soggetti: meta.soggetti || '',
    dataDocumento: meta.dataDocumento || '',
    stato: meta.stato || ''
  };
  // Le appProperties hanno un limite di 124 byte per chiave+valore: accorciamo i valori lunghi.
  Object.keys(props).forEach(function (k) { props[k] = String(props[k]).substring(0, 100); });
  Drive.Files.update({ description: formatDescription(meta), appProperties: props }, fileId, null, { supportsAllDrives: true });
}

/**
 * Estrae il testo di un PDF/immagine usando l'OCR gratuito di Drive:
 * copia il file come Google Doc, legge il testo, elimina la copia temporanea.
 */
function ocrTextViaDrive(file) {
  var tmp = Drive.Files.copy(
    { name: 'tmp-ocr-' + file.getId(), mimeType: 'application/vnd.google-apps.document' },
    file.getId(),
    { ocrLanguage: 'it', supportsAllDrives: true }
  );
  try {
    var text = DocumentApp.openById(tmp.id).getBody().getText();
    return text;
  } finally {
    try { Drive.Files.remove(tmp.id, { supportsAllDrives: true }); } catch (e) { /* al massimo resta un doc temporaneo */ }
  }
}

function driveViewUrl_(fileId) {
  return 'https://drive.google.com/file/d/' + fileId + '/view';
}

function isHeic_(mime) { return /^image\/hei[cf]$/i.test(String(mime || '')); }

/**
 * Converte un HEIC (foto iPhone) in JPEG usando l'anteprima generata da Drive, perché Claude non legge HEIC.
 * Crea <nome>.jpg nella stessa cartella e mette l'originale nel cestino. Lancia un errore se l'anteprima non è pronta.
 */
function convertHeicToJpeg_(file, folder) {
  var meta = Drive.Files.get(file.getId(), { fields: 'thumbnailLink', supportsAllDrives: true });
  if (!meta.thumbnailLink) throw new Error('Anteprima Drive non ancora disponibile per convertire ' + file.getName());
  var url = meta.thumbnailLink.replace(/=s\d+(-c)?$/, '') + '=s2500';
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Conversione HEIC fallita: HTTP ' + resp.getResponseCode());
  var jpg = folder.createFile(resp.getBlob().setName(file.getName().replace(/\.hei[cf]$/i, '') + '.jpg').setContentType('image/jpeg'));
  file.setTrashed(true);
  logEvent('INFO', jpg.getName(), 'Foto HEIC convertita in JPEG');
  return jpg;
}
