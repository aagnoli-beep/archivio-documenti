#!/usr/bin/env node
/**
 * whatsapp-web.mjs - prende da WhatsApp Web i documenti ricevuti nelle chat personali.
 *
 * Sul Mac l'app WhatsApp installata è quella Business (lavoro) e non va toccata: il numero personale
 * vive su WhatsApp Web, in un profilo Chrome dedicato (~/.config/archivio-documenti/whatsapp-profile)
 * collegato una volta sola col QR:
 *
 *     node harvest/whatsapp-web.mjs --login
 *
 * A ogni giro apre WhatsApp Web senza finestra, apre le chat più recenti e salva gli allegati
 * ricevuti (foto e documenti) in ~/.config/archivio-documenti/whatsapp-inbox. Da lì li prende la
 * raccolta notturna, che decide quali archiviare. Legge soltanto: non invia messaggi, non scrive
 * nelle chat; apre le conversazioni come farebbe una lettura dal browser.
 * Se la sessione scade manda un'email di avviso e il resto della raccolta prosegue.
 *
 * Uso: node whatsapp-web.mjs [--login] [--chats N] [--messages N] [--verbose] [--headed]
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HOME = os.homedir();
const BASE = path.join(HOME, '.config', 'archivio-documenti');
const PROFILO = path.join(BASE, 'whatsapp-profile');
const INBOX = path.join(BASE, 'whatsapp-inbox');
const STATO = path.join(BASE, 'whatsapp-state.json');
const CONFIG = path.join(BASE, 'config.json');
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const LOGIN = args.includes('--login');
const HEADED = args.includes('--headed') || LOGIN;
const VERBOSE = args.includes('--verbose') || LOGIN;
const num = (nome, def) => { const i = args.indexOf(nome); return i >= 0 ? parseInt(args[i + 1], 10) || def : def; };
const MAX_CHAT = num('--chats', 15);
const MAX_MESSAGGI = num('--messages', 30);
const MIN_BYTE = 20 * 1024;
const MAX_BYTE = 25 * 1024 * 1024;

async function log(msg) {
  const riga = `${new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)} [whatsapp] ${msg}\n`;
  await fs.mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, riga).catch(() => {});
  if (VERBOSE || !process.env.HARVEST_QUIET) process.stdout.write(riga);
}

const pulisci = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
const NOME_DOC = /([\w \-.()]+\.(pdf|docx?|xlsx?|pptx?|csv))\b/i;

async function avvisaPerEmail(chiave, oggetto, testo) {
  try {
    const cfg = JSON.parse(fsSync.readFileSync(CONFIG, 'utf8'));
    if (!cfg.apiUrl || !cfg.secret) return;
    const { callBackend } = await import(path.join(REPO, 'mcp', 'tools.mjs'));
    await callBackend(cfg.apiUrl, cfg.secret, 'avviso', { chiave, oggetto, testo }, { retries: 2 });
  } catch (e) { await log('AVVISO: email non inviata (' + String(e.message).slice(0, 60) + ')'); }
}

async function main() {
  await fs.mkdir(INBOX, { recursive: true });
  await fs.mkdir(PROFILO, { recursive: true });
  let stato = { presi: {} };
  try { stato = JSON.parse(fsSync.readFileSync(STATO, 'utf8')); } catch { /* primo giro */ }
  stato.presi = stato.presi || {};

  const ctx = await chromium.launchPersistentContext(PROFILO, {
    channel: 'chrome', headless: !HEADED, viewport: { width: 1280, height: 900 },
    acceptDownloads: true, args: ['--disable-blink-features=AutomationControlled']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let salvati = 0;
  try {
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const collegato = await page.waitForSelector('#pane-side', { timeout: LOGIN ? 300000 : 90000 }).then(() => true).catch(() => false);
    if (!collegato) {
      await log('SESSIONE DA COLLEGARE: la sessione di WhatsApp Web è scaduta');
      await avvisaPerEmail('whatsapp', 'WhatsApp Web da ricollegare',
        'La raccolta notturna non riesce più a leggere WhatsApp Web: la sessione è scaduta.\n\n' +
        'Sul Mac apri il Terminale ed esegui:\n  node "' + path.join(REPO, 'harvest', 'whatsapp-web.mjs') + '" --login\n' +
        'Compare una finestra con il codice QR: inquadralo con WhatsApp del telefono personale.\n' +
        'Il resto della raccolta continua a funzionare lo stesso.');
      process.exitCode = 2;
      return;
    }
    if (LOGIN) { await log('sessione collegata: da ora i giri notturni funzionano da soli'); return; }

    // WhatsApp mostra ogni tanto una finestra "Novità": va chiusa o copre l'elenco delle chat.
    for (const etichetta of ['Continua', 'Ho capito', 'OK', 'Chiudi']) {
      const b = page.getByRole('button', { name: etichetta, exact: false }).first();
      if (await b.count().catch(() => 0)) { await b.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(800); }
    }

    const righe = await page.locator('#pane-side [role="row"]').all();
    await log(`chat in elenco: ${righe.length}, ne guardo al massimo ${MAX_CHAT}`);

    for (const riga of righe.slice(0, MAX_CHAT)) {
      let nomeChat = 'chat';
      try { nomeChat = pulisci(await riga.locator('span[title]').first().getAttribute('title')) || 'chat'; } catch { /* senza nome */ }
      try { await riga.click({ timeout: 12000 }); } catch { continue; }
      await page.waitForTimeout(1800);

      const bolle = await page.locator('[data-id]').all();
      for (const bolla of bolle.slice(-MAX_MESSAGGI)) {
        let id = '';
        try { id = (await bolla.getAttribute('data-id')) || ''; } catch { continue; }
        if (!id || stato.presi[id]) continue;
        // Ricevuto o inviato: lo dice la codina della bolla; se manca, guardo da che parte sta.
        const inviatoDaMe = await bolla.evaluate((el) => {
          if (el.querySelector('span[data-icon="tail-in"]')) return false;
          if (el.querySelector('span[data-icon="tail-out"]')) return true;
          const r = el.getBoundingClientRect();
          const cont = el.closest('[role="application"], #main') || document.body;
          const c = cont.getBoundingClientRect();
          return r.left - c.left > c.width / 2;
        }).catch(() => false);
        if (inviatoDaMe) { stato.presi[id] = { esito: 'inviato da me' }; continue; }
        const testo = (await bolla.innerText().catch(() => '')) || '';

        // 1) foto: leggo direttamente l'immagine mostrata nella bolla
        const img = bolla.locator('img[src^="blob:"]').first();
        if (await img.count().catch(() => 0)) {
          try {
            const b64 = await img.evaluate(async (el) => {
              const r = await fetch(el.src); const b = await r.blob();
              return await new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.readAsDataURL(b); });
            });
            const dati = Buffer.from(b64 || '', 'base64');
            if (dati.length >= MIN_BYTE && dati.length <= MAX_BYTE) {
              const dest = path.join(INBOX, `${nomeChat}__${Date.now()}__foto.jpg`);
              await fs.writeFile(dest, dati);
              stato.presi[id] = { esito: 'salvato', file: path.basename(dest), quando: new Date().toISOString() };
              salvati++;
              await log(`salvata foto da "${nomeChat}" (${Math.round(dati.length / 1024)} KB)`);
            } else stato.presi[id] = { esito: 'miniatura o troppo grande' };
            continue;
          } catch (e) { await log(`AVVISO: foto di "${nomeChat}" non salvata (${String(e.message).slice(0, 50)})`); }
        }

        // 2) documenti: la bolla mostra il nome del file; il pulsante scarica fa partire il download
        const m = testo.match(NOME_DOC);
        if (m) {
          const bottone = bolla.locator('[data-icon*="download"], [aria-label*="carica"], [aria-label*="ownload"], button').first();
          if (await bottone.count().catch(() => 0)) {
            try {
              const [scarico] = await Promise.all([
                page.waitForEvent('download', { timeout: 20000 }),
                bottone.click({ timeout: 8000 })
              ]);
              const nome = pulisci(scarico.suggestedFilename() || m[1]);
              const dest = path.join(INBOX, `${nomeChat}__${Date.now()}__${nome}`);
              await scarico.saveAs(dest);
              const st = await fs.stat(dest);
              if (st.size < MIN_BYTE) { await fs.rm(dest, { force: true }); stato.presi[id] = { esito: 'troppo piccolo' }; continue; }
              stato.presi[id] = { esito: 'salvato', file: path.basename(dest), quando: new Date().toISOString() };
              salvati++;
              await log(`salvato documento da "${nomeChat}": ${nome} (${Math.round(st.size / 1024)} KB)`);
            } catch (e) {
              stato.presi[id] = { esito: 'non scaricato' };
              await log(`AVVISO: documento "${m[1]}" di "${nomeChat}" non scaricato (${String(e.message).slice(0, 50)})`);
            }
          }
        }
      }
    }
    await fs.writeFile(STATO, JSON.stringify(stato));

    // La cartella di transito non deve crescere all'infinito: tolgo quello che ha più di due settimane
    // (a quel punto la raccolta l'ha già valutato).
    let ripuliti = 0;
    const vecchio = Date.now() - 14 * 24 * 3600 * 1000;
    for (const f of await fs.readdir(INBOX).catch(() => [])) {
      const p = path.join(INBOX, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < vecchio) { await fs.rm(p, { force: true }).catch(() => {}); ripuliti++; }
    }
    if (ripuliti) await log(`transito ripulito: ${ripuliti} file vecchi rimossi`);
    await log(`FINE WhatsApp Web: ${salvati} allegati nuovi in attesa di valutazione`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch(async (e) => { await log('ERRORE: ' + e.message); process.exitCode = 1; });
