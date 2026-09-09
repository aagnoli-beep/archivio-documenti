// Test del server MCP contro un backend finto: avvia un mini server HTTP, poi parla col server via stdio come farebbe Claude.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const docs = [
  { id: 'a1', nomeFile: '2026-08-30_Utenze_Luce_Enel_Serena_Bolletta.pdf', titolo: 'Bolletta luce luglio', categoria: 'Utenze', sottocategoria: 'Luce', mittente: 'Enel Energia', destinatario: 'Serena', soggetti: 'Serena', dataDocumento: '2026-08-30', dataScansione: '2026-09-08 23:30', importo: '87,40 EUR', scadenza: '2026-09-20', stato: 'Auto', confidenza: 0.92, riassunto: 'Bolletta luce di luglio.', paroleChiave: 'luce, enel', link: 'https://drive.google.com/file/d/a1/view' },
  { id: 'b2', nomeFile: '2026-03-12_Salute_Visita_Rossi_Andrea_Referto.pdf', titolo: 'Referto cardiologia', categoria: 'Salute', sottocategoria: 'Visita specialistica', mittente: 'Dott. Rossi', destinatario: 'Andrea Agnoli', soggetti: 'Andrea Agnoli', dataDocumento: '2026-03-12', dataScansione: '2026-09-09 00:10', stato: 'Verificato', confidenza: 0.9, riassunto: 'ECG nella norma.', link: '' }
];
const calls = [];
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
    const b = JSON.parse(body); calls.push(b);
    const reply = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (b.secret !== 'segreto-di-test-abcdefghijklmnop') return reply({ ok: false, code: 'forbidden', error: 'Chiave di famiglia non valida' });
    const user = { email: 'andrea@example.com', name: 'Claude (MCP)', canEdit: true };
    switch (b.action) {
      case 'index': return reply({ ok: true, user, data: { docs, categories: { Utenze: ['Luce'], Salute: ['Visita specialistica'] }, family: ['Andrea Agnoli', 'Serena'] } });
      case 'doc': return reply({ ok: true, user, data: docs.find((d) => d.id === b.id) || null });
      case 'ask': return reply({ ok: true, user, data: { answer: 'La bolletta scade il 2026-09-20.', docs: [docs[0]], searched: 2, total: 2 } });
      case 'file': { const full = Buffer.from('%PDF'); const off = b.offset || 0; const part = full.subarray(off, off + 2); return reply({ ok: true, user, data: { name: 'Bolletta.pdf', mime: 'application/pdf', size: full.length, offset: off, length: part.length, more: off + part.length < full.length, base64: part.toString('base64') } }); }
      case 'update': { const d = { ...docs[1], ...b.fields, stato: 'Verificato' }; return reply({ ok: true, user, data: d }); }
      default: return reply({ ok: false, code: 'bad_request', error: 'azione sconosciuta' });
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${server.address().port}/exec`;
const dlDir = await fs.mkdtemp(path.join(os.tmpdir(), 'archivio-mcp-'));

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs')], env: { ...process.env, ARCHIVIO_API_URL: apiUrl, ARCHIVIO_SECRET: 'segreto-di-test-abcdefghijklmnop', ARCHIVIO_DOWNLOAD_DIR: dlDir } });
const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(transport);
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ✔ ' + name); } catch (e) { console.log('  ✘ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; } };
const text = (r) => r.content.map((c) => c.text).join('\n');

await t('elenca 6 strumenti', async () => { const { tools } = await client.listTools(); assert.deepStrictEqual(tools.map((x) => x.name).sort(), ['cerca_documenti', 'chiedi_archivio', 'correggi_documento', 'dettaglio_documento', 'documenti_recenti', 'scarica_documento']); });
await t('cerca "enel" trova la bolletta (senza accenti, insensibile alle maiuscole)', async () => { const r = text(await client.callTool({ name: 'cerca_documenti', arguments: { query: 'ENEL bollétta' } })); assert.ok(r.includes('1 documenti trovati')); assert.ok(r.includes('[a1]')); });
await t('filtro persona + categoria', async () => { const r = text(await client.callTool({ name: 'cerca_documenti', arguments: { query: '', persona: 'andrea', categoria: 'salute' } })); assert.ok(r.includes('[b2]') && !r.includes('[a1]')); });
await t('nessun risultato', async () => { const r = text(await client.callTool({ name: 'cerca_documenti', arguments: { query: 'zzz' } })); assert.ok(r.includes('Nessun documento')); });
await t('dettaglio con tutti i campi', async () => { const r = text(await client.callTool({ name: 'dettaglio_documento', arguments: { id: 'a1' } })); assert.ok(r.includes('# Bolletta luce luglio') && r.includes('Importo: 87,40 EUR') && r.includes('Scadenza: 20/09/2026') && r.includes('Parole chiave: luce, enel')); });
await t('documenti recenti ordinati per scansione', async () => { const r = text(await client.callTool({ name: 'documenti_recenti', arguments: { limit: 1 } })); assert.ok(r.includes('[b2]') && !r.includes('[a1]')); });
await t('chiedi_archivio riporta risposta e documenti citati', async () => { const r = text(await client.callTool({ name: 'chiedi_archivio', arguments: { domanda: 'Quando scade la bolletta?' } })); assert.ok(r.includes('2026-09-20') && r.includes('Documenti citati') && r.includes('[a1]')); });
await t('scarica_documento salva il file', async () => { const r = text(await client.callTool({ name: 'scarica_documento', arguments: { id: 'a1' } })); const p = r.match(/Salvato: (.+?\.pdf)/)[1]; assert.strictEqual((await fs.readFile(p)).toString(), '%PDF'); });
await t('correggi_documento manda solo i campi indicati', async () => { const r = text(await client.callTool({ name: 'correggi_documento', arguments: { id: 'b2', campi: { titolo: 'Referto cardiologico' } } })); assert.ok(r.includes('Aggiornato') && r.includes('# Referto cardiologico')); const u = calls.filter((c) => c.action === 'update')[0]; assert.deepStrictEqual(u.fields, { titolo: 'Referto cardiologico' }); });
await t('la chiave viene inviata in ogni chiamata, mai nell\'URL', async () => { assert.ok(calls.every((c) => c.secret === 'segreto-di-test-abcdefghijklmnop')); assert.ok(!apiUrl.includes('segreto')); });

await client.close(); server.close();
console.log(`\n${passed} test MCP superati${process.exitCode ? ', CI SONO FALLIMENTI' : ''}`);
