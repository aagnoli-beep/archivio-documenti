#!/usr/bin/env node
/**
 * Copia l'archivio su iCloud Drive scaricando i documenti dal backend (non dipende da Google Drive per desktop).
 *
 * Configurazione: ~/.config/archivio-documenti/config.json  { "apiUrl": "...", "secret": "...", "icloudDir": "..." }
 * (icloudDir è facoltativo: default iCloud Drive/Archivio Documenti)
 *
 * Regole: aggiunge i documenti nuovi, rinomina/rimuove quelli cambiati o spariti dall'Indice (solo dentro "Archivio"),
 * aggiorna Indice.xlsx. In più svuota "Da archiviare": ogni file messo lì viene mandato alla Inbox di Drive
 * (foto HEIC convertite in JPEG) e poi tolto; ricompare in "Archivio" dopo la classificazione.
 * Non tocca mai Google Drive. Log in ~/Library/Logs/archivio-sync.log
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const HOME = os.homedir();
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-sync.log');
const CONFIG = path.join(HOME, '.config', 'archivio-documenti', 'config.json');

async function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}\n`;
  await fs.appendFile(LOG, line);
  process.stdout.write(line);
}

function mimeFor(name) {
  const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase();
  return { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', heic: 'image/heic', heif: 'image/heif' }[ext] || 'application/octet-stream';
}

async function main() {
  let cfg;
  try { cfg = JSON.parse(await fs.readFile(CONFIG, 'utf8')); } catch { await log('SKIP: manca ' + CONFIG); return 0; }
  if (!cfg.apiUrl || !cfg.secret) { await log('SKIP: config incompleta (apiUrl/secret)'); return 0; }
  const dst = cfg.icloudDir || path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Archivio Documenti');
  const archiveDir = path.join(dst, 'Archivio');
  await fs.mkdir(archiveDir, { recursive: true });

  const api = async (action, payload = {}) => {
    const res = await fetch(cfg.apiUrl, { method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, secret: cfg.secret, ...payload }) });
    const json = JSON.parse(await res.text());
    if (!json.ok) throw new Error(json.error || 'errore backend');
    return json.data;
  };

  // --- "Da archiviare": invia alla Inbox di Drive e rimuove dal Mac
  const dropDir = path.join(dst, 'Da archiviare');
  await fs.mkdir(dropDir, { recursive: true });
  let sent = 0, sendFailed = 0;
  for (const name of (await fs.readdir(dropDir)).filter((n) => !n.startsWith('.') && !n.endsWith('.part'))) {
    const full = path.join(dropDir, name);
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (!st.isFile() || st.size === 0 || Date.now() - st.mtimeMs < 60 * 1000) continue;   // ancora in scrittura / sincronizzazione
    if (st.size > 25 * 1024 * 1024) { await log(`AVVISO: "${name}" supera 25 MB, non inviato (riducilo o caricalo su Drive)`); continue; }
    try {
      let uploadPath = full, uploadName = name, mime = mimeFor(name);
      if (/\.hei[cf]$/i.test(name)) {
        uploadPath = path.join(os.tmpdir(), name.replace(/\.hei[cf]$/i, '') + '-' + Date.now() + '.jpg');
        await execFileP('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90', full, '--out', uploadPath]);
        uploadName = name.replace(/\.hei[cf]$/i, '.jpg'); mime = 'image/jpeg';
      }
      const data = (await fs.readFile(uploadPath)).toString('base64');
      await api('upload', { data, name: uploadName, mime });
      await fs.rm(full, { force: true });
      if (uploadPath !== full) await fs.rm(uploadPath, { force: true });
      sent++;
      await log(`INVIATO alla Inbox: ${uploadName}`);
    } catch (e) {
      sendFailed++;
      await log(`AVVISO: "${name}" non inviato (${e.message}); riprovo tra 15 minuti`);
    }
  }

  const index = await api('index');
  const wanted = new Map();
  for (const d of index.docs) if (d.id && d.nomeFile) wanted.set(d.nomeFile, d);

  // Protezione: se l'indice è vuoto o molto più piccolo della copia, non cancellare nulla.
  const existing = (await fs.readdir(archiveDir)).filter((n) => !n.startsWith('.'));
  if (wanted.size === 0) { await log('SKIP: indice vuoto'); return 0; }
  if (existing.length > 20 && wanted.size < existing.length / 2) { await log(`STOP: indice con ${wanted.size} documenti, copia con ${existing.length}: troppo diverso, non cancello`); return 1; }

  let added = 0, removed = 0, failed = 0;
  for (const [name, d] of wanted) {
    const dest = path.join(archiveDir, name);
    try { await fs.access(dest); continue; } catch {}
    try {
      const f = await api('file', { id: d.id });
      await fs.writeFile(dest + '.part', Buffer.from(f.base64, 'base64'));
      await fs.rename(dest + '.part', dest);
      added++;
    } catch (e) {
      failed++;
      await log(`AVVISO: non scaricato "${name}": ${e.message}`);
    }
  }
  for (const name of existing) {
    if (!wanted.has(name)) { await fs.rm(path.join(archiveDir, name), { force: true }); removed++; }
  }

  try {
    const b = await api('backup_xlsx');
    if (b && b.base64) {
      const tmp = path.join(dst, 'Indice.xlsx.part');
      await fs.writeFile(tmp, Buffer.from(b.base64, 'base64'));
      await fs.rename(tmp, path.join(dst, 'Indice.xlsx'));
    }
  } catch (e) { await log('AVVISO: Indice.xlsx non aggiornato: ' + e.message); }

  const now = (await fs.readdir(archiveDir)).filter((n) => !n.startsWith('.')).length;
  await log(`OK: ${now} documenti in iCloud (indice ${wanted.size}; +${added} -${removed}${failed ? ' non scaricati ' + failed : ''}${sent ? '; inviati da "Da archiviare": ' + sent : ''}${sendFailed ? '; non inviati: ' + sendFailed : ''})`);
  return 0;
}

main().then((rc) => process.exit(rc)).catch(async (e) => { await log('ERRORE: ' + (e.stack || e.message)); process.exit(1); });
