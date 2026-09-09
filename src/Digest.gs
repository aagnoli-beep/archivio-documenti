/**
 * Digest.gs - rendiconto giornaliero via email dei documenti scansionati.
 *
 * Trigger: sendDailyDigest() ogni giorno all'ora DIGEST_HOUR (foglio Config, default 20).
 * Destinatari: DIGEST_EMAILS (foglio Config). Mittente: l'account Google proprietario dello script.
 *
 * - fino a 10 documenti: descrizione discorsiva di 2 righe per documento (scritta da Claude), più i link
 * - da 11 a 30: tabella con l'elenco
 * - oltre 30: solo il conteggio con il link all'archivio
 * - 0 documenti: nessuna email
 * Il periodo coperto va dall'ultimo invio (Script Property DIGEST_LAST_AT) a ora; al primo invio, le ultime 24 ore.
 */

var DIGEST_DISCURSIVE_MAX = 10;
var DIGEST_TABLE_MAX = 30;

function sendDailyDigest() {
  var cfg = getConfig();
  var recipients = cfg.digestEmails;
  if (!recipients.length) { logEvent('WARN', '', 'Rendiconto non inviato: DIGEST_EMAILS vuoto nel foglio Config'); return; }

  var props = getProps_();
  var now = new Date();
  var since = props.getProperty('DIGEST_LAST_AT') ? new Date(props.getProperty('DIGEST_LAST_AT')) : new Date(now.getTime() - 24 * 3600 * 1000);
  var docs = getAllIndexRows().filter(function (d) {
    var t = parseScanDate_(d.dataScansione);
    return t && t > since && t <= now;
  });
  docs.sort(function (a, b) { return a.dataScansione < b.dataScansione ? -1 : 1; });

  if (!docs.length) {
    props.setProperty('DIGEST_LAST_AT', now.toISOString());
    logEvent('INFO', '', 'Rendiconto: nessun documento dal ' + since.toISOString().substring(0, 16) + ', nessuna email');
    return;
  }

  var mail = buildDigestEmail_(docs, since, now, cfg);
  MailApp.sendEmail({ to: recipients.join(','), subject: mail.subject, htmlBody: mail.html, body: mail.text, name: 'Archivio di casa' });
  props.setProperty('DIGEST_LAST_AT', now.toISOString());
  logEvent('INFO', '', 'Rendiconto inviato a ' + recipients.join(', ') + ': ' + docs.length + ' documenti (' + mail.mode + ')');
}

function parseScanDate_(s) {
  if (s instanceof Date) return s;
  var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}

function fmtIt_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(iso || '');
}

function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

function docLink_(d, cfg) {
  return d.link || driveViewUrl_(d.id);
}

