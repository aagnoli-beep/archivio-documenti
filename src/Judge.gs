/**
 * Judge.gs - decide quali documenti trovati sul Mac meritano l'archivio di famiglia.
 *
 * Il Mac (harvest/daily-harvest.mjs) trova file nuovi in cartelle, foto, email personali e WhatsApp,
 * ne estrae il testo e manda qui solo nome + mittente + oggetto + un estratto. Claude risponde
 * archiviare sì/no con categoria e motivo; il Mac carica in 00_Inbox solo quelli approvati.
 * Così la chiave API resta nelle Script Properties e sul Mac non serve nessun segreto in più.
 */

var JUDGE_MAX_ITEMS = 40;
var JUDGE_TEXT_CHARS = 1500;

function judgeSystemPrompt_(cfg) {
  var famiglia = (cfg.family || []).join(', ') || 'la famiglia';
  return [
    'Sei l\'archivista di una famiglia italiana. Famiglia: ' + famiglia + '.',
    'Per ogni documento dell\'elenco decidi se va conservato nell\'archivio DI FAMIGLIA.',
    '',
    'ARCHIVIA (archiviare = true) i documenti che riguardano queste persone come privati cittadini:',
    '- salute: referti, analisi, visite, ricoveri, ricette, certificati e fatture mediche, dentista, veterinario dell\'animale di casa;',
    '- utenze di casa: luce, gas, acqua, telefono, internet, rifiuti;',
    '- auto e veicoli: bollo, multe e verbali, assicurazione, revisione, manutenzione;',
    '- fisco e tasse personali: F24, IMU, TARI, 730, certificazione unica, ISEE, cartelle esattoriali, detrazioni;',
    '- assicurazioni personali e quietanze; banca e finanza personale: estratti conto, mutuo, prestiti, bonifici importanti;',
    '- casa: rogito, locazioni, lavori e ristrutturazioni, preventivi e fatture di imprese, condominio, catasto, bonus edilizi;',
    '- legale: atti, successioni, diffide, solleciti, ricorsi che riguardano la famiglia;',
    '- documenti di identità e titoli di studio; scuola e figli: iscrizioni, rette, pagelle, comunicazioni, pediatra;',
    '- acquisti importanti con garanzia; atti che attestano avvenimenti di famiglia (nascita, matrimonio, battesimo);',
    '- buste paga, contratti di lavoro e certificazioni uniche INTESTATI a un familiare.',
    '',
    'NON archiviare (archiviare = false):',
    '- documenti delle aziende del proprietario o dei suoi clienti (bilanci, fatture aziendali, NDA, contratti commerciali, verbali di assemblea, buste paga di dipendenti);',
    '- documenti che riguardano persone o società estranee alla famiglia;',
    '- materiale di studio, corsi, slide, dispense, paper, ebook;',
    '- pubblicità, newsletter, offerte, condizioni generali, informative privacy;',
    '- ricevute di software e servizi usati per lavoro; screenshot di programmi, chat, home banking o pagine web;',
    '- biglietti di viaggio, ricevute di consegna e ordini di piccolo importo senza garanzia rilevante.',
    '',
    'Nel dubbio su un documento personale ma poco importante, scegli false: meglio un archivio pulito.',
    'Il testo può venire da OCR e contenere errori: interpretalo con indulgenza.',
    'Rispondi con un esito per OGNI documento, usando gli id ricevuti.'
  ].join('\n');
}

function judgeSchema_(categoryNames) {
  return {
    type: 'object',
    properties: {
      esiti: {
        type: 'array',
        description: 'Un esito per ogni documento ricevuto, nello stesso ordine',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'id del documento ricevuto' },
            archiviare: { type: 'boolean', description: 'true se va nell\'archivio di famiglia' },
            categoria: { type: 'string', enum: categoryNames.concat(['']), description: 'categoria se archiviare = true, altrimenti stringa vuota' },
            tipo: { type: 'string', description: 'tipo di documento in poche parole' },
            motivo: { type: 'string', description: 'massimo 12 parole' }
          },
          required: ['id', 'archiviare', 'categoria', 'tipo', 'motivo'],
          additionalProperties: false
        }
      }
    },
    required: ['esiti'],
    additionalProperties: false
  };
}

/**
 * @param {Array<{id:string, nome:string, da:string, oggetto:string, testo:string, origine:string}>} items
 * @return {{esiti: Array<Object>, valutati: number}}
 */
function valutaDocumenti(items, cfg) {
  if (!items || !items.length) return { esiti: [], valutati: 0 };
  items = items.slice(0, JUDGE_MAX_ITEMS);
  var apiKey = getProp_(PROP.ANTHROPIC_API_KEY, false);
  if (!apiKey) throw new ApiError('config', 'Script Property ANTHROPIC_API_KEY non impostata');

  var elenco = items.map(function (it, i) {
    var id = String(it.id || i);
    return ['[' + id + ']',
      'origine: ' + (it.origine || '?'),
      'nome file: ' + String(it.nome || '').substring(0, 120),
      it.da ? 'email da: ' + String(it.da).substring(0, 90) : '',
      it.oggetto ? 'oggetto: ' + String(it.oggetto).substring(0, 140) : '',
      'testo: ' + String(it.testo || '(nessun testo leggibile)').substring(0, JUDGE_TEXT_CHARS)
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  var body = {
    model: cfg.judgeModel || cfg.model,
    max_tokens: 4000,
    system: judgeSystemPrompt_(cfg),
    messages: [{ role: 'user', content: 'DOCUMENTI DA VALUTARE:\n\n' + elenco }],
    output_config: { format: { type: 'json_schema', schema: judgeSchema_(cfg.categoryNames) } }
  };
  if (supportsEffort_(body.model)) body.output_config.effort = cfg.effort;
  var headers = { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  if (supportsFallbacks_(body.model)) { body.fallbacks = 'default'; headers['anthropic-beta'] = FALLBACK_BETA; }

  var resp = fetchWithRetry_(body, headers);
  var data = JSON.parse(resp.getContentText());
  var text = ((data.content || []).filter(function (b) { return b.type === 'text'; })[0] || {}).text || '{}';
  var out;
  try { out = JSON.parse(text); } catch (e) { throw new ApiError('parse', 'Risposta non valida dal modello'); }
  var esiti = (out.esiti || []).filter(function (e) { return e && e.id; });
  var si = esiti.filter(function (e) { return e.archiviare; }).length;
  logEvent('INFO', '', 'Valutati ' + esiti.length + ' documenti dal Mac: ' + si + ' da archiviare');
  return { esiti: esiti, valutati: esiti.length };
}
