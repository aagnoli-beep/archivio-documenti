/**
 * Strumenti MCP dell'archivio, condivisi tra il server locale (server.mjs) e il connettore remoto (remote/).
 * `api(action, payload)` chiama il backend Apps Script; `opts.saveFile(name, buffer)` è facoltativo (solo in locale).
 */

export const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const fmtDate = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || ''); };

function haystack(d) {
  return norm([d.titolo, d.nomeFile, d.categoria, d.sottocategoria, d.sottoSottocategoria, d.tipoDocumento, d.mittente,
    d.destinatario, d.soggetti, d.riassunto, d.importo, d.dataDocumento, d.scadenza, d.paroleChiave, d.nomeOriginale].join(' | '));
}

export function card(d) {
  const lines = [
    `# ${d.titolo || d.nomeFile}`,
    `ID: ${d.id}`,
    `Data documento: ${fmtDate(d.dataDocumento)} · Scansionato: ${d.dataScansione || '-'}`,
    `Categoria: ${[d.categoria, d.sottocategoria, d.sottoSottocategoria].filter(Boolean).join(' › ')}`,
    `Tipo: ${d.tipoDocumento || '-'} · Stato: ${d.stato || '-'} · Confidenza: ${d.confidenza ?? '-'}`,
    `Mittente: ${d.mittente || '-'} → Destinatario: ${d.destinatario || '-'}`,
    `Persone: ${d.soggetti || '-'}`
  ];
  if (d.importo) lines.push(`Importo: ${d.importo}`);
  if (d.scadenza) lines.push(`Scadenza: ${fmtDate(d.scadenza)}`);
  if (d.riassunto) lines.push(`Riassunto: ${d.riassunto}`);
  if (d.paroleChiave) lines.push(`Parole chiave: ${d.paroleChiave}`);
  lines.push(`File: ${d.nomeFile}`, `Drive: ${d.link || ''}`);
  return lines.join('\n');
}

export function shortLine(d) {
  return `- [${d.id}] ${fmtDate(d.dataDocumento)} · ${d.titolo || d.nomeFile} · ${d.categoria}${d.sottocategoria ? ' › ' + d.sottocategoria : ''} · ${d.mittente || '?'} → ${d.soggetti || d.destinatario || '?'}${d.importo ? ' · ' + d.importo : ''}${d.stato && d.stato !== 'Auto' ? ' · ' + d.stato : ''}`;
}

/**
 * Chiamata al backend Apps Script con tentativi ripetuti: Google ogni tanto risponde con una pagina HTML
 * di errore ("Impossibile aprire il file") anche a richieste corrette; riprovare dopo qualche secondo basta.
 * `fetchImpl` deve restituire il testo della risposta; questa funzione fa il parse e i retry.
 */
export async function callBackend(apiUrl, secret, action, payload = {}, opts = {}) {
  const retries = opts.retries ?? 3;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(apiUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, secret, ...payload }) });
      const txt = await res.text();
      let json;
      try { json = JSON.parse(txt); } catch { throw new Error('risposta non valida dal backend (HTTP ' + res.status + ')'); }
      if (!json.ok) { const e = new Error(json.error || 'Errore del backend'); e.code = json.code; e.permanent = true; throw e; }
      return json.data;
    } catch (e) {
      lastErr = e;
      if (e.permanent || i === retries - 1) break;
      await wait(2000 * (i + 1));
    }
  }
  throw lastErr;
}

/**
 * Scarica un documento dal backend a pezzi da 3 MB, con tentativi ripetuti per ogni pezzo:
 * Google ogni tanto risponde con una pagina di errore alle risposte grandi, e riprovare basta.
 */
