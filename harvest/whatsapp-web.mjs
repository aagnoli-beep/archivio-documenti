#!/usr/bin/env node
/**
 * whatsapp-web.mjs - scarica da WhatsApp Web i documenti ricevuti nelle chat personali.
 *
 * L'app WhatsApp installata sul Mac è quella Business (lavoro) e non va toccata: il numero personale
 * vive su WhatsApp Web. Qui usiamo un profilo Chrome dedicato (non quello di tutti i giorni), che va
 * collegato UNA VOLTA SOLA inquadrando il QR col telefono personale:
 *
 *     node harvest/whatsapp-web.mjs --login
 *
 * Poi, a ogni giro, il programma apre WhatsApp Web senza finestra, guarda le chat più recenti e salva
 * gli allegati nuovi (PDF, immagini, documenti) in ~/.config/archivio-documenti/whatsapp-inbox.
 * Da lì li prende la raccolta notturna, che decide quali archiviare. Non legge, non invia e non
 * segna come letto nessun messaggio: apre solo le conversazioni per vedere gli allegati.
 *
 * Uso: node whatsapp-web.mjs [--login] [--days N] [--chats N] [--verbose] [--headed]
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
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log');

const args = process.argv.slice(2);
const LOGIN = args.includes('--login');
const HEADED = args.includes('--headed') || LOGIN;
const VERBOSE = args.includes('--verbose') || LOGIN;
const num = (nome, def) => { const i = args.indexOf(nome); return i >= 0 ? parseInt(args[i + 1], 10) || def : def; };
const GIORNI = num('--days', 3);
const CHAT = num('--chats', 15);

async function log(msg) {
  const riga = `${new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)} [whatsapp] ${msg}\n`;
  await fs.mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, riga).catch(() => {});
  if (VERBOSE || !process.env.HARVEST_QUIET) process.stdout.write(riga);
}

const pulisci = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'chat';

function caricaStato() {
  try { return JSON.parse(fsSync.readFileSync(STATO, 'utf8')); } catch { return { presi: {} }; }
}

async function main() {
  await fs.mkdir(INBOX, { recursive: true });
  await fs.mkdir(PROFILO, { recursive: true });
  const stato = caricaStato();
  stato.presi = stato.presi || {};

  const ctx = await chromium.launchPersistentContext(PROFILO, {
    channel: 'chrome',
    headless: !HEADED,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  let salvati = 0;
  try {
    await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 90000 });
    const listaChat = '#pane-side';
    const qr = 'canvas[aria-label*="scan"], canvas[aria-label*="Scan"], div[data-ref] canvas';

    const collegato = await Promise.race([
      page.waitForSelector(listaChat, { timeout: LOGIN ? 300000 : 60000 }).then(() => true).catch(() => false),
      page.waitForSelector(qr, { timeout: 20000 }).then(() => LOGIN ? page.waitForSelector(listaChat, { timeout: 300000 }).then(() => true).catch(() => false) : false).catch(() => false)
    ]);

    if (!collegato) {
      await log('SESSIONE DA COLLEGARE: apri il QR con "node harvest/whatsapp-web.mjs --login" e inquadralo col telefono personale');
      process.exitCode = 2;
      return;
    }
    if (LOGIN) { await log('sessione collegata: da ora i giri notturni funzionano da soli'); return; }

    const limite = Date.now() - GIORNI * 24 * 3600 * 1000;
    const righeChat = await page.locator(`${listaChat} [role="listitem"]`).all();
    await log(`chat visibili: ${righeChat.length}, ne guardo al massimo ${CHAT}`);

    for (const riga of righeChat.slice(0, CHAT)) {
      let nomeChat = 'chat';
      try { nomeChat = pulisci(await riga.locator('span[title]').first().getAttribute('title')); } catch { /* senza nome */ }
      try { await riga.click({ timeout: 15000 }); } catch { continue; }
      await page.waitForTimeout(1500);

      // messaggi ricevuti con allegato, dal più recente
      const messaggi = await page.locator('div.message-in').all();
      for (const m of messaggi.slice(-25)) {
        let id = '';
        try { id = await m.evaluate((el) => el.closest('[data-id]')?.getAttribute('data-id') || ''); } catch { /* niente id */ }
        if (!id || stato.presi[id]) continue;

        // 1) documenti: hanno un pulsante di scaricamento
        const bottoneScarica = m.locator('span[data-icon="audio-download"], span[data-icon="download"], button[aria-label*="Scarica"], button[aria-label*="Download"]').first();
        const titolo = await m.locator('[title]').first().getAttribute('title').catch(() => null);
        if (await bottoneScarica.count().catch(() => 0)) {
          try {
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 30000 }),
              bottoneScarica.click({ timeout: 10000 })
            ]);
            const nome = pulisci(download.suggestedFilename() || titolo || 'documento');
            const dest = path.join(INBOX, `${nomeChat}__${Date.now()}__${nome}`);
            await download.saveAs(dest);
            stato.presi[id] = { quando: new Date().toISOString(), file: path.basename(dest) };
            salvati++;
            await log(`salvato da "${nomeChat}": ${nome}`);
            continue;
          } catch (e) { await log(`AVVISO: allegato di "${nomeChat}" non scaricato (${String(e.message).slice(0, 60)})`); }
        }

        // 2) immagini: leggo direttamente il blob mostrato nella bolla
        const img = m.locator('img[src^="blob:"]').first();
        if (await img.count().catch(() => 0)) {
          try {
            const b64 = await img.evaluate(async (el) => {
              const r = await fetch(el.src); const b = await r.blob();
              return await new Promise((res) => { const f = new FileReader(); f.onload = () => res(String(f.result).split(',')[1]); f.readAsDataURL(b); });
            });
            if (b64 && b64.length > 20000) {          // sotto i ~15 KB sono miniature e faccine
              const dest = path.join(INBOX, `${nomeChat}__${Date.now()}__foto.jpg`);
              await fs.writeFile(dest, Buffer.from(b64, 'base64'));
              stato.presi[id] = { quando: new Date().toISOString(), file: path.basename(dest) };
              salvati++;
              await log(`salvata foto da "${nomeChat}"`);
            } else stato.presi[id] = { quando: new Date().toISOString(), esito: 'miniatura' };
          } catch (e) { await log(`AVVISO: foto di "${nomeChat}" non salvata (${String(e.message).slice(0, 60)})`); }
        }
      }
    }
    await fs.writeFile(STATO, JSON.stringify(stato));
    await log(`FINE WhatsApp Web: ${salvati} allegati nuovi in attesa di valutazione`);
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch(async (e) => { await log('ERRORE WhatsApp Web: ' + e.message); process.exitCode = 1; });
