#!/usr/bin/env node
/**
 * whatsapp-daemon.mjs - riceve gli allegati del WhatsApp personale e li mette in coda per l'archivio.
 *
 * Non legge la pagina di WhatsApp Web: parla il protocollo vero, lo stesso che usa il telefono quando
 * colleghi un dispositivo. Per questo non si rompe quando WhatsApp cambia grafica.
 * Si collega UNA VOLTA SOLA come dispositivo aggiuntivo:
 *
 *     node harvest/whatsapp-daemon.mjs --login
 *
 * Poi resta collegato in sottofondo (launchd lo riavvia da solo) e ogni volta che arriva una foto o un
 * documento lo salva in ~/.config/archivio-documenti/whatsapp-inbox. Da lì lo prende la raccolta
 * notturna, che decide se archiviarlo. Non invia messaggi, non segna niente come letto, non scrive
 * nelle chat: riceve e basta. I messaggi arrivati mentre il Mac era spento vengono consegnati alla
 * riconnessione, quindi non si perde niente.
 *
 * Uso: node whatsapp-daemon.mjs [--login] [--once N] [--verbose]
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket;
const { useMultiFileAuthState, downloadMediaMessage, DisconnectReason, fetchLatestBaileysVersion } = baileys;

const HOME = os.homedir();
const BASE = path.join(HOME, '.config', 'archivio-documenti');
const AUTH = path.join(BASE, 'whatsapp-auth');
const INBOX = path.join(BASE, 'whatsapp-inbox');
const DIRETTI = path.join(BASE, 'whatsapp-diretti');   // quello che va archiviato senza discutere
const CONFIG = path.join(BASE, 'config.json');
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const LOGIN = args.includes('--login');
const VERBOSE = args.includes('--verbose') || LOGIN;
const SOLO_PER = (() => { const i = args.indexOf('--once'); return i >= 0 ? (parseInt(args[i + 1], 10) || 120) * 1000 : 0; })();
// Collegamento con codice invece che col QR: WhatsApp → Dispositivi collegati → Collega con numero di telefono
const NUMERO_PER_CODICE = (() => { const i = args.indexOf('--pair'); return i >= 0 ? String(args[i + 1] || '').replace(/\D/g, '') : ''; })();

const MIN_BYTE = 15 * 1024;
const MAX_BYTE = 25 * 1024 * 1024;
const MIME_BUONI = /^(application\/pdf|image\/(jpeg|png|heic|heif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))/;
const ESTENSIONI = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heic',
  'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx' };

async function log(msg) {
  const riga = `${new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)} [whatsapp] ${msg}\n`;
  await fs.mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, riga).catch(() => {});
  if (VERBOSE || !process.env.HARVEST_QUIET) process.stdout.write(riga);
}

const pulisci = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9 ._-]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 50);

async function chiamaBackend(azione, dati) {
  try {
    const cfg = JSON.parse(fsSync.readFileSync(CONFIG, 'utf8'));
    if (!cfg.apiUrl || !cfg.secret) return null;
    const { callBackend } = await import(path.join(REPO, 'mcp', 'tools.mjs'));
    return await callBackend(cfg.apiUrl, cfg.secret, azione, dati, { retries: 2 });
  } catch (e) { await log('AVVISO: backend non raggiunto (' + String(e.message).slice(0, 60) + ')'); return null; }
}

const silenzioso = { level: 'silent', child: () => silenzioso, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

let tentativi = 0;
let uscita = null;
let connetti = async () => {};

/** Gruppi i cui allegati vanno archiviati sempre (impostazione harvest.gruppiArchivio). */
function gruppiDaArchiviare() {
  try {
    const h = (JSON.parse(fsSync.readFileSync(CONFIG, 'utf8')).harvest || {});
    return (h.gruppiArchivio || ['Documenti']).map((x) => String(x).trim().toLowerCase());
  } catch { return ['documenti']; }
}

