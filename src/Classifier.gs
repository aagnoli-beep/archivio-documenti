/**
 * Classifier.gs - chiamata a Claude per estrarre i metadati di un documento.
 *
 * Apps Script non può usare l'SDK Anthropic, quindi la chiamata è HTTP diretta a /v1/messages.
 * Il PDF (o l'immagine) viene inviato come content block "document"/"image" in base64.
 * L'output è vincolato a uno schema JSON (structured outputs), così il parsing è affidabile.
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';
var FALLBACK_BETA = 'server-side-fallback-2026-07-01';
var IMAGE_MAX_BYTES = 5 * 1024 * 1024;   // limite API per le immagini base64

/** Errore con codice, per distinguere problemi di chiave/credito da errori temporanei. */
function ClassifierError(code, message, retryable) {
  this.name = 'ClassifierError';
  this.code = code;           // 'auth' | 'credit' | 'rate_limit' | 'server' | 'bad_request' | 'refusal' | 'parse'
  this.message = message;
  this.retryable = !!retryable;
}
ClassifierError.prototype = Object.create(Error.prototype);

function jsonSchema_(categoryNames) {
  return {
    type: 'object',
    properties: {
      categoria: { type: 'string', enum: categoryNames },
      sottocategoria: { type: 'string', description: 'Sottocategoria, preferibilmente una di quelle elencate per la categoria scelta' },
      sotto_sottocategoria: { type: 'string', description: 'Ulteriore dettaglio se utile, altrimenti stringa vuota' },
      tipo_documento: { type: 'string', description: 'Es. Referto, Fattura, Lettera, Contratto, Ricevuta, Certificato, Modulo, Comunicazione' },
      mittente: { type: 'string', description: 'Chi ha emesso o inviato il documento (ente, azienda, professionista o persona)' },
      destinatario: { type: 'string', description: 'A chi è indirizzato il documento' },
      soggetti: { type: 'array', items: { type: 'string' }, description: 'Persone della famiglia o altre persone a cui il documento si riferisce' },
      data_documento: { type: 'string', description: 'Data del documento in formato YYYY-MM-DD, oppure stringa vuota se non presente' },
      titolo_breve: { type: 'string', description: 'Titolo di 3-6 parole che identifica il documento' },
      riassunto: { type: 'string', description: 'Una o due frasi in italiano su cosa contiene il documento' },
      importo: { type: 'string', description: 'Importo principale con valuta (es. "123,45 EUR"), oppure stringa vuota' },
      scadenza: { type: 'string', description: 'Eventuale scadenza o data di pagamento in YYYY-MM-DD, oppure stringa vuota' },
      numero_pagine: { type: 'integer', description: 'Numero di pagine del documento' },
      confidenza: { type: 'number', description: 'Quanto sei sicuro della classificazione, da 0 a 1' }
    },
    required: ['categoria', 'sottocategoria', 'sotto_sottocategoria', 'tipo_documento', 'mittente', 'destinatario',
      'soggetti', 'data_documento', 'titolo_breve', 'riassunto', 'importo', 'scadenza', 'numero_pagine', 'confidenza'],
    additionalProperties: false
  };
}

function systemPrompt_(cfg) {
  var catLines = cfg.categoryNames.map(function (name) {
    return '- ' + name + ': ' + cfg.categories[name].join(', ');
  }).join('\n');
  return [
    'Sei l\'archivista di una famiglia italiana. Ricevi la scansione di un documento cartaceo arrivato a casa',
    'e devi compilare i metadati per archiviarlo. Rispondi solo con il JSON richiesto, in italiano.',
    '',
    'Categorie ammesse e relative sottocategorie suggerite:',
    catLines,
    '',
    'Membri della famiglia (usa questi nomi, scritti così, quando il documento li riguarda): ' + (cfg.family.join(', ') || 'non indicati'),
    '',
    'Regole:',
    '- Scegli SEMPRE una categoria tra quelle ammesse; usa "Altro" solo se nessuna è adatta.',
    '- Mittente e destinatario: nomi brevi e riconoscibili (es. "ASL Roma 1", "Enel Energia", "Dott. Mario Rossi", "Andrea Agnoli").',
    '- Soggetti: le persone a cui il documento si riferisce (paziente, intestatario, alunno...), non gli enti.',
    '- data_documento: la data riportata sul documento; se ci sono più date usa quella di emissione; se assente lascia vuoto.',
    '- titolo_breve: senza date, senza nomi di mittente/destinatario (sono già in altri campi).',
    '- confidenza bassa (< 0.6) se il testo è illeggibile, il documento è ambiguo o mancano informazioni chiave.',
    '- Oggi è ' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd') + '.'
  ].join('\n');
}

function supportsEffort_(model) {
  return !/haiku|sonnet-4|opus-4-5|3-/.test(model);
}
function supportsFallbacks_(model) {
  return /^claude-(opus-5|fable)/.test(model);
}