export async function downloadFile(api, id, opts = {}) {
  const chunk = opts.chunk || 3 * 1024 * 1024;
  const retries = opts.retries ?? 3;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const getPart = async (offset) => {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try { return await api('file', { id, offset, length: chunk }); }
      catch (e) { lastErr = e; if (i < retries - 1) await wait(2000 * (i + 1)); }
    }
    throw lastErr;
  };
  const chunks = [];
  let offset = 0, more = true, first = null;
  while (more) {
    const part = await getPart(offset);
    if (!first) first = part;
    chunks.push(Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0)));
    offset = part.offset + part.length;
    more = !!part.more;
    if (part.length === 0) break;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { bytes.set(c, pos); pos += c.length; }
  return { name: first.name, mime: first.mime, size: first.size, bytes };
}

export function searchDocs(docs, { query = '', categoria, persona, anno, stato, limit = 20 }) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const out = docs.filter((d) => {
    if (categoria && norm(d.categoria) !== norm(categoria)) return false;
    if (persona && !norm(d.soggetti).includes(norm(persona))) return false;
    if (anno && String(d.dataDocumento || '').substring(0, 4) !== String(anno)) return false;
    if (stato && norm(d.stato) !== norm(stato)) return false;
    const hay = haystack(d);
    return terms.every((t) => hay.includes(t));
  });
  out.sort((a, b) => (a.dataDocumento < b.dataDocumento ? 1 : a.dataDocumento > b.dataDocumento ? -1 : 0));
  return { total: out.length, docs: out.slice(0, limit) };
}

const campiSchema = (z) => z.object({
  categoria: z.string().optional(), sottocategoria: z.string().optional(), sottoSottocategoria: z.string().optional(),
  tipoDocumento: z.string().optional(), mittente: z.string().optional(), destinatario: z.string().optional(),
  soggetti: z.string().optional().describe('Persone, separate da virgola'), dataDocumento: z.string().optional().describe('YYYY-MM-DD'),
  titolo: z.string().optional(), riassunto: z.string().optional(), importo: z.string().optional(),
  scadenza: z.string().optional().describe('YYYY-MM-DD'), paroleChiave: z.string().optional()
}).describe('Solo i campi da cambiare');

/**
 * Registra gli strumenti su un McpServer.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {(action:string, payload?:object)=>Promise<any>} api
 * @param {{ z: any, saveFile?: (name:string, buffer:Uint8Array, cartella?:string)=>Promise<string>, indexTtlMs?: number }} opts  (z = libreria zod dell'host, per evitare due copie di zod nel bundle)
 */