async function main() {
  await fs.mkdir(DIRETTI, { recursive: true });
  await fs.mkdir(INBOX, { recursive: true });
  await fs.mkdir(AUTH, { recursive: true });
  connetti = avviaConnessione;
  await connetti();
}

async function avviaConnessione() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  // Il nome qui sotto è quello che vedi sul telefono in "Dispositivi collegati": così è chiaro cos'è.
  const sock = makeWASocket({
    auth: state, version, logger: silenzioso, syncFullHistory: false, markOnlineOnConnect: false,
    browser: ['Archivio di casa', 'Chrome', '121.0.0']
  });
  sock.ev.on('creds.update', saveCreds);

  if (NUMERO_PER_CODICE && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const codice = await sock.requestPairingCode(NUMERO_PER_CODICE);
        const bello = String(codice).replace(/(.{4})(.*)/, '$1-$2');
        await log('CODICE DI COLLEGAMENTO: ' + bello);
        console.log('\nSul telefono: WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo\n' +
          '→ "Collega con numero di telefono" e digita:  ' + bello + '\n');
      } catch (e) { await log('ERRORE nel chiedere il codice: ' + e.message); }
    }, 4000);
  }

  const termina = (codice) => { uscita = codice; try { sock.end(); } catch { /* già chiuso */ } };

  sock.ev.on('connection.update', async (u) => {
    if (u.qr) {
      if (NUMERO_PER_CODICE) return;        // sto usando il codice numerico, il QR non serve
      if (LOGIN) {
        // Salvo il codice anche come immagine: si può inquadrare dallo schermo, senza terminale.
        try {
          const file = path.join(HOME, 'Desktop', 'whatsapp-archivio-qr.png');
          await require('qrcode').toFile(file, u.qr, { width: 520, margin: 2 });
          await log('codice QR salvato in ' + file);
        } catch (e) { await log('AVVISO: immagine del QR non creata (' + String(e.message).slice(0, 50) + ')'); }
        require('qrcode-terminal').generate(u.qr, { small: true });
        console.log('\nInquadra il codice con WhatsApp del telefono PERSONALE:\nImpostazioni → Dispositivi collegati → Collega un dispositivo\n');
      } else {
        await log('SESSIONE DA COLLEGARE: WhatsApp non è più collegato');
        await chiamaBackend('avviso', { chiave: 'whatsapp', oggetto: 'WhatsApp da ricollegare',
          testo: 'Il collegamento di WhatsApp con l\'archivio è saltato.\n\nSul Mac apri il Terminale ed esegui:\n  node "' +
            path.join(REPO, 'harvest', 'whatsapp-daemon.mjs') + '" --login\ne inquadra il codice con il telefono personale.\n\nIl resto dell\'archivio continua a funzionare.' });
        termina(2);
      }
      return;
    }
    if (u.connection === 'open') {
      tentativi = 0;
      await log('collegato a WhatsApp' + (sock.user && sock.user.id ? ' come ' + sock.user.id.split(':')[0] : ''));
      await chiamaBackend('heartbeat', { nome: 'whatsapp', dettaglio: 'collegato' });
      if (LOGIN) { await log('collegamento riuscito: da ora riceve da solo'); setTimeout(() => termina(0), 3000); }
    }
    if (u.connection === 'close') {
      const codice = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (codice === DisconnectReason.loggedOut) {
        await log('ERRORE: collegamento revocato dal telefono');
        await chiamaBackend('avviso', { chiave: 'whatsapp', oggetto: 'WhatsApp scollegato',
          testo: 'Il dispositivo dell\'archivio è stato scollegato da WhatsApp. Per rimetterlo:\n  node "' +
            path.join(REPO, 'harvest', 'whatsapp-daemon.mjs') + '" --login' });
        await fs.rm(AUTH, { recursive: true, force: true }).catch(() => {});
        process.exit(2);
      }
      if (uscita !== null) { process.exit(uscita); }
      // WhatsApp chiude la connessione in tanti casi normali: subito dopo l'abbinamento, quando la rete
      // salta, quando il telefono si riconnette. Si riparte da soli, con attesa crescente.
      tentativi++;
      const attesa = Math.min(60, 3 * tentativi);
      await log(`connessione chiusa (${codice || 'senza codice'}), riprovo fra ${attesa} s`);
      setTimeout(() => { connetti().catch(async (e) => { await log('ERRORE in riconnessione: ' + e.message); process.exit(1); }); }, attesa * 1000);
    }
  });

  const GRUPPI = gruppiDaArchiviare();
  const nomiGruppo = new Map();   // jid -> nome, per non richiederlo a ogni messaggio
  const nomeDelGruppo = async (jid) => {
    if (nomiGruppo.has(jid)) return nomiGruppo.get(jid);
    let nome = '';
    try { nome = (await sock.groupMetadata(jid)).subject || ''; } catch { /* gruppo non leggibile */ }
    nomiGruppo.set(jid, nome);
    return nome;
  };

  sock.ev.on('messages.upsert', async (ev) => {
    if (ev.type !== 'notify') return;
    for (const m of ev.messages || []) {
      try {
        if (!m.message) continue;
        // Di norma salto quello che ho mandato io, ma la chat con me stesso è un modo comodo per
        // archiviare al volo: inoltro lì un documento e finisce nell'archivio.
        const mio = (sock.user && sock.user.id || '').split(':')[0].split('@')[0];
        const jid = String(m.key.remoteJid || '');
        const chatConMeStesso = mio && jid.startsWith(mio);
        const nomeGruppo = jid.endsWith('@g.us') ? await nomeDelGruppo(jid) : '';
        const gruppoScelto = !!nomeGruppo && GRUPPI.indexOf(nomeGruppo.trim().toLowerCase()) >= 0;
        // Chat con me stesso e gruppo dedicato: è una scelta esplicita, quindi si archivia e basta.
        const diretto = chatConMeStesso || gruppoScelto;
        if (m.key.fromMe && !diretto) continue;
        const contenuto = m.message.documentMessage
          || (m.message.documentWithCaptionMessage && m.message.documentWithCaptionMessage.message && m.message.documentWithCaptionMessage.message.documentMessage)
          || m.message.imageMessage;
        if (!contenuto) continue;
        const mime = String(contenuto.mimetype || '').split(';')[0];
        if (!MIME_BUONI.test(mime)) continue;
        const dati = await downloadMediaMessage(m, 'buffer', {});
        const minimo = diretto ? 5 * 1024 : MIN_BYTE;      // se me lo mandi apposta, prendo anche il piccolo
        if (!dati || dati.length < minimo || dati.length > MAX_BYTE) continue;
        const chi = pulisci(nomeGruppo || m.pushName || jid.split('@')[0]) || 'chat';
        const quando = new Date((Number(m.messageTimestamp) || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
        const base = pulisci((contenuto.fileName || contenuto.caption || 'allegato').replace(/\.[^.]*$/, '')) || 'allegato';
        const dest = path.join(diretto ? DIRETTI : INBOX, `${chi}__${quando}__${base}${ESTENSIONI[mime] || ''}`);
        await fs.writeFile(dest, dati);
        await log(`ricevuto da "${chi}"${diretto ? ' [da archiviare subito]' : ''}: ${path.basename(dest)} (${Math.round(dati.length / 1024)} KB)`);
      } catch (e) {
        await log('AVVISO: allegato non salvato (' + String(e.message).slice(0, 70) + ')');
      }
    }
  });

  // battito periodico: se il servizio muore, il controllo serale dell'archivio se ne accorge
  const battito = setInterval(() => { chiamaBackend('heartbeat', { nome: 'whatsapp', dettaglio: 'in ascolto' }); }, 6 * 3600 * 1000);
  battito.unref();
  if (SOLO_PER) setTimeout(() => termina(0), SOLO_PER);
  if (LOGIN) setTimeout(() => { if (uscita === null) { log('tempo scaduto: codice non inquadrato'); termina(3); } }, 300000);
}

main().catch(async (e) => { await log('ERRORE: ' + e.message); process.exit(1); });
