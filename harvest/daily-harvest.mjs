#!/usr/bin/env node
/**
 * daily-harvest.mjs - ogni notte cerca sul Mac i documenti di famiglia nuovi e li manda all'archivio.
 *
 * Guarda: cartelle personali (Scrivania, Download, Documenti, iCloud Drive), le foto della libreria Foto,
 * gli allegati delle caselle di posta PERSONALI in Mail e i file ricevuti su WhatsApp Desktop.
 * Di ogni file nuovo estrae il testo (pdftotext, OCR con tesseract per scansioni e foto), scarta il
 * rumore evidente e chiede al backend (azione "judge") quali sono documenti di famiglia.
 * Carica in 00_Inbox solo quelli approvati: poi ci pensa la pipeline di sempre.
 *
 * Niente viene spostato o cancellato dal Mac. Stato in ~/.config/archivio-documenti/harvest-state.json.
 * Uso: node daily-harvest.mjs [--dry-run] [--days N] [--max N] [--verbose]
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config', 'archivio-documenti', 'config.json');
const STATE = path.join(HOME, '.config', 'archivio-documenti', 'harvest-state.json');
const LOG = path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log');
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');
const numArg = (nome, def) => { const i = args.indexOf(nome); return i >= 0 ? parseInt(args[i + 1], 10) || def : def; };

const DOC_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.docx', '.doc']);
const MAX_BYTES = 25 * 1024 * 1024;
const MIN_IMG_BYTES = 120 * 1024;          // sotto questa soglia sono icone, loghi, firme
const ESCLUDI = /\/(node_modules|\.git|\.venv|site-packages|Library\/Caches|\.Trash|Claude Code Progetti|Archivio Documenti|PDFServicesSDK|blob_storage|GPUCache|Session Storage|Code Cache|IndexedDB|Service Worker)\//i;
const NOMI_DA_SALTARE = /^(Screenshot|Schermata|CleanShot|Simulator Screen|icon|logo|avatar|sprite)/i;

async function log(msg) {
  const riga = `${new Date().toLocaleString('sv-SE').replace('T', ' ').slice(0, 19)} ${msg}\n`;
  await fs.mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await fs.appendFile(LOG, riga).catch(() => {});
  if (VERBOSE || !process.env.HARVEST_QUIET) process.stdout.write(riga);
}

async function md5(file) {
  const h = crypto.createHash('md5');
  h.update(await fs.readFile(file));
  return h.digest('hex');
}

async function run(cmd, argv, timeout = 60000) {
  try { const { stdout } = await execFileP(cmd, argv, { timeout, maxBuffer: 20 * 1024 * 1024, encoding: 'utf8' }); return stdout || ''; }
  catch { return ''; }
}

/** Testo del documento: prima il livello testo del PDF, poi l'OCR. Per le immagini solo OCR. */
async function estraiTesto(file, ext) {
  if (ext === '.pdf') {
    const t = await run('pdftotext', ['-l', '3', '-q', '-enc', 'UTF-8', file, '-']);
    if (t.replace(/\s/g, '').length >= 60) return t;
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'harvest-'));
    try {
      await run('pdftoppm', ['-f', '1', '-l', '1', '-r', '150', '-jpeg', file, path.join(tmp, 'p')], 90000);
      const pagine = (await fs.readdir(tmp)).filter((f) => f.endsWith('.jpg')).slice(0, 1);
      let ocr = '';
      for (const p of pagine) ocr += await run('tesseract', [path.join(tmp, p), 'stdout', '-l', 'ita+eng', '--psm', '3'], 120000);
      return ocr;
    } finally { await fs.rm(tmp, { recursive: true, force: true }).catch(() => {}); }
  }
  if (ext === '.docx') {
    const xml = await run('unzip', ['-p', file, 'word/document.xml']);
    return xml.replace(/<[^>]+>/g, ' ');
  }
  if (ext === '.doc') return await run('textutil', ['-stdout', '-convert', 'txt', file]);
  let img = file;
  let tmp = null;
  if (ext === '.heic' || ext === '.heif') {
    tmp = path.join(os.tmpdir(), 'harvest-' + path.basename(file) + '.jpg');
    await run('sips', ['-s', 'format', 'jpeg', file, '--out', tmp]);
    img = tmp;
  }
  const t = await run('tesseract', [img, 'stdout', '-l', 'ita+eng', '--psm', '3'], 120000);
  if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
  return t;
}