/**
 * Prepara il content block del file: PDF intero (base64) se piccolo, immagine se è un'immagine,
 * altrimenti testo estratto con l'OCR di Drive.
 */
function buildFileBlock_(file, cfg) {
  var mime = file.getMimeType();
  var size = file.getSize();
  if (mime === MimeType.PDF && size <= cfg.maxPdfBytes) {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: Utilities.base64Encode(file.getBlob().getBytes()) }
    };
  }
  if ((mime === MimeType.JPEG || mime === MimeType.PNG || mime === 'image/webp') && size <= IMAGE_MAX_BYTES) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mime, data: Utilities.base64Encode(file.getBlob().getBytes()) }
    };
  }
  var text = ocrTextViaDrive(file);
  if (!text || text.trim().length < 20) {
    throw new ClassifierError('parse', 'Nessun testo leggibile nel file (OCR vuoto) e file troppo grande per l\'invio diretto', false);
  }
  return { type: 'text', text: 'Testo estratto dal documento (OCR):\n\n' + text.substring(0, 60000) };
}

/**
 * Classifica un file Drive con Claude.
 * @param {GoogleAppsScript.Drive.File} file
 * @param {Object} cfg risultato di getConfig()
 * @return {Object} metadati con le chiavi dello schema JSON
 */
function classifyDocument(file, cfg) {
  var apiKey = getProp_(PROP.ANTHROPIC_API_KEY, false);
  if (!apiKey) throw new ClassifierError('auth', 'Script Property ANTHROPIC_API_KEY non impostata', false);

  var fileBlock = buildFileBlock_(file, cfg);
  var body = {
    model: cfg.model,
    max_tokens: 2048,
    system: systemPrompt_(cfg),
    messages: [{
      role: 'user',
      content: [
        fileBlock,
        { type: 'text', text: 'Nome originale del file: ' + file.getName() + '\n\nCompila i metadati di archiviazione per questo documento.' }
      ]
    }],
    output_config: { format: { type: 'json_schema', schema: jsonSchema_(cfg.categoryNames) } }
  };
  if (supportsEffort_(cfg.model)) body.output_config.effort = cfg.effort;

  var headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  if (supportsFallbacks_(cfg.model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = FALLBACK_BETA;
  }

  var resp = fetchWithRetry_(body, headers);
  var data = JSON.parse(resp.getContentText());
  if (data.stop_reason === 'refusal') {
    throw new ClassifierError('refusal', 'Il modello ha rifiutato di elaborare il documento', false);
  }
  var textBlock = (data.content || []).filter(function (b) { return b.type === 'text'; })[0];
  if (!textBlock) throw new ClassifierError('parse', 'Risposta senza testo (stop_reason=' + data.stop_reason + ')', true);
  try {
    var meta = JSON.parse(textBlock.text);
  } catch (e) {
    throw new ClassifierError('parse', 'JSON non valido nella risposta: ' + textBlock.text.substring(0, 200), true);
  }
  meta._usage = data.usage || {};
  meta._model = data.model || cfg.model;
  return meta;
}

/** Chiamata HTTP con retry su 429/5xx/errori di rete (3 tentativi). */
function fetchWithRetry_(body, headers) {
  var delays = [0, 3000, 8000];
  var lastErr = null;
  for (var attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) Utilities.sleep(delays[attempt]);
    var resp;
    try {
      resp = UrlFetchApp.fetch(ANTHROPIC_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
    } catch (e) {
      lastErr = new ClassifierError('server', 'Errore di rete: ' + e.message, true);
      continue;
    }
    var code = resp.getResponseCode();
    if (code === 200) return resp;

    var errMsg = '';
    try { errMsg = JSON.parse(resp.getContentText()).error.message; } catch (e) { errMsg = resp.getContentText().substring(0, 300); }
    if (code === 401 || code === 403) throw new ClassifierError('auth', 'HTTP ' + code + ': ' + errMsg, false);
    if (code === 400 && /credit|balance|billing/i.test(errMsg)) throw new ClassifierError('credit', 'HTTP 400: ' + errMsg, false);
    if (code === 400 || code === 404 || code === 413) throw new ClassifierError('bad_request', 'HTTP ' + code + ': ' + errMsg, false);
    if (code === 429) { lastErr = new ClassifierError('rate_limit', 'HTTP 429: ' + errMsg, true); continue; }
    lastErr = new ClassifierError('server', 'HTTP ' + code + ': ' + errMsg, true);
  }
  throw lastErr;
}

/** Test manuale: classifica il primo file della Inbox e stampa il risultato nel log (non lo sposta). */
function testClassifyFirstInboxFile() {
  var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
  var it = inbox.getFiles();
  if (!it.hasNext()) { console.log('Inbox vuota'); return; }
  var file = it.next();
  var meta = classifyDocument(file, getConfig());
  console.log(JSON.stringify(meta, null, 2));
}
