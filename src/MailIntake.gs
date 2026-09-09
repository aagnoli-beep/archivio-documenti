/**
 * MailIntake.gs - ingresso documenti via email.
 *
 * Trigger: processMailIntake() ogni 5 minuti. Legge le email arrivate all'indirizzo di intake
 * (Config MAIL_INTAKE_ADDRESS, default <account>+archivio@gmail.com) inviate dai mittenti di famiglia
 * (Config MAIL_SENDERS; vuoto = ALLOWED_EMAILS + DIGEST_EMAILS + proprietario):
 *   - gli allegati PDF/immagine vengono salvati in 00_Inbox (poi li classifica processInbox);
 *   - se non ci sono allegati utili, l'email stessa diventa un PDF e viene archiviata;
 *   - il messaggio riceve l'etichetta Archivio/Elaborate (o Archivio/Ignorate se il mittente non è ammesso).
 * Nessuna email viene cancellata.
 */

var MAIL_LABEL_DONE = 'Archivio/Elaborate';
var MAIL_LABEL_SKIP = 'Archivio/Ignorate';
var MAIL_MAX_PER_RUN = 20;
var MAIL_ATTACH_MAX_BYTES = 25 * 1024 * 1024;
var MAIL_INLINE_MIN_BYTES = 30 * 1024;    // immagini inline più piccole (loghi, firme) vengono ignorate
var MAIL_MAX_ATTEMPTS = 5;
var MAIL_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'];

function processMailIntake() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var cfg = getConfig();
    var address = cfg.mailIntakeAddress;
    if (!address) { logEvent('WARN', '', 'Ingresso email disattivato: MAIL_INTAKE_ADDRESS vuoto'); return; }
    var senders = cfg.mailSenders;
    var labelDone = getOrCreateLabel_(MAIL_LABEL_DONE);
    var labelSkip = getOrCreateLabel_(MAIL_LABEL_SKIP);
    var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
    var query = 'deliveredto:' + address + ' -label:' + MAIL_LABEL_DONE + ' -label:' + MAIL_LABEL_SKIP + ' newer_than:14d';
    var threads = GmailApp.search(query, 0, MAIL_MAX_PER_RUN);

    threads.forEach(function (thread) {
      var key = 'MAILTRY_' + thread.getId();
      try {
        var result = processThread_(thread, senders, inbox);
        if (result.saved > 0) thread.addLabel(labelDone);
        else thread.addLabel(labelSkip);
        getProps_().deleteProperty(key);
      } catch (e) {
        var attempts = (parseInt(getProps_().getProperty(key), 10) || 0) + 1;
        getProps_().setProperty(key, String(attempts));
        if (attempts >= MAIL_MAX_ATTEMPTS) {
          thread.addLabel(labelSkip);
          getProps_().deleteProperty(key);
          logEvent('ERROR', 'email: ' + thread.getFirstMessageSubject(), 'Email ignorata dopo ' + attempts + ' tentativi: ' + e.message);
        } else {
          logEvent('WARN', 'email: ' + thread.getFirstMessageSubject(), 'Tentativo ' + attempts + ' fallito, riprovo: ' + e.message);
        }
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Elabora tutti i messaggi di una conversazione. @return {{saved:number, skipped:number}} */
function processThread_(thread, senders, inbox) {
  var saved = 0, skipped = 0;
  thread.getMessages().forEach(function (msg) {
    var from = extractEmail_(msg.getFrom());
    var subject = msg.getSubject() || '(senza oggetto)';
    if (senders.indexOf(from) < 0) {
      skipped++;
      logEvent('WARN', 'email: ' + subject, 'Email ignorata: mittente non ammesso (' + from + ')');
      return;
    }
    var n = saveMessageAttachments_(msg, inbox, subject);
    if (n === 0) { saveMessageAsPdf_(msg, inbox, subject); n = 1; }
    saved += n;
    logEvent('INFO', 'email: ' + subject, 'Da ' + from + ': ' + n + ' file messi in Inbox');
  });
  return { saved: saved, skipped: skipped };
}

function extractEmail_(fromHeader) {
  var m = String(fromHeader || '').match(/<([^>]+)>/);
  return (m ? m[1] : String(fromHeader || '')).trim().toLowerCase();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function mailFilePrefix_(msg, subject) {
  return Utilities.formatDate(msg.getDate(), 'Europe/Rome', 'yyyy-MM-dd') + '_email_' + slugify(subject, 40);
}

/** Salva in Inbox gli allegati utili (PDF, immagini). @return numero di file salvati */
function saveMessageAttachments_(msg, inbox, subject) {
  var count = 0;
  var prefix = mailFilePrefix_(msg, subject);
  msg.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(function (att) {
    var mime = String(att.getContentType() || '').toLowerCase();
    var size = att.getSize();
    if (MAIL_DOC_MIMES.indexOf(mime) < 0) return;
    if (size > MAIL_ATTACH_MAX_BYTES) { logEvent('WARN', att.getName(), 'Allegato saltato: troppo grande'); return; }
    if (mime !== 'application/pdf' && size < MAIL_INLINE_MIN_BYTES) return;   // logo/firma
    var name = prefix + '_' + slugify(att.getName().replace(/\.[^.]+$/, ''), 40) + '.' + extensionForMime_(mime, att.getName());
    inbox.createFile(att.copyBlob().setName(name));
    count++;
  });
  return count;
}

function extensionForMime_(mime, originalName) {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  var m = String(originalName || '').match(/\.([A-Za-z0-9]{1,5})$/);
  return m ? m[1].toLowerCase() : 'bin';
}

/** Trasforma il messaggio in un PDF (intestazione + corpo) e lo mette in Inbox. */
function saveMessageAsPdf_(msg, inbox, subject) {
  var html = '<html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:11pt">' +
    '<p><b>Da:</b> ' + escapeHtml_(msg.getFrom()) + '<br><b>A:</b> ' + escapeHtml_(msg.getTo()) +
    '<br><b>Data:</b> ' + Utilities.formatDate(msg.getDate(), 'Europe/Rome', 'dd/MM/yyyy HH:mm') +
    '<br><b>Oggetto:</b> ' + escapeHtml_(subject) + '</p><hr>' +
    (msg.getBody() || escapeHtml_(msg.getPlainBody() || '')) + '</body></html>';
  var tmp = Drive.Files.create(
    { name: 'tmp-mail-' + msg.getId(), mimeType: 'application/vnd.google-apps.document' },
    Utilities.newBlob(html, 'text/html', 'mail.html'),
    { supportsAllDrives: true }
  );
  try {
    var pdf = DriveApp.getFileById(tmp.id).getAs('application/pdf');
    inbox.createFile(pdf.setName(mailFilePrefix_(msg, subject) + '.pdf'));
  } finally {
    try { Drive.Files.remove(tmp.id, { supportsAllDrives: true }); } catch (e) { /* resta al massimo un doc temporaneo */ }
  }
}

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}