const senzaAccenti = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const RUMORE = /(unsubscribe|newsletter|privacy policy|cookie policy|white paper|webinar|slide|lezione|case study|roadmap|sprint|user story|endpoint|repository|curriculum|pitch deck|due diligence|business plan|non-disclosure)/;
const TIPI = /(referto|analisi|visita|ricetta|certificat|fattura|bolletta|contratto|polizza|quietanza|verbale|multa|bollo|sollecito|diffida|estratto conto|bonifico|mutuo|imu|tari|f24|730|isee|preventivo|garanzia|scadenz|pagament|imponibile|iban|codice fiscale|partita iva)/;

/** Primo filtro locale: butta via il rumore evidente senza spendere niente. */
function forsePersonale(nome, testo, famiglia) {
  const t = senzaAccenti(testo).slice(0, 6000);
  const n = senzaAccenti(nome);
  if (t.replace(/\s/g, '').length < 40 && !famiglia.some((f) => n.includes(f))) return false;
  const nomiTrovati = famiglia.some((f) => t.includes(f) || n.includes(f));
  const tipiTrovati = TIPI.test(t) || TIPI.test(n);
  if (!nomiTrovati && !tipiTrovati) return false;
  if (RUMORE.test(t) && !nomiTrovati) return false;
  return true;
}

async function* cammina(dir, profondita = 0, maxProfondita = 4) {
  if (profondita > maxProfondita) return;
  let voci = [];
  try { voci = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const v of voci) {
    const p = path.join(dir, v.name);
    if (ESCLUDI.test(p + '/')) continue;
    if (v.isDirectory()) yield* cammina(p, profondita + 1, maxProfondita);
    else if (v.isFile()) yield p;
  }
}

/** Caselle di posta personali in Mail: riconosciute dall'indirizzo dei messaggi, mai quelle di lavoro. */
async function cartelleMailPersonali(indirizziPersonali) {
  const base = path.join(HOME, 'Library', 'Mail');
  const trovate = [];
  let versioni = [];
  try { versioni = await fs.readdir(base); } catch { return trovate; }
  for (const v of versioni.filter((x) => /^V\d+$/.test(x))) {
    let conti = [];
    try { conti = await fs.readdir(path.join(base, v)); } catch { continue; }
    for (const c of conti) {
      const dir = path.join(base, v, c);
      if (!/^[0-9A-F-]{36}$/i.test(c)) continue;
      let campione = [];
      for await (const f of cammina(dir, 0, 8)) { if (f.endsWith('.emlx')) campione.push(f); if (campione.length >= 4) break; }
      let personale = false;
      for (const f of campione) {
        let testa = '';
        try { testa = (await fs.readFile(f)).subarray(0, 4000).toString('utf8'); } catch { continue; }
        const righe = testa.split(/\r?\n/).filter((r) => /^(To|Delivered-To|X-Original-To|Cc):/i.test(r)).join(' ').toLowerCase();
        if (indirizziPersonali.some((a) => righe.includes(a))) { personale = true; break; }
      }
      if (personale) trovate.push(dir);
    }
  }
  return trovate;
}

