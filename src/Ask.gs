/**
 * Ask.gs - "Chiedi all'archivio": risponde alle domande della famiglia cercando nell'Indice.
 *
 * 1. Seleziona i documenti più pertinenti con un punteggio sulle parole della domanda.
 * 2. Aggiunge quelli che contengono le parole della domanda nel testo del PDF (ricerca a testo pieno di Drive):
 *    serve per dati che stanno nel documento ma non nel riassunto (un peso, una pressione, un numero di polizza).
 * 3. Per i primi di questi allega anche gli estratti, cioè le righe vere intorno alle parole cercate.
 * 4. Passa a Claude la domanda, le schede e gli estratti; Claude risponde in italiano citando gli ID usati.
 */

var ASK_MAX_DOCS = 60;
var ASK_HISTORY_TURNS = 6;
var ASK_FULLTEXT_DOCS = 20;   // documenti in più trovati cercando dentro al testo dei PDF
var ASK_ESTRATTI_DOCS = 6;    // di quanti allegare le righe vere del documento

function normalizeText_(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ');
}

function docHaystack_(d) {
  return normalizeText_([d.titolo, d.categoria, d.sottocategoria, d.sottoSottocategoria, d.tipoDocumento, d.mittente,
    d.destinatario, d.soggetti, d.riassunto, d.paroleChiave, d.importo, d.dataDocumento, d.scadenza, d.nomeFile].join(' '));
}

/** Documenti più pertinenti alla domanda (tutti, se l'archivio è piccolo). */
function selectRelevantDocs_(question, docs) {
  if (docs.length <= ASK_MAX_DOCS) return docs;
  var terms = normalizeText_(question).split(/\s+/).filter(function (t) { return t.length > 2; });
  var scored = docs.map(function (d) {
    var hay = docHaystack_(d);
    var score = 0;
    terms.forEach(function (t) { if (hay.indexOf(t) >= 0) score += (t.length > 4 ? 2 : 1); });
    return { d: d, score: score };
  });
  scored.sort(function (a, b) { return b.score - a.score || (a.d.dataDocumento < b.d.dataDocumento ? 1 : -1); });
  return scored.slice(0, ASK_MAX_DOCS).map(function (x) { return x.d; });
}

function docCard_(d) {
  return '[' + d.id + '] ' + (d.dataDocumento || '?') + ' | ' + [d.categoria, d.sottocategoria, d.sottoSottocategoria].filter(Boolean).join(' > ') +
    ' | ' + (d.tipoDocumento || '') + ' | da: ' + (d.mittente || '?') + ' a: ' + (d.destinatario || '?') +
    ' | persone: ' + (d.soggetti || '-') + ' | titolo: ' + (d.titolo || '') +
    (d.importo ? ' | importo: ' + d.importo : '') + (d.scadenza ? ' | scadenza: ' + d.scadenza : '') +
    ' | stato: ' + (d.stato || '') + '\n   riassunto: ' + (d.riassunto || '-') + (d.paroleChiave ? '\n   parole chiave: ' + d.paroleChiave : '');
}

/**
 * @param {string} question
 * @param {Array<{role:string, text:string}>} history turni precedenti (facoltativi)
 * @return {{answer:string, docs:Array<Object>, searched:number}}
 */