/** Costruisce oggetto, HTML e testo dell'email. */
function buildDigestEmail_(docs, since, now, cfg) {
  var n = docs.length;
  var dateLabel = Utilities.formatDate(now, 'Europe/Rome', 'd MMMM yyyy');
  var subject = 'Archivio di casa: ' + (n === 1 ? '1 documento nuovo' : n + ' documenti nuovi') + ' (' + dateLabel + ')';
  var siteUrl = cfg.siteUrl || '';
  var archiveUrl = 'https://drive.google.com/drive/folders/' + getProp_(PROP.ARCHIVE_FOLDER_ID, true);
  var toCheck = docs.filter(function (d) { return d.stato === STATO.DA_VERIFICARE || d.stato === STATO.NON_CLASSIFICATO; });
  var mode, bodyHtml, bodyText;

  if (n <= DIGEST_DISCURSIVE_MAX) {
    mode = 'discorsivo';
    var texts = describeDocsWithClaude_(docs, cfg);
    bodyHtml = '<p>' + esc_(texts.intro) + '</p>';
    bodyText = texts.intro + '\n\n';
    docs.forEach(function (d) {
      var t = texts.byId[d.id] || fallbackDescription_(d);
      bodyHtml += '<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #e4e0d6;border-radius:12px">' +
        '<div style="font-weight:600;margin-bottom:4px">' + esc_(d.titolo || d.nomeFile) + '</div>' +
        '<div style="color:#444">' + esc_(t) + '</div>' +
        '<div style="margin-top:6px;font-size:13px;color:#6d6a63">' + esc_([d.categoria, d.sottocategoria].filter(Boolean).join(' › ')) +
        (d.importo ? ' · ' + esc_(d.importo) : '') + (d.scadenza ? ' · scadenza ' + esc_(fmtIt_(d.scadenza)) : '') +
        (d.stato !== STATO.AUTO && d.stato !== STATO.VERIFICATO ? ' · <b>' + esc_(d.stato) + '</b>' : '') +
        ' · <a href="' + esc_(docLink_(d, cfg)) + '">apri</a></div></div>';
      bodyText += '• ' + (d.titolo || d.nomeFile) + '\n  ' + t + '\n  ' + docLink_(d, cfg) + '\n\n';
    });
  } else if (n <= DIGEST_TABLE_MAX) {
    mode = 'tabella';
    var intro = 'Oggi sono arrivati ' + n + ' documenti: ecco l\'elenco.';
    bodyHtml = '<p>' + esc_(intro) + '</p><table style="border-collapse:collapse;width:100%;font-size:14px">' +
      '<tr style="text-align:left;color:#6d6a63"><th style="padding:6px 8px;border-bottom:1px solid #e4e0d6">Documento</th><th style="padding:6px 8px;border-bottom:1px solid #e4e0d6">Categoria</th><th style="padding:6px 8px;border-bottom:1px solid #e4e0d6">Da / per</th><th style="padding:6px 8px;border-bottom:1px solid #e4e0d6">Importo</th></tr>';
    bodyText = intro + '\n\n';
    docs.forEach(function (d) {
      bodyHtml += '<tr><td style="padding:6px 8px;border-bottom:1px solid #f0ede6"><a href="' + esc_(docLink_(d, cfg)) + '">' + esc_(d.titolo || d.nomeFile) + '</a></td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #f0ede6">' + esc_([d.categoria, d.sottocategoria].filter(Boolean).join(' › ')) + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #f0ede6">' + esc_((d.mittente || '?') + ' → ' + (d.soggetti || d.destinatario || '?')) + '</td>' +
        '<td style="padding:6px 8px;border-bottom:1px solid #f0ede6">' + esc_(d.importo || '') + '</td></tr>';
      bodyText += '• ' + (d.titolo || d.nomeFile) + ' · ' + d.categoria + ' · ' + (d.mittente || '?') + ' → ' + (d.soggetti || '?') + (d.importo ? ' · ' + d.importo : '') + '\n';
    });
    bodyHtml += '</table>';
  } else {
    mode = 'conteggio';
    var msg = 'Oggi sono stati archiviati ' + n + ' documenti: sono tanti, meglio dare un\'occhiata all\'archivio con calma.';
    bodyHtml = '<p>' + esc_(msg) + '</p>';
    bodyText = msg + '\n';
  }

  if (toCheck.length) {
    var warn = toCheck.length === 1 ? '1 documento è segnato "da verificare": conviene controllarlo.' : toCheck.length + ' documenti sono segnati "da verificare": conviene controllarli.';
    bodyHtml += '<p style="background:#fff3d1;color:#7a5200;padding:10px 12px;border-radius:10px">' + esc_(warn) + '</p>';
    bodyText += '\n' + warn + '\n';
  }

  var footer = (siteUrl ? '<a href="' + esc_(siteUrl) + '">Apri il sito</a> · ' : '') + '<a href="' + esc_(archiveUrl) + '">Cartella su Drive</a>';
  var html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1e1d1a;font-size:15px;line-height:1.5">' +
    '<h2 style="margin:0 0 4px;font-size:20px">Archivio di casa</h2>' +
    '<div style="color:#6d6a63;margin-bottom:16px">Rendiconto del ' + esc_(dateLabel) + ' · ' + (n === 1 ? '1 documento nuovo' : n + ' documenti nuovi') + '</div>' +
    bodyHtml + '<p style="margin-top:20px;font-size:13px;color:#6d6a63">' + footer + '</p></div>';
  var text = 'Archivio di casa · rendiconto del ' + dateLabel + '\n\n' + bodyText + '\n' + (siteUrl ? 'Sito: ' + siteUrl + '\n' : '') + 'Drive: ' + archiveUrl + '\n';
  return { subject: subject, html: html, text: text, mode: mode };
}

