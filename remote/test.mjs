// Test end-to-end del connettore remoto: registrazione client OAuth, accesso con la chiave di famiglia,
// scambio del codice, chiamate MCP. Uso: REMOTE_URL=https://... node test.mjs   (la chiave è letta dalla config locale)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import crypto from 'node:crypto';

const BASE = (process.env.REMOTE_URL || '').replace(/\/$/, '');
if (!BASE) { console.error('Imposta REMOTE_URL'); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'archivio-documenti', 'config.json'), 'utf8'));
let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('  ✔ ' + name); } catch (e) { console.log('  ✘ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; } };

let meta, client, code, token;
await t('metadata OAuth pubblicati (/.well-known/oauth-authorization-server)', async () => {
  const r = await fetch(BASE + '/.well-known/oauth-authorization-server'); assert.strictEqual(r.status, 200);
  meta = await r.json(); assert.ok(meta.authorization_endpoint.endsWith('/authorize') && meta.token_endpoint.endsWith('/token') && meta.registration_endpoint.endsWith('/register'));
});
await t('/mcp senza token -> 401', async () => { const r = await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.strictEqual(r.status, 401); });
await t('registrazione dinamica del client (come fa claude.ai)', async () => {
  const r = await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Test Claude', redirect_uris: ['https://example.com/cb'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.strictEqual(r.status, 201); client = await r.json(); assert.ok(client.client_id);
});
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const authUrl = `${meta.authorization_endpoint}?response_type=code&client_id=${encodeURIComponent(client?.client_id)}&redirect_uri=${encodeURIComponent('https://example.com/cb')}&state=xyz&code_challenge=${challenge}&code_challenge_method=S256`;
let stateField;
await t('pagina di accesso con nome del client', async () => {
  const r = await fetch(authUrl); assert.strictEqual(r.status, 200); const html = await r.text();
  assert.ok(html.includes('Chiave di famiglia') && html.includes('Test Claude'));
  stateField = html.match(/name="state" value="([^"]+)"/)[1];
});
await t('chiave sbagliata -> rifiuto (401) e nessun codice', async () => {
  const r = await fetch(BASE + '/authorize', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ state: stateField, name: 'Test', secret: 'chiave-sbagliata-molto-lunga-123' }) });
  assert.strictEqual(r.status, 401); assert.ok((await r.text()).includes('non valida'));
});
await t('chiave giusta -> redirect al client con il codice', async () => {
  const r = await fetch(BASE + '/authorize', { method: 'POST', redirect: 'manual', body: new URLSearchParams({ state: stateField, name: 'Test', secret: cfg.secret }) });
  assert.strictEqual(r.status, 302); const loc = new URL(r.headers.get('location')); assert.ok(loc.href.startsWith('https://example.com/cb'));
  assert.strictEqual(loc.searchParams.get('state'), 'xyz'); code = loc.searchParams.get('code'); assert.ok(code);
});
await t('scambio codice -> token', async () => {
  const r = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://example.com/cb', client_id: client.client_id, code_verifier: verifier }) });
  assert.strictEqual(r.status, 200); const j = await r.json(); token = j.access_token; assert.ok(token && j.refresh_token);
});
let sessionId = null;
const mcp = async (method, params, id = 1) => {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const r = await fetch(BASE + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (r.headers.get('mcp-session-id')) sessionId = r.headers.get('mcp-session-id');
  const ct = r.headers.get('content-type') || ''; const body = await r.text();
  if (r.status >= 400) return { status: r.status, json: { error: { message: body.slice(0, 200) } } };
  if (ct.includes('text/event-stream')) { const line = body.split('\n').filter((l) => l.startsWith('data:')).pop(); return { status: r.status, json: JSON.parse(line.slice(5)) }; }
  return { status: r.status, json: body ? JSON.parse(body) : null };
};
await t('MCP initialize con token', async () => { const r = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } }); assert.strictEqual(r.status, 200); assert.strictEqual(r.json.result.serverInfo.name, 'archivio-di-casa'); });
await fetch(BASE + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + token, 'Mcp-Session-Id': sessionId || '' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
await t('tools/list elenca gli strumenti', async () => { const r = await mcp('tools/list', {}, 2); assert.ok(r.json.result, JSON.stringify(r.json).slice(0, 300)); const names = r.json.result.tools.map((x) => x.name).sort(); assert.deepStrictEqual(names, ['cerca_documenti', 'chiedi_archivio', 'correggi_documento', 'dettaglio_documento', 'documenti_recenti', 'link_documento']); });
await t('cerca_documenti "pompa" trova il documento vero', async () => { const r = await mcp('tools/call', { name: 'cerca_documenti', arguments: { query: 'pompa' } }, 3); const txt = r.json.result.content[0].text; assert.ok(txt.includes('pompa di calore'), txt); });
await t('documenti_recenti risponde', async () => { const r = await mcp('tools/call', { name: 'documenti_recenti', arguments: { limit: 2 } }, 4); assert.ok(r.json.result.content[0].text.includes('Ultimi 2 documenti')); });
console.log(`\n${passed} test remoti superati${process.exitCode ? ', CI SONO FALLIMENTI' : ''}`);