async function main() {
  let cfg;
  try { cfg = JSON.parse(await fs.readFile(CONFIG, 'utf8')); } catch { await log('SALTO: manca ' + CONFIG); return 0; }
  if (!cfg.apiUrl || !cfg.secret) { await log('SALTO: configurazione incompleta'); return 0; }
  const h = cfg.harvest || {};
  const GIORNI = numArg('--days', h.giorni || 3);
  const MAX_CARICHI = numArg('--max', h.massimoAlGiorno || 25);
  const famiglia = (h.famiglia || ['agnoli', 'durigutto', 'regattin']).map(senzaAccenti);
  const indirizziPersonali = (h.postaPersonale || ['andrea.agnoli@outlook.com', 'andrea.agnoli.1984@icloud.com', 'andrea.agnoli.1984@gmail.com']).map((s) => s.toLowerCase());
  const { callBackend } = await import(path.join(REPO, 'mcp', 'tools.mjs'));
  const api = (azione, dati) => callBackend(cfg.apiUrl, cfg.secret, azione, dati, { retries: 4 });

  let stato = { visti: {}, ultimoGiro: null };
  try { stato = JSON.parse(fsSync.readFileSync(STATE, 'utf8')); } catch { /* primo giro: nessuno stato */ }
  stato.visti = stato.visti || {};

  const limite = Date.now() - GIORNI * 24 * 3600 * 1000;
  const sorgenti = [];
  for (const d of (h.cartelle || ['Desktop', 'Downloads', 'Documents']).map((x) => path.join(HOME, x))) sorgenti.push({ dir: d, origine: 'cartella' });
  sorgenti.push({ dir: path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), origine: 'iCloud Drive' });
  sorgenti.push({ dir: path.join(HOME, 'Library', 'Mobile Documents', '3L68KQB4HG~com~readdle~Scanner'), origine: 'scanner del telefono' });
  // L'app WhatsApp installata sul Mac è quella Business, cioè di lavoro: non va guardata.
  // I documenti personali arrivano da WhatsApp Web, raccolti in questa cartella da harvest/whatsapp-web.mjs.
  sorgenti.push({ dir: path.join(HOME, '.config', 'archivio-documenti', 'whatsapp-inbox'), origine: 'WhatsApp' });
  // Corsia diretta: gruppo "Documenti" e chat con se stessi. Sono scelte esplicite, niente selezione.
  sorgenti.push({ dir: path.join(HOME, '.config', 'archivio-documenti', 'whatsapp-diretti'), origine: 'WhatsApp (scelto da te)', diretto: true });
  for (const d of await cartelleMailPersonali(indirizziPersonali)) sorgenti.push({ dir: d, origine: 'email personale', profondita: 12 });
  let libFoto = [];
  try { libFoto = (await fs.readdir(path.join(HOME, 'Pictures'))).filter((x) => x.endsWith('.photoslibrary')); } catch { /* niente Foto */ }
  for (const l of libFoto) sorgenti.push({ dir: path.join(HOME, 'Pictures', l, 'originals'), origine: 'foto' });

  // 1) raccolta dei file nuovi
  const candidati = [];
  for (const s of sorgenti) {
    let quanti = 0;
    for await (const f of cammina(s.dir, 0, s.profondita || 4)) {
      const ext = path.extname(f).toLowerCase();
      if (!DOC_EXT.has(ext)) continue;
      const nome = path.basename(f);
      if (NOMI_DA_SALTARE.test(nome)) continue;
      if (s.origine === 'email personale' && !/\/Attachments\//.test(f)) continue;
      let st;
      try { st = await fs.stat(f); } catch { continue; }
      if (st.mtimeMs < limite || st.size === 0 || st.size > MAX_BYTES) continue;
      if (ext !== '.pdf' && ext !== '.docx' && ext !== '.doc' && st.size < MIN_IMG_BYTES) continue;
      candidati.push({ path: f, nome, ext, size: st.size, origine: s.origine, diretto: !!s.diretto });
      quanti++;
      if (quanti >= (h.massimoPerSorgente || 400)) break;
    }
  }
  await log(`giro: ${candidati.length} file modificati negli ultimi ${GIORNI} giorni da ${sorgenti.length} sorgenti`);

  // WhatsApp salva anche le miniature: dello stesso allegato tengo solo il file più grande.
  const perWhatsApp = new Map();
  for (const c of candidati.filter((x) => x.origine === 'WhatsApp')) {
    const base = c.nome.slice(0, 36);
    const tenuto = perWhatsApp.get(base);
    if (!tenuto || c.size > tenuto.size) perWhatsApp.set(base, c);
  }
  const scartiWhatsApp = new Set(candidati.filter((c) => c.origine === 'WhatsApp' && perWhatsApp.get(c.nome.slice(0, 36)) !== c));
  if (scartiWhatsApp.size) await log(`miniature di WhatsApp saltate: ${scartiWhatsApp.size}`);

  // 2) testo + primo filtro locale
  const daValutare = [];
  const subito = [];                 // corsia diretta: non passano dal giudice
  let gia = 0, scartati = 0;
  const vistiInQuestoGiro = new Set();
  for (const c of candidati) {
    if (scartiWhatsApp.has(c)) continue;
    let firma;
    try { firma = await md5(c.path); } catch { continue; }
    if (stato.visti[firma] || vistiInQuestoGiro.has(firma)) { gia++; continue; }
    vistiInQuestoGiro.add(firma);
    c.md5 = firma;
    if (c.diretto) { c.categoria = ''; c.motivo = 'scelto da te su WhatsApp'; subito.push(c); continue; }
    const testo = (await estraiTesto(c.path, c.ext)).replace(/\s+/g, ' ').trim();
    if (!forsePersonale(c.nome, testo, famiglia)) { stato.visti[firma] = { quando: new Date().toISOString(), esito: 'scartato-subito' }; scartati++; continue; }
    c.testo = testo.slice(0, 1500);
    daValutare.push(c);
  }
  await log(`nuovi: ${candidati.length - gia} | scelti da te: ${subito.length} | scartati dal filtro locale: ${scartati} | da far valutare: ${daValutare.length}`);

  // 3) valutazione dal backend, a gruppi (la corsia diretta è già approvata e passa per prima)
  const approvati = subito.slice();
  for (let i = 0; i < daValutare.length; i += 20) {
    const gruppo = daValutare.slice(i, i + 20);
    let esiti = [];
    try {
      const r = await api('judge', { items: gruppo.map((c) => ({ id: c.md5.slice(0, 10), nome: c.nome, origine: c.origine, testo: c.testo })) });
      esiti = r.esiti || [];
    } catch (e) {
      await log(`AVVISO: valutazione non riuscita per un gruppo (${e.message}); riprovo domani`);
      continue;
    }
    for (const c of gruppo) {
      const e = esiti.find((x) => String(x.id) === c.md5.slice(0, 10));
      if (!e) continue;
      if (e.archiviare) { c.categoria = e.categoria; c.motivo = e.motivo; approvati.push(c); }
      else stato.visti[c.md5] = { quando: new Date().toISOString(), esito: 'no', motivo: e.motivo };
    }
  }
  await log(`approvati dal giudice: ${approvati.length}`);

  // 4) caricamento in Inbox
  let caricati = 0;
  for (const c of approvati.slice(0, MAX_CARICHI)) {
    if (DRY) { await log(`[prova] caricherei ${c.nome} (${c.origine}; ${c.categoria}: ${c.motivo})`); continue; }
    try {
      let file = c.path, mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heic', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.doc': 'application/msword' }[c.ext];
      let nome = c.nome;
      if (c.ext === '.heic' || c.ext === '.heif') {
        const tmp = path.join(os.tmpdir(), c.md5 + '.jpg');
        await run('sips', ['-s', 'format', 'jpeg', c.path, '--out', tmp]);
        file = tmp; mime = 'image/jpeg'; nome = c.nome.replace(/\.hei[cf]$/i, '.jpg');
      }
      const data = (await fs.readFile(file)).toString('base64');
      const r = await api('upload', { data, name: nome, mime });
      stato.visti[c.md5] = { quando: new Date().toISOString(), esito: 'caricato', nome: r.name };
      caricati++;
      // I file della corsia diretta sono solo di passaggio: una volta in archivio si tolgono.
      if (c.diretto) await fs.rm(c.path, { force: true }).catch(() => {});
      await log(`CARICATO (${c.origine}) ${nome} -> ${c.categoria}: ${c.motivo}`);
    } catch (e) {
      await log(`AVVISO: "${c.nome}" non caricato (${e.message}); riprovo domani`);
    }
  }
  if (approvati.length > MAX_CARICHI) await log(`altri ${approvati.length - MAX_CARICHI} approvati restano per domani (limite giornaliero ${MAX_CARICHI})`);

  stato.ultimoGiro = new Date().toISOString();
  if (!DRY) {
    await fs.mkdir(path.dirname(STATE), { recursive: true });
    await fs.writeFile(STATE, JSON.stringify(stato));
  }
  // Battito: dice al backend che il giro è arrivato in fondo. Se manca per giorni, l'archivio avvisa
  // per email (Mac spento o lavoro automatico fermo).
  try {
    await api('heartbeat', { nome: 'raccolta', dettaglio: `${caricati} caricati, ${daValutare.length} valutati, ${candidati.length} file guardati` });
  } catch (e) { await log(`AVVISO: battito non registrato (${e.message})`); }
  await log(`FINE: ${caricati} documenti mandati all'archivio`);
  return 0;
}

main().catch(async (e) => { await log('ERRORE: ' + e.message); process.exitCode = 1; });
