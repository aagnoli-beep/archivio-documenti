/**
 * Ask.gs - "Chiedi all'archivio": risponde alle domande della famiglia cercando nell'Indice.
 *
 * 1. Seleziona i documenti più pertinenti con un punteggio sulle parole della domanda.
 * 2. Passa a Claude la domanda e le schede dei documenti (metadati, riassunto, parole chiave).
 * 3. Claude risponde in italiano citando gli ID dei documenti usati; il sito li mostra come link.
 */

var ASK_MAX_DOCS = 60;
var ASK_HISTORY_TURNS = 6;

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

  var system = [
    'Sei l\'assistente dell\'archivio documentale di una famiglia italiana. Rispondi in italiano, in modo breve e concreto.',
    'Hai a disposizione SOLO le schede dei documenti elencate nel messaggio (metadati e riassunti, non il testo integrale).',
    'Regole:',
    '- Rispondi usando solo le informazioni delle schede. Se non trovi nulla di pertinente, dillo chiaramente e suggerisci cosa cercare o scansionare.',
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
  messages.push({
    role: 'user',
    content: 'SCHEDE DOCUMENTI:\n' + (relevant.map(docCard_).join('\n') || '(archivio vuoto)') + '\n\nDOMANDA: ' + question
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
  logEvent('INFO', '', 'Domanda all\'archivio (' + relevant.length + ' schede, ' + ((data.usage || {}).input_tokens || '?') + ' token): ' + question.substring(0, 120));
  return { answer: out.risposta || '', docs: docs, searched: relevant.length, total: all.length };
}
