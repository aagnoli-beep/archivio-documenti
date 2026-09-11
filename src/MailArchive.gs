/**
 * MailArchive.gs - recupero di documenti dalle email già ricevute.
 *
 * A differenza di MailIntake.gs (che guarda solo l'indirizzo di intake e gira da solo ogni 5 minuti),
 * queste due azioni servono per andare a ripescare documenti nella casella Gmail del proprietario:
 *   - scanMailbox(query, limit): elenca i messaggi che hanno allegati utili, senza scaricare nulla;
 *   - importMailAttachments(items): salva in 00_Inbox solo gli allegati indicati, che poi
 *     vengono classificati dalla pipeline normale.
 * Nessuna email viene cancellata o modificata, a parte l'etichetta Archivio/Importate.
 */

var MAIL_LABEL_IMPORTED = 'Archivio/Importate';
var MAIL_SCAN_MAX_THREADS = 150;

/**
 * Elenca i messaggi con allegati archiviabili.
 * @param {string} query ricerca in sintassi Gmail
 * @param {number} limit numero massimo di conversazioni da leggere
 * @return {{messages: Array<Object>, threads: number}}
 */
function scanMailbox(query, limit) {
  var q = String(query || '').trim();
  if (!q) throw new ApiError('bad_request', 'Ricerca vuota');
  var max = Math.min(parseInt(limit, 10) || 50, MAIL_SCAN_MAX_THREADS);
  var threads = GmailApp.search(q, 0, max);
  var messages = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var atts = [];
      msg.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (att) {
        var mime = String(att.getContentType() || '').toLowerCase();
        if (MAIL_DOC_MIMES.indexOf(mime) < 0) return;
        if (att.getSize() > MAIL_ATTACH_MAX_BYTES) return;
        atts.push({ name: att.getName(), size: att.getSize(), mime: mime });
      });
      if (!atts.length) return;
      messages.push({
        id: msg.getId(),
        data: Utilities.formatDate(msg.getDate(), 'Europe/Rome', 'yyyy-MM-dd'),
        da: msg.getFrom(),
        oggetto: msg.getSubject(),
        allegati: atts
      });
    });
  });
  return { messages: messages, threads: threads.length };
}

/**
 * Salva in Inbox gli allegati richiesti.
 * @param {Array<{id:string, names:Array<string>}>} items messaggi e (facoltativo) nomi degli allegati da prendere
 * @return {{saved:number, files:Array<string>, errors:Array<string>}}
 */
function importMailAttachments(items) {
  if (!items || !items.length) throw new ApiError('bad_request', 'Nessun messaggio indicato');
  var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
  var label = getOrCreateLabel_(MAIL_LABEL_IMPORTED);
  var files = [], errors = [], saved = 0;
  items.slice(0, 100).forEach(function (item) {
    try {
      var msg = GmailApp.getMessageById(String(item.id));
      if (!msg) { errors.push(item.id + ': messaggio non trovato'); return; }
      var wanted = (item.names || []).map(function (n) { return String(n); });
      var subject = msg.getSubject() || 'email';
      var prefix = mailFilePrefix_(msg, subject);
      msg.getAttachments({ includeInlineImages: false, includeAttachments: true }).forEach(function (att) {
        var mime = String(att.getContentType() || '').toLowerCase();
        if (MAIL_DOC_MIMES.indexOf(mime) < 0) return;
        if (att.getSize() > MAIL_ATTACH_MAX_BYTES) { errors.push(att.getName() + ': troppo grande'); return; }
        if (wanted.length && wanted.indexOf(att.getName()) < 0) return;
        var name = prefix + '_' + slugify(att.getName().replace(/\.[^.]+$/, ''), 40) + '.' + extensionForMime_(mime, att.getName());
        name = uniqueNameInFolder(inbox, name);
        inbox.createFile(att.copyBlob().setName(name));
        files.push(name);
        saved++;
      });
      msg.getThread().addLabel(label);
    } catch (e) {
      errors.push(String(item.id) + ': ' + e.message);
    }
  });
  logEvent('INFO', '', 'Importati dalle email ' + saved + ' allegati');
  return { saved: saved, files: files, errors: errors };
}