export function registerTools(server, api, opts = {}) {
  const z = opts.z;
  if (!z) throw new Error('registerTools: passare la libreria zod in opts.z');
  const CAMPI = campiSchema(z);
  const ttl = opts.indexTtlMs ?? 60 * 1000;
  let cache = { at: 0, data: null };
  const getIndex = async (force = false) => {
    if (!force && cache.data && Date.now() - cache.at < ttl) return cache.data;
    const data = await api('index');
    cache = { at: Date.now(), data };
    return data;
  };
  const text = (t) => ({ content: [{ type: 'text', text: t }] });

  server.tool('cerca_documenti',
    'Cerca nell\'archivio documentale di famiglia (bollette, referti, contratti, lettere...). Ricerca libera su titolo, mittente, persone, riassunto e parole chiave, con filtri opzionali. Restituisce un elenco con gli ID da usare con dettaglio_documento.',
    {
      query: z.string().default('').describe('Parole da cercare (es. "bolletta luce", "referto Serena"). Vuoto = tutti.'),
      categoria: z.string().optional().describe('Filtra per categoria (Salute, Casa, Utenze, Banca-Finanza, Assicurazioni, Auto-Veicoli, Lavoro, Fisco-Tasse, Scuola-Figli, Acquisti-Garanzie, Documenti-Identita, Legale, Viaggi, Altro)'),
      persona: z.string().optional().describe('Filtra per persona a cui si riferisce il documento (es. "Serena")'),
      anno: z.string().optional().describe('Filtra per anno del documento (es. "2026")'),
      stato: z.string().optional().describe('Filtra per stato: Auto, Verificato, Da verificare, Non classificato'),
      limit: z.number().int().min(1).max(100).default(20)
    },
    async (args) => {
      const idx = await getIndex();
      const { total, docs } = searchDocs(idx.docs, args);
      return text(docs.length ? `${total} documenti trovati (mostro ${docs.length}):\n${docs.map(shortLine).join('\n')}` : 'Nessun documento trovato.');
    });

  server.tool('dettaglio_documento',
    'Scheda completa di un documento (metadati, riassunto, parole chiave, link Drive) dato il suo ID.',
    { id: z.string().describe('ID del documento (da cerca_documenti)') },
    async ({ id }) => {
      const idx = await getIndex();
      let d = idx.docs.find((x) => x.id === id);
      if (!d) d = await api('doc', { id });
      if (!d) return { content: [{ type: 'text', text: 'Documento non trovato: ' + id }], isError: true };
      return text(card(d));
    });

  server.tool('documenti_recenti',
    'Gli ultimi documenti arrivati nell\'archivio, in ordine di scansione.',
    { limit: z.number().int().min(1).max(50).default(10) },
    async ({ limit }) => {
      const idx = await getIndex(true);
      const docs = [...idx.docs].sort((a, b) => (a.dataScansione < b.dataScansione ? 1 : -1)).slice(0, limit);
      return text(docs.length ? `Ultimi ${docs.length} documenti (archivio: ${idx.docs.length}):\n${docs.map(shortLine).join('\n')}` : 'Archivio vuoto.');
    });

  server.tool('chiedi_archivio',
    'Fa una domanda in linguaggio naturale all\'assistente dell\'archivio, che cerca tra le schede dei documenti e risponde citando quelli usati. Utile per domande tipo "quando scade l\'assicurazione?" o "quanto abbiamo pagato di luce?".',
    { domanda: z.string().min(2).describe('La domanda, in italiano') },
    async ({ domanda }) => {
      const r = await api('ask', { question: domanda, history: [] });
      const cites = (r.docs || []).map(shortLine).join('\n');
      return text(`${r.answer || 'Nessuna risposta.'}${cites ? '\n\nDocumenti citati:\n' + cites : ''}\n\n(schede consultate: ${r.searched} su ${r.total})`);
    });

  if (opts.saveFile) {
    server.tool('scarica_documento',
      'Scarica il PDF (o l\'immagine) di un documento sul computer e restituisce il percorso del file, così Claude può leggerlo o aprirlo.',
      { id: z.string().describe('ID del documento'), cartella: z.string().optional().describe('Cartella di destinazione (default: ~/Downloads/Archivio)') },
      async ({ id, cartella }) => {
        const f = await downloadFile(api, id);
        const dest = await opts.saveFile(String(f.name || id + '.pdf').replace(/[\/\\:*?"<>|]/g, '_'), f.bytes, cartella);
        return text(`Salvato: ${dest} (${Math.round((f.size || 0) / 1024)} KB, ${f.mime})`);
      });
  } else {
    server.tool('link_documento',
      'Restituisce il link Google Drive per aprire o scaricare un documento (serve un account con accesso alla cartella condivisa).',
      { id: z.string().describe('ID del documento') },
      async ({ id }) => {
        const idx = await getIndex();
        const d = idx.docs.find((x) => x.id === id) || (await api('doc', { id }));
        if (!d) return { content: [{ type: 'text', text: 'Documento non trovato: ' + id }], isError: true };
        return text(`${d.titolo || d.nomeFile}\nApri: https://drive.google.com/file/d/${d.id}/view\nScarica: https://drive.google.com/uc?export=download&id=${d.id}`);
      });
  }

  server.tool('correggi_documento',
    'Corregge i metadati di un documento (categoria, mittente, persone, data, titolo, ecc.). Il file viene rinominato e lo stato diventa "Verificato".',
    { id: z.string(), campi: CAMPI },
    async ({ id, campi }) => {
      const meta = await api('update', { id, fields: campi });
      cache.at = 0;
      return text('Aggiornato.\n\n' + card(meta));
    });
}
