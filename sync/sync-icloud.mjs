#!/usr/bin/env node
/**
 * Copia l'archivio su iCloud Drive scaricando i documenti dal backend (non dipende da Google Drive per desktop).
 *
 * Configurazione: ~/.config/archivio-documenti/config.json  { "apiUrl": "...", "secret": "...", "icloudDir": "..." }
 * (icloudDir è facoltativo: default iCloud Drive/Archivio Documenti)
 *
 * Regole: aggiunge i documenti nuovi, rinomina/rimuove quelli cambiati o spariti dall'Indice (solo dentro "Archivio"),
 * aggiorna Indice.xlsx. In più: qualunque file messo dalla famiglia dentro "Archivio" (nome diverso da quelli
 * scritti dallo script, tracciati in .archivio-sync.json) viene mandato alla Inbox di Drive (foto HEIC convertite in JPEG)
 * e tolto; ricompare in "Archivio" col nome giusto dopo la classificazione.
 * Non tocca mai Google Drive. Log in ~/Library/Logs/archivio-sync.log
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { downloadFile, callBackend } from '../mcp/tools.mjs';
const execFileP = promisify(execFile);

const HOME = os.homedir();
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-sync.log');
const CONFIG = path.join(HOME, '.config', 'archivio-documenti', 'config.json');

async function log(msg) {
  const d = new Date(); const pad = (n) => String(n).padStart(2, '0');
  const line = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${msg}\n`;
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

  const api = (action, payload = {}) => callBackend(cfg.apiUrl, cfg.secret, action, payload);

  const index = await api('index');
  const wanted = new Map();
  for (const d of index.docs) if (d.id && d.nomeFile) wanted.set(d.nomeFile, d);

  // Stato: nomi dei file scritti dallo script (per distinguere i documenti archiviati dai file aggiunti dalla famiglia).
  const statePath = path.join(dst, '.archivio-sync.json');
  let state = { written: {} };
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); } catch {}
  const written = new Set(Object.keys(state.written || {}));
  const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}_[^_]+_[^_]+_[^_]+_[^_]+_.+\.[A-Za-z0-9]+$/;

  // Protezione: se l'indice è vuoto o molto più piccolo della copia, non cancellare nulla.
  const existing = (await fs.readdir(archiveDir)).filter((n) => !n.startsWith('.') && !n.endsWith('.part'));
  if (wanted.size === 0) { await log('SKIP: indice vuoto'); return 0; }
  if (existing.length > 20 && wanted.size < existing.length / 2) { await log(`STOP: indice con ${wanted.size} documenti, copia con ${existing.length}: troppo diverso, non cancello`); return 1; }

  // 1) File aggiunti dalla famiglia dentro "Archivio": vanno alla Inbox di Drive, poi vengono tolti.
  let sent = 0, sendFailed = 0, removed = 0;
  for (const name of existing) {
    if (wanted.has(name)) continue;
    const full = path.join(archiveDir, name);
    const isOurs = written.has(name) || (written.size === 0 && ARCHIVE_NAME.test(name));   // prima esecuzione: i nomi col pattern sono nostri
    if (isOurs) { await fs.rm(full, { force: true }); removed++; continue; }                 // documento rinominato/rimosso dall'indice
    let st;
    try { st = await fs.stat(full); } catch { continue; }
    if (!st.isFile() || st.size === 0 || Date.now() - st.mtimeMs < 60 * 1000) continue;     // ancora in scrittura / sincronizzazione
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
      await log(`INVIATO alla Inbox di Drive: ${uploadName} (ricomparirà classificato)`);
    } catch (e) {
      sendFailed++;
      await log(`AVVISO: "${name}" non inviato (${e.message}); riprovo tra 15 minuti`);
    }
  }

  // 2) Documenti dell'indice mancanti in iCloud: scaricati dal backend.
  let added = 0, failed = 0;
  for (const [name, d] of wanted) {
    const dest = path.join(archiveDir, name);
    try { await fs.access(dest); written.add(name); continue; } catch {}
    try {
      const f = await downloadFile(api, d.id);
      await fs.writeFile(dest + '.part', f.bytes);
      await fs.rename(dest + '.part', dest);
      written.add(name);
      added++;
    } catch (e) {
      failed++;
      await log(`AVVISO: non scaricato "${name}": ${e.message}`);
    }
  }
  for (const name of Array.from(written)) if (!wanted.has(name)) written.delete(name);
  await fs.writeFile(statePath, JSON.stringify({ written: Object.fromEntries(Array.from(written).map((n) => [n, wanted.get(n)?.id || true])) }, null, 0));

  try {
    const b = await api('backup_xlsx');
    if (b && b.base64) {
      const tmp = path.join(dst, 'Indice.xlsx.part');
      await fs.writeFile(tmp, Buffer.from(b.base64, 'base64'));
      await fs.rename(tmp, path.join(dst, 'Indice.xlsx'));
    }
  } catch (e) { await log('AVVISO: Indice.xlsx non aggiornato: ' + e.message); }

  const now = (await fs.readdir(archiveDir)).filter((n) => !n.startsWith('.')).length;
  await log(`OK: ${now} documenti in iCloud (indice ${wanted.size}; +${added} -${removed}${failed ? ' non scaricati ' + failed : ''}${sent ? '; inviati a Drive: ' + sent : ''}${sendFailed ? '; non inviati: ' + sendFailed : ''})`);
  return 0;
}

main().then((rc) => process.exit(rc)).catch(async (e) => { await log('ERRORE: ' + (e.stack || e.message)); process.exit(1); });
