/**
 * Connettore MCP remoto "Archivio di casa" (Cloudflare Worker).
 *
 * - /mcp (Streamable HTTP) e /sse: endpoint MCP protetti da OAuth 2.1 (registrazione dinamica dei client:
 *   claude.ai si registra da solo).
 * - /authorize: pagina di accesso dove la famiglia inserisce la chiave di famiglia. La chiave viene
 *   verificata dal backend Apps Script e conservata SOLO cifrata dentro il token del client
 *   (props), mai in chiaro sul Worker.
 * - Ogni chiamata agli strumenti usa la chiave dell'utente per parlare col backend.
 */
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTools } from '../../mcp/tools.mjs';

async function callBackend(apiUrl, secret, action, payload = {}) {
  const res = await fetch(apiUrl, {
    method: 'POST', redirect: 'follow',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, secret, ...payload })
  });
  const txt = await res.text();
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error('Risposta non valida dal backend (HTTP ' + res.status + ')'); }
  if (!json.ok) throw new Error(json.error || 'Errore del backend');
  return json.data;
}

export class ArchivioMCP extends McpAgent {
  server = new McpServer({ name: 'archivio-di-casa', version: '1.1.0' });

  async init() {
    const apiUrl = this.env.ARCHIVIO_API_URL;
    const secret = this.props?.secret;
    registerTools(this.server, (action, payload) => callBackend(apiUrl, secret, action, payload), { z, indexTtlMs: 30 * 1000 });
  }
}

// ---------- pagine HTML ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, body) => `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f4ef;--surface:#fff;--text:#1e1d1a;--muted:#6d6a63;--line:#e4e0d6;--accent:#2f6fed}
@media(prefers-color-scheme:dark){:root{--bg:#141412;--surface:#1e1e1b;--text:#ecebe6;--muted:#a3a199;--line:#34332e;--accent:#6d9bff}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:22px;padding:34px 28px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.08)}
h1{font-size:24px;margin:8px 0 6px;letter-spacing:-.02em}p{color:var(--muted);margin:0 0 18px}label{display:block;text-align:left;font-size:13px;color:var(--muted);margin:12px 0 4px}
input{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface);color:var(--text)}
button{margin-top:18px;width:100%;font:inherit;font-weight:600;padding:12px;border:0;border-radius:11px;background:var(--accent);color:#fff;cursor:pointer}
.err{background:#fde3df;color:#8a1f14;padding:10px 12px;border-radius:10px;margin-bottom:10px}.small{font-size:12px}
</style></head><body><div class="card">${body}</div></body></html>`;

const logo = '<svg viewBox="0 0 64 64" width="52" height="52"><rect width="64" height="64" rx="14" fill="#2f6fed"/><path d="M16 20h14l4 4h14v22H16z" fill="#fff"/></svg>';

function loginPage(oauthReqInfo, clientName, error) {
  const state = btoa(JSON.stringify(oauthReqInfo));
  return page('Archivio di casa · accesso', `${logo}<h1>Archivio di casa</h1>
<p>${esc(clientName || 'Un\'app')} chiede di accedere ai documenti di famiglia.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="POST" action="/authorize">
<input type="hidden" name="state" value="${esc(state)}">
<label>Il tuo nome</label><input name="name" required maxlength="60" placeholder="Es. Andrea" autocomplete="name">
<label>Chiave di famiglia</label><input name="secret" type="password" required minlength="16" autocomplete="current-password">
<button type="submit">Collega</button>
</form>
<p class="small" style="margin-top:14px">La chiave viene verificata dal backend e non viene salvata in chiaro.</p>`);
}

const homePage = page('Archivio di casa · connettore MCP', `${logo}<h1>Archivio di casa</h1>
<p>Connettore MCP dell'archivio documentale di famiglia.</p>
<p class="small">In claude.ai: Impostazioni → Connettori → Aggiungi connettore personalizzato → incolla <code>${'{origin}'}/mcp</code>. Al primo uso ti verrà chiesta la chiave di famiglia.</p>`);

async function handleDefault(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/authorize' && request.method === 'GET') {
    const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    if (!oauthReqInfo.clientId) return new Response('Richiesta non valida', { status: 400 });
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    return new Response(loginPage(oauthReqInfo, client?.clientName), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname === '/authorize' && request.method === 'POST') {
    const form = await request.formData();
    let oauthReqInfo;
    try { oauthReqInfo = JSON.parse(atob(String(form.get('state') || ''))); } catch { return new Response('Stato non valido', { status: 400 }); }
    const name = String(form.get('name') || '').trim().slice(0, 60);
    const secret = String(form.get('secret') || '').trim();
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
    if (!name || secret.length < 16) return new Response(loginPage(oauthReqInfo, client?.clientName, 'Inserisci nome e chiave di famiglia.'), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    try {
      await callBackend(env.ARCHIVIO_API_URL, secret, 'me');
    } catch (e) {
      return new Response(loginPage(oauthReqInfo, client?.clientName, 'Chiave di famiglia non valida.'), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: name.toLowerCase(),
      metadata: { label: name },
      scope: oauthReqInfo.scope,
      props: { name, secret }
    });
    return Response.redirect(redirectTo, 302);
  }
  if (url.pathname === '/' || url.pathname === '') {
    return new Response(homePage.replace('{origin}', esc(url.origin)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return new Response('Not found', { status: 404 });
}

export default new OAuthProvider({
  apiHandlers: {
    '/mcp': ArchivioMCP.serve('/mcp'),
    '/sse': ArchivioMCP.serveSSE('/sse')
  },
  defaultHandler: { fetch: handleDefault },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register'
});
