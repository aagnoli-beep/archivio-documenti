#!/usr/bin/env node
/**
 * Server MCP "Archivio di casa": permette a Claude (Desktop o Code) di cercare nei documenti
 * di famiglia, leggere le schede, fare domande e scaricare i PDF.
 *
 * Configurazione (variabili d'ambiente):
 *   ARCHIVIO_API_URL  URL /exec del backend Apps Script
 *   ARCHIVIO_SECRET   chiave di famiglia (Script Property MCP_SECRET nel backend)
 *   ARCHIVIO_DOWNLOAD_DIR  cartella dove salvare i PDF scaricati (default ~/Downloads/Archivio)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

function readLocalConfig() {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(os.homedir(), '.config', 'archivio-documenti', 'config.json'), 'utf8')); } catch { return {}; }
}
const LOCAL = readLocalConfig();
const API_URL = process.env.ARCHIVIO_API_URL || LOCAL.apiUrl || '';
const SECRET = process.env.ARCHIVIO_SECRET || LOCAL.secret || '';
const DOWNLOAD_DIR = process.env.ARCHIVIO_DOWNLOAD_DIR || path.join(os.homedir(), 'Downloads', 'Archivio');
const INDEX_TTL_MS = 60 * 1000;

let indexCache = { at: 0, data: null };

async function api(action, payload = {}) {
  if (!API_URL || !SECRET) throw new Error('Server MCP non configurato: mancano ARCHIVIO_API_URL o ARCHIVIO_SECRET');
  const res = await fetch(API_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, secret: SECRET, ...payload })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Risposta non valida dal backend (HTTP ' + res.status + '): ' + text.slice(0, 200)); }
  if (!json.ok) throw new Error(json.error || 'Errore del backend');
  return json.data;
}

async function getIndex(force = false) {
  if (!force && indexCache.data && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.data;
  const data = await api('index');
  indexCache = { at: Date.now(), data };
  return data;
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const fmtDate = (d) => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(d || ''); };

function haystack(d) {
  return norm([d.titolo, d.nomeFile, d.categoria, d.sottocategoria, d.sottoSottocategoria, d.tipoDocumento, d.mittente,
    d.destinatario, d.soggetti, d.riassunto, d.importo, d.dataDocumento, d.scadenza, d.paroleChiave, d.nomeOriginale].join(' | '));
}

function card(d) {
  const lines = [
    `# ${d.titolo || d.nomeFile}`,
    `ID: ${d.id}`,
    `Data documento: ${fmtDate(d.dataDocumento)} · Scansionato: ${d.dataScansione || '-'}`,
    `Categoria: ${[d.categoria, d.sottocategoria, d.sottoSottocategoria].filter(Boolean).join(' › ')}`,
    `Tipo: ${d.tipoDocumento || '-'} · Stato: ${d.stato || '-'} · Confidenza: ${d.confidenza ?? '-'}`,
    `Mittente: ${d.mittente || '-'} → Destinatario: ${d.destinatario || '-'}`,
    `Persone: ${d.soggetti || '-'}`,
  ];
  if (d.importo) lines.push(`Importo: ${d.importo}`);
  if (d.scadenza) lines.push(`Scadenza: ${fmtDate(d.scadenza)}`);
  if (d.riassunto) lines.push(`Riassunto: ${d.riassunto}`);
  if (d.paroleChiave) lines.push(`Parole chiave: ${d.paroleChiave}`);
  lines.push(`File: ${d.nomeFile}`, `Drive: ${d.link || ''}`);
  return lines.join('\n');
}

function shortLine(d) {
  return `- [${d.id}] ${fmtDate(d.dataDocumento)} · ${d.titolo || d.nomeFile} · ${d.categoria}${d.sottocategoria ? ' › ' + d.sottocategoria : ''} · ${d.mittente || '?'} → ${d.soggetti || d.destinatario || '?'}${d.importo ? ' · ' + d.importo : ''}${d.stato && d.stato !== 'Auto' ? ' · ' + d.stato : ''}`;
}

export function searchDocs(docs, { query = '', categoria, persona, anno, stato, limit = 20 }) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  let out = docs.filter((d) => {
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

export function createServer() {
  const server = new McpServer({ name: 'archivio-di-casa', version: '1.0.0' });

  server.tool(
    'cerca_documenti',
    'Cerca nell\'archivio documentale di famiglia (bollette, referti, contratti, lettere...). Ricerca libera sul titolo, mittente, persone, riassunto e parole chiave, con filtri opzionali. Restituisce un elenco con gli ID da usare con dettaglio_documento o scarica_documento.',
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
      const text = docs.length
        ? `${total} documenti trovati (mostro ${docs.length}):\n${docs.map(shortLine).join('\n')}`
        : 'Nessun documento trovato.';
      return { content: [{ type: 'text', text }] };
    }
  );

  server.tool(
    'dettaglio_documento',
    'Scheda completa di un documento (metadati, riassunto, parole chiave, link Drive) dato il suo ID.',
    { id: z.string().describe('ID del documento (da cerca_documenti)') },
    async ({ id }) => {
      const idx = await getIndex();
      let d = idx.docs.find((x) => x.id === id);
      if (!d) d = await api('doc', { id });
      if (!d) return { content: [{ type: 'text', text: 'Documento non trovato: ' + id }], isError: true };
      return { content: [{ type: 'text', text: card(d) }] };
    }
  );

  server.tool(
    'documenti_recenti',
    'Gli ultimi documenti arrivati nell\'archivio, in ordine di scansione.',
    { limit: z.number().int().min(1).max(50).default(10) },
    async ({ limit }) => {
      const idx = await getIndex(true);
      const docs = [...idx.docs].sort((a, b) => (a.dataScansione < b.dataScansione ? 1 : -1)).slice(0, limit);
      return { content: [{ type: 'text', text: docs.length ? `Ultimi ${docs.length} documenti (archivio: ${idx.docs.length}):\n${docs.map(shortLine).join('\n')}` : 'Archivio vuoto.' }] };
    }
  );

  server.tool(
    'chiedi_archivio',
    'Fa una domanda in linguaggio naturale all\'assistente dell\'archivio, che cerca tra le schede dei documenti e risponde citando quelli usati. Utile per domande tipo "quando scade l\'assicurazione?" o "quanto abbiamo pagato di luce?".',
    { domanda: z.string().min(2).describe('La domanda, in italiano') },
    async ({ domanda }) => {
      const r = await api('ask', { question: domanda, history: [] });
      const cites = (r.docs || []).map(shortLine).join('\n');
      return { content: [{ type: 'text', text: `${r.answer || 'Nessuna risposta.'}${cites ? '\n\nDocumenti citati:\n' + cites : ''}\n\n(schede consultate: ${r.searched} su ${r.total})` }] };
    }
  );

  server.tool(
    'scarica_documento',
    'Scarica il PDF (o l\'immagine) di un documento sul Mac e restituisce il percorso del file, così Claude può leggerlo o aprirlo.',
    {
      id: z.string().describe('ID del documento'),
      cartella: z.string().optional().describe('Cartella di destinazione (default: ~/Downloads/Archivio)')
    },
    async ({ id, cartella }) => {
      const f = await api('file', { id });
      const dir = cartella || DOWNLOAD_DIR;
      await fs.mkdir(dir, { recursive: true });
      const safeName = String(f.name || id + '.pdf').replace(/[\/\\:*?"<>|]/g, '_');
      const dest = path.join(dir, safeName);
      await fs.writeFile(dest, Buffer.from(f.base64, 'base64'));
      return { content: [{ type: 'text', text: `Salvato: ${dest} (${Math.round((f.size || 0) / 1024)} KB, ${f.mime})` }] };
    }
  );

  server.tool(
    'correggi_documento',
    'Corregge i metadati di un documento (categoria, mittente, persone, data, titolo, ecc.). Il file viene rinominato e lo stato diventa "Verificato".',
    {
      id: z.string(),
      campi: z.object({
        categoria: z.string().optional(), sottocategoria: z.string().optional(), sottoSottocategoria: z.string().optional(),
        tipoDocumento: z.string().optional(), mittente: z.string().optional(), destinatario: z.string().optional(),
        soggetti: z.string().optional().describe('Persone, separate da virgola'), dataDocumento: z.string().optional().describe('YYYY-MM-DD'),
        titolo: z.string().optional(), riassunto: z.string().optional(), importo: z.string().optional(),
        scadenza: z.string().optional().describe('YYYY-MM-DD'), paroleChiave: z.string().optional()
      }).describe('Solo i campi da cambiare')
    },
    async ({ id, campi }) => {
      const meta = await api('update', { id, fields: campi });
      indexCache.at = 0;
      return { content: [{ type: 'text', text: 'Aggiornato.\n\n' + card(meta) }] };
    }
  );

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