function fallbackDescription_(d) {
  var parts = [];
  parts.push((d.tipoDocumento || 'Documento') + (d.mittente ? ' da ' + d.mittente : '') + (d.soggetti ? ' per ' + d.soggetti : '') + '.');
  if (d.riassunto) parts.push(d.riassunto);
  if (d.importo) parts.push('Importo: ' + d.importo + '.');
  if (d.scadenza) parts.push('Scadenza: ' + fmtIt_(d.scadenza) + '.');
  return parts.join(' ');
}

/** Chiede a Claude una frase introduttiva e 2 righe semplici per documento. In caso di errore usa i riassunti. */
function describeDocsWithClaude_(docs, cfg) {
  var byId = {};
  var fallback = function () { docs.forEach(function (d) { byId[d.id] = fallbackDescription_(d); }); return { intro: docs.length === 1 ? 'Oggi è arrivato un documento nuovo.' : 'Oggi sono arrivati ' + docs.length + ' documenti nuovi.', byId: byId }; };
  var apiKey = getProp_(PROP.ANTHROPIC_API_KEY, false);
  if (!apiKey) return fallback();
  try {
    var cards = docs.map(function (d) { return docCard_(d); }).join('\n');
    var body = {
      model: cfg.model,
      max_tokens: 2000,
      system: 'Scrivi in italiano, tono semplice e familiare, come un assistente di casa che racconta la posta arrivata a una famiglia (' + (cfg.family.join(', ') || 'la famiglia') + '). ' +
        'Per ogni documento scrivi al massimo due frasi chiare che dicano cosa è, da chi arriva, per chi è, e se ci sono importi o scadenze. Niente formule burocratiche, niente elenchi puntati nelle frasi. ' +
        'Se un documento è "Da verificare" o "Non classificato", dillo con una frase tipo "conviene dargli un\'occhiata".',
      messages: [{ role: 'user', content: 'Documenti arrivati oggi:\n' + cards + '\n\nScrivi una frase introduttiva e una descrizione per ciascun documento.' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              intro: { type: 'string', description: 'Una frase introduttiva (es. "Oggi sono arrivati tre documenti, tra cui una bolletta da pagare.")' },
              documenti: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, testo: { type: 'string' } }, required: ['id', 'testo'], additionalProperties: false } }
            },
            required: ['intro', 'documenti'],
            additionalProperties: false
          }
        }
      }
    };
    if (supportsEffort_(cfg.model)) body.output_config.effort = cfg.effort;
    var headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    if (supportsFallbacks_(cfg.model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }
    var resp = fetchWithRetry_(body, headers);
    var data = JSON.parse(resp.getContentText());
    var textBlock = (data.content || []).filter(function (b) { return b.type === 'text'; })[0];
    var out = JSON.parse(textBlock.text);
    (out.documenti || []).forEach(function (x) { if (x && x.id && x.testo) byId[String(x.id).replace(/[\[\]]/g, '')] = String(x.testo).trim(); });
    docs.forEach(function (d) { if (!byId[d.id]) byId[d.id] = fallbackDescription_(d); });
    return { intro: out.intro || fallback().intro, byId: byId };
  } catch (e) {
    logEvent('WARN', '', 'Rendiconto: descrizioni Claude non disponibili, uso i riassunti (' + e.message + ')');
    return fallback();
  }
}