function askArchive(question, history, cfg) {
  question = String(question || '').trim();
  if (!question) throw new ApiError('bad_request', 'Scrivi una domanda.');
  var apiKey = getProp_(PROP.ANTHROPIC_API_KEY, false);
  if (!apiKey) throw new ApiError('config', 'Chiave API non impostata');

  var all = getAllIndexRows();
  var relevant = selectRelevantDocs_(question, all);
  var byId = {};
  all.forEach(function (d) { byId[d.id] = d; });

  // Documenti che contengono le parole della domanda nel testo, anche se la scheda non ne parla.
  var idTesto = [];
  try { idTesto = idPerTestoPieno_(question, byId).slice(0, ASK_FULLTEXT_DOCS); }
  catch (e) { logEvent('WARN', '', 'Ricerca nel testo non disponibile per questa domanda: ' + e.message); }
  var inElenco = {};
  relevant.forEach(function (d) { inElenco[d.id] = true; });
  var aggiunti = idTesto.filter(function (x) { return !inElenco[x.id]; }).map(function (x) { return byId[x.id]; });
  relevant = aggiunti.concat(relevant);

  // Estratti dal testo per i primi documenti trovati nel contenuto: solo copie già salvate, più
  // qualche OCR fatto al momento, con un tetto di tempo per non far scadere la richiesta.
  var parole = termini_(question);
  var estratti = [], ocrFatti = 0, inizio = Date.now();
  idTesto.slice(0, ASK_ESTRATTI_DOCS).forEach(function (x) {
    var testo = testoCacheGet_(x.id);
    if (testo === null && ocrFatti < 3 && Date.now() - inizio < 90000) {
      try { testo = estraiTesto_(DriveApp.getFileById(x.id)); testoCachePut_(x.id, testo); ocrFatti++; }
      catch (e) { testo = null; }
    }
    if (testo === null) return;
    var righe = estrattiDaTesto_(testo, parole, 3);
    if (righe.length) estratti.push({ id: x.id, doc: byId[x.id], righe: righe });
  });

  var system = [
    'Sei l\'assistente dell\'archivio documentale di una famiglia italiana. Rispondi in italiano, in modo breve e concreto.',
    'Hai a disposizione le schede dei documenti elencate nel messaggio (metadati e riassunti) e, per alcuni, gli estratti: le righe vere copiate dal documento.',
    'Regole:',
    '- Rispondi usando solo le informazioni delle schede e degli estratti. Se non trovi nulla di pertinente, dillo chiaramente e suggerisci cosa cercare o scansionare.',
    '- Gli estratti sono il testo vero del documento: per dati come pesi, misure, numeri di polizza o importi valgono più del riassunto.',
    '- Se il dato chiesto potrebbe stare nel testo di un documento elencato senza estratti, dillo e indica quale documento conviene leggere per intero.',
    '- Cita i documenti che hai usato mettendo i loro ID nel campo "documenti" (solo ID presenti nell\'elenco).',
    '- Per date, importi e scadenze riporta i valori esatti delle schede. Se una scheda è "Da verificare", segnala che i dati potrebbero essere imprecisi.',
    '- Se la domanda è generica (es. "cosa c\'è di Serena?"), elenca i documenti pertinenti in modo ordinato.',
    '- Membri della famiglia: ' + (cfg.family.join(', ') || 'non indicati') + '.',
    '- Oggi è ' + Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd') + '. Archivio: ' + all.length + ' documenti in totale, ' + relevant.length + ' allegati qui.'
  ].join('\n');

  var messages = [];
  (history || []).slice(-ASK_HISTORY_TURNS).forEach(function (h) {
    if (h && h.text && (h.role === 'user' || h.role === 'assistant')) messages.push({ role: h.role, content: String(h.text).substring(0, 2000) });
  });
  if (messages.length && messages[0].role !== 'user') messages.shift();
  var bloccoEstratti = estratti.length
    ? '\n\nESTRATTI DAL TESTO DEI DOCUMENTI (righe copiate dal documento):\n' + estratti.map(function (e) {
        var d = e.doc || {};
        return '[' + e.id + '] ' + (d.dataDocumento || '?') + ' - ' + (d.titolo || d.nomeFile || '') + '\n   ' + e.righe.join('\n   ');
      }).join('\n')
    : '';
  messages.push({
    role: 'user',
    content: 'SCHEDE DOCUMENTI:\n' + (relevant.map(docCard_).join('\n') || '(archivio vuoto)') + bloccoEstratti + '\n\nDOMANDA: ' + question
  });

  var body = {
    model: cfg.model,
    max_tokens: 1500,
    system: system,
    messages: messages,
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            risposta: { type: 'string', description: 'Risposta in italiano, breve, in testo semplice (puoi usare elenchi con trattini)' },
            documenti: { type: 'array', items: { type: 'string' }, description: 'ID dei documenti citati, in ordine di importanza' }
          },
          required: ['risposta', 'documenti'],
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
  if (data.stop_reason === 'refusal') throw new ApiError('refusal', 'Non posso rispondere a questa domanda.');
  var text = ((data.content || []).filter(function (b) { return b.type === 'text'; })[0] || {}).text || '{}';
  var out;
  try { out = JSON.parse(text); } catch (e) { out = { risposta: text, documenti: [] }; }
  var docs = (out.documenti || []).map(function (id) { return byId[String(id).replace(/[\[\]]/g, '')]; }).filter(Boolean);
  logEvent('INFO', '', 'Domanda all\'archivio (' + relevant.length + ' schede, ' + estratti.length + ' con estratti, ' + ((data.usage || {}).input_tokens || '?') + ' token): ' + question.substring(0, 120));
  return { answer: out.risposta || '', docs: docs, searched: relevant.length, estratti: estratti.length, nelTesto: idTesto.length, total: all.length };
}
