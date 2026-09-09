#!/usr/bin/env node
/**
 * Copia l'archivio su iCloud Drive scaricando i documenti dal backend (non dipende da Google Drive per desktop).
 *
 * Configurazione: ~/.config/archivio-documenti/config.json  { "apiUrl": "...", "secret": "...", "icloudDir": "..." }
 * (icloudDir è facoltativo: default iCloud Drive/Archivio Documenti)
 *
 * Regole: aggiunge i documenti nuovi, rinomina/rimuove quelli cambiati o spariti dall'Indice (solo dentro "Archivio"),
 * aggiorna Indice.xlsx. Non tocca mai Google Drive. Log in ~/Library/Logs/archivio-sync.log
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-sync.log');
const CONFIG = path.join(HOME, '.config', 'archivio-documenti', 'config.json');

async function log(msg) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${msg}\n`;
  await fs.appendFile(LOG, line);
  process.stdout.write(line);
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
  await log(`OK: ${now} documenti in iCloud (indice ${wanted.size}; +${added} -${removed}${failed ? ' non scaricati ' + failed : ''})`);
  return 0;
}

main().then((rc) => process.exit(rc)).catch(async (e) => { await log('ERRORE: ' + (e.stack || e.message)); process.exit(1); });
