#!/usr/bin/env node
/**
 * whatsapp-connettore.mjs - prende gli allegati del WhatsApp personale dal connettore già installato.
 *
 * Il connettore (cartella "Whatsapp" sulla Scrivania) è collegato al numero personale, gira per conto
 * suo e tiene un database locale dei messaggi più un servizio su 127.0.0.1 che consegna gli allegati.
 * Qui leggiamo quel database in sola lettura, scarichiamo gli allegati nuovi e li mettiamo nelle
 * cartelle di transito: poi è la raccolta notturna a decidere cosa archiviare.
 *
 * Sostituisce il vecchio servizio con dispositivo collegato (QR, Baileys), che WhatsApp bloccava.
 * Non invia messaggi e non segna niente come letto: legge soltanto.
 *
 * Uso: node whatsapp-connettore.mjs [--giorni N] [--prova] [--verbose]
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const BASE = path.join(HOME, '.config', 'archivio-documenti');
const INBOX = path.join(BASE, 'whatsapp-inbox');
const DIRETTI = path.join(BASE, 'whatsapp-diretti');
const STATO = path.join(BASE, 'whatsapp-connettore-state.json');
const CONFIG = path.join(BASE, 'config.json');
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const PROVA = args.includes('--prova');
const VERBOSE = args.includes('--verbose');
const num = (nome, def) => { const i = args.indexOf(nome); return i >= 0 ? parseInt(args[i + 1], 10) || def : def; };
const GIORNI = num('--giorni', 7);

const MIN_BYTE = 15 * 1024, MIN_BYTE_DIRETTO = 5 * 1024, MAX_BYTE = 25 * 1024 * 1024;
const MIME_BUONI = /^(application\/pdf|image\/(jpeg|png|heic|heif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))/;
const EST = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heic',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx' };

async function log(msg) {
  const riga = `${new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)} [whatsapp] ${msg}\n`;
  await fs.mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, riga).catch(() => {});
  if (VERBOSE || !process.env.HARVEST_QUIET) process.stdout.write(riga);
}

const pulisci = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 55);

async function sql(db, query) {
  // sola lettura: il connettore sta scrivendo sullo stesso file
  const { stdout } = await execFileP('sqlite3', ['-json', '-readonly', db, query], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function chiamaBackend(azione, dati) {
  try {
    const cfg = JSON.parse(fsSync.readFileSync(CONFIG, 'utf8'));
    if (!cfg.apiUrl || !cfg.secret) return null;
    const { callBackend } = await import(path.join(REPO, 'mcp', 'tools.mjs'));
    return await callBackend(cfg.apiUrl, cfg.secret, azione, dati, { retries: 4 });
  } catch (e) { await log('AVVISO: backend non raggiunto (' + String(e.message).slice(0, 60) + ')'); return null; }
}

async function main() {
  const cfg = (() => { try { return JSON.parse(fsSync.readFileSync(CONFIG, 'utf8')); } catch { return {}; } })();
  const h = cfg.harvest || {};
  const cartella = h.connettoreWhatsApp || path.join(HOME, 'Desktop', 'Claude Code Progetti', 'Whatsapp', 'data', 'personale');
  const db = path.join(cartella, 'whatsapp.db');
  const porta = h.portaConnettore || 3791;
  if (!fsSync.existsSync(db)) { await log('SALTO: database del connettore non trovato in ' + cartella); return; }
  let token = '';
  try { token = fsSync.readFileSync(path.join(cartella, 'token.txt'), 'utf8').trim(); } catch { /* senza token il servizio rifiuta */ }
  if (!token) { await log('SALTO: manca il token del connettore'); return; }

  await fs.mkdir(INBOX, { recursive: true });
  await fs.mkdir(DIRETTI, { recursive: true });
  let stato = { visti: {} };
  try { stato = JSON.parse(fsSync.readFileSync(STATO, 'utf8')); } catch { /* primo giro */ }
  stato.visti = stato.visti || {};

  const gruppiDiretti = (h.gruppiArchivio || ['Documenti']).map((x) => String(x).trim().toLowerCase());
  const mioNumero = (h.numeroPersonale || '393475510940').replace(/\D/g, '');
  const da = Math.floor(Date.now() / 1000) - GIORNI * 24 * 3600;

  const righe = await sql(db, `
    SELECT m.id, m.chat_jid, m.from_me, m.ts, m.media_type, m.mime, m.file_name, m.file_size,
           coalesce(c.name, '') AS chat_nome, coalesce(m.sender_name, '') AS mittente
    FROM messages m LEFT JOIN chats c ON c.jid = m.chat_jid
    WHERE m.media_type IN ('documento','immagine') AND m.ts > ${da}
    ORDER BY m.ts ASC`);
  await log(`connettore: ${righe.length} allegati negli ultimi ${GIORNI} giorni`);

  let presi = 0, saltati = 0;
  for (const r of righe) {
    const chiave = r.chat_jid + '|' + r.id;
    if (stato.visti[chiave]) continue;
    const nomeChat = r.chat_nome || r.mittente || String(r.chat_jid).split('@')[0];
    const diretto = gruppiDiretti.includes(String(r.chat_nome || '').trim().toLowerCase())
      || String(r.chat_jid).startsWith(mioNumero);
    if (r.from_me && !diretto) { stato.visti[chiave] = 'inviato da me'; continue; }
    const mime = String(r.mime || '').split(';')[0];
    if (!MIME_BUONI.test(mime)) { stato.visti[chiave] = 'tipo scartato'; continue; }
    const minimo = diretto ? MIN_BYTE_DIRETTO : MIN_BYTE;
    if (!r.file_size || r.file_size < minimo || r.file_size > MAX_BYTE) { stato.visti[chiave] = 'dimensione fuori limite'; saltati++; continue; }

    const base = pulisci((r.file_name || 'allegato').replace(/\.[^.]*$/, '')) || 'allegato';
    const quando = new Date(r.ts * 1000).toISOString().slice(0, 10);
    const dest = path.join(diretto ? DIRETTI : INBOX, `${pulisci(nomeChat)}__${quando}__${base}${EST[mime] || ''}`);
    if (PROVA) { await log(`[prova] prenderei da "${nomeChat}"${diretto ? ' [corsia diretta]' : ''}: ${path.basename(dest)}`); presi++; continue; }
    try {
      const url = `http://127.0.0.1:${porta}/file/${encodeURIComponent(r.chat_jid)}/${encodeURIComponent(r.id)}?token=${token}`;
      const risposta = await fetch(url);
      if (!risposta.ok) throw new Error('HTTP ' + risposta.status);
      const dati = Buffer.from(await risposta.arrayBuffer());
      if (dati.length < minimo) throw new Error('file vuoto o troppo piccolo');
      await fs.writeFile(dest, dati);
      stato.visti[chiave] = 'preso';
      presi++;
      await log(`preso da "${nomeChat}"${diretto ? ' [da archiviare subito]' : ''}: ${path.basename(dest)} (${Math.round(dati.length / 1024)} KB)`);
    } catch (e) {
      await log(`AVVISO: allegato di "${nomeChat}" non scaricato (${String(e.message).slice(0, 60)}); riprovo domani`);
    }
  }

  if (!PROVA) {
    await fs.writeFile(STATO, JSON.stringify(stato));
    await chiamaBackend('heartbeat', { nome: 'whatsapp', dettaglio: `${presi} allegati presi dal connettore` });
  }
  await log(`FINE WhatsApp: ${presi} allegati nuovi${saltati ? ', ' + saltati + ' saltati per dimensione' : ''}`);
}

main().catch(async (e) => { await log('ERRORE: ' + e.message); process.exitCode = 1; });
