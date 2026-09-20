// Test della raccolta notturna: ambiente finto (cartella utente temporanea + backend locale).
// Uso: node harvest/test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execFileP = promisify(execFile);
const QUI = path.dirname(fileURLToPath(import.meta.url));

let passati = 0;
const t = (nome, fn) => { try { fn(); passati++; console.log('  ✔ ' + nome); } catch (e) { console.log('  ✘ ' + nome + '\n    ' + (e.message || e)); process.exitCode = 1; } };

/** PDF minimo con una riga di testo, leggibile da pdftotext. */
function pdfConTesto(testo) {
  const contenuto = `BT /F1 12 Tf 72 720 Td (${testo.replace(/([()\\])/g, '\\$1')}) Tj ET`;
  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n' +
    '2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n' +
    '3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>> endobj\n' +
    `4 0 obj <</Length ${contenuto.length}>> stream\n${contenuto}\nendstream endobj\n` +
    '5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj\n' +
    'trailer <</Root 1 0 R/Size 6>>\n%%EOF\n');
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-test-'));
fs.mkdirSync(path.join(HOME, 'Desktop'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'Downloads'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.config', 'archivio-documenti'), { recursive: true });
const scrivi = (rel, buf, giorniFa = 0) => {
  const p = path.join(HOME, rel);
  fs.writeFileSync(p, buf);
  if (giorniFa) { const q = Date.now() - giorniFa * 86400000; fs.utimesSync(p, q / 1000, q / 1000); }
  return p;
};
scrivi('Desktop/referto.pdf', pdfConTesto('Referto analisi del sangue di Andrea Agnoli del 12 marzo'));
scrivi('Desktop/bilancio.pdf', pdfConTesto('Bilancio di esercizio societa cliente ricavi e costi'));
scrivi('Downloads/Screenshot 2026-09-01.png', Buffer.alloc(200 * 1024, 7));
scrivi('Downloads/minuscola.jpg', Buffer.alloc(3 * 1024, 7));
scrivi('Downloads/vecchia-bolletta.pdf', pdfConTesto('Bolletta luce di Andrea Agnoli importo 82 euro'), 30);

const richieste = [];
const server = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => { corpo += c; });
  req.on('end', () => {
    const q = JSON.parse(corpo);
    richieste.push(q);
    res.setHeader('Content-Type', 'application/json');
    if (q.action === 'judge') {
      const esiti = q.items.map((it) => /referto|analisi/i.test(it.testo + it.nome)
        ? { id: it.id, archiviare: true, categoria: 'Salute', tipo: 'Referto', motivo: 'referto di famiglia' }
        : { id: it.id, archiviare: false, categoria: '', tipo: 'documento aziendale', motivo: 'documento di lavoro' });
      res.end(JSON.stringify({ ok: true, data: { esiti, valutati: esiti.length } }));
    } else if (q.action === 'upload') {
      res.end(JSON.stringify({ ok: true, data: { id: 'id-' + richieste.length, name: q.name } }));
    } else res.end(JSON.stringify({ ok: false, error: 'azione ignota' }));
  });
});
await new Promise((r) => server.listen(0, r));
const apiUrl = 'http://127.0.0.1:' + server.address().port + '/exec';
fs.writeFileSync(path.join(HOME, '.config', 'archivio-documenti', 'config.json'),
  JSON.stringify({ apiUrl, secret: 'chiave-di-prova', harvest: { giorni: 7, massimoAlGiorno: 25, famiglia: ['agnoli', 'durigutto'] } }));

const esegui = async (extra = []) => {
  const { stdout } = await execFileP('node', [path.join(QUI, 'daily-harvest.mjs'), '--days', '7', ...extra],
    { env: { ...process.env, HOME, HARVEST_QUIET: '' }, timeout: 180000 });
  return stdout;
};

console.log('1. Primo giro in prova (--dry-run)');
const provaOut = await esegui(['--dry-run']);
t('in prova non carica nulla', () => assert.strictEqual(richieste.filter((r) => r.action === 'upload').length, 0));
t('in prova dice cosa caricherebbe', () => assert.ok(/\[prova\] caricherei referto\.pdf/.test(provaOut), provaOut.slice(-300)));
t('in prova non scrive lo stato', () => assert.ok(!fs.existsSync(path.join(HOME, '.config', 'archivio-documenti', 'harvest-state.json'))));

console.log('2. Giro vero');
richieste.length = 0;
const out1 = await esegui();
const caricati = richieste.filter((r) => r.action === 'upload');
t('carica solo il documento di famiglia', () => { assert.strictEqual(caricati.length, 1); assert.strictEqual(caricati[0].name, 'referto.pdf'); });
t('manda al giudice solo i candidati, non gli scarti', () => {
  const nomi = richieste.filter((r) => r.action === 'judge').flatMap((r) => r.items.map((i) => i.nome));
  assert.ok(nomi.includes('referto.pdf'), 'manca il referto: ' + nomi.join(','));
  assert.ok(!nomi.includes('Screenshot 2026-09-01.png'), 'ha mandato uno screenshot');
  assert.ok(!nomi.includes('minuscola.jpg'), 'ha mandato un\'immagine minuscola');
  assert.ok(!nomi.includes('vecchia-bolletta.pdf'), 'ha mandato un file vecchio di 30 giorni');
});
t('al giudice manda solo testo, mai il file', () => {
  const items = richieste.filter((r) => r.action === 'judge').flatMap((r) => r.items);
  assert.ok(items.every((i) => !i.data && !i.base64), 'ha mandato dei byte al giudice');
  assert.ok(items.some((i) => /Referto analisi/.test(i.testo)), 'testo mancante');
});
t('scrive lo stato', () => assert.ok(fs.existsSync(path.join(HOME, '.config', 'archivio-documenti', 'harvest-state.json'))));
t('scrive il registro', () => assert.ok(/CARICATO .*referto\.pdf/.test(fs.readFileSync(path.join(HOME, 'Library', 'Logs', 'archivio-harvest.log'), 'utf8'))));

console.log('3. Secondo giro: niente di nuovo');
richieste.length = 0;
const out2 = await esegui();
t('non ricarica quello che ha gia visto', () => assert.strictEqual(richieste.filter((r) => r.action === 'upload').length, 0));
t('non richiede il giudizio dei file gia scartati', () => assert.strictEqual(richieste.filter((r) => r.action === 'judge').length, 0));
t('lo dice nel registro', () => assert.ok(/FINE: 0 documenti/.test(out2), out2.slice(-200)));

console.log('4. Doppioni nello stesso giro');
richieste.length = 0;
const stessoTesto = pdfConTesto('Referto analisi del sangue di Andrea Agnoli copia unica');
scrivi('Desktop/copia-a.pdf', stessoTesto);
scrivi('Downloads/copia-b.pdf', stessoTesto);
const out4 = await esegui();
t('lo stesso contenuto viene caricato una volta sola', () => {
  const nomi = richieste.filter((r) => r.action === 'upload').map((r) => r.name);
  assert.strictEqual(nomi.length, 1, 'caricati: ' + nomi.join(','));
});

console.log('5. Corsia diretta (gruppo Documenti / chat con se stessi)');
richieste.length = 0;
fs.mkdirSync(path.join(HOME, '.config/archivio-documenti/whatsapp-diretti'), { recursive: true });
scrivi('.config/archivio-documenti/whatsapp-diretti/Documenti__2026-09-21__volantino.pdf',
  pdfConTesto('Volantino della sagra paesana, nessun riferimento a documenti di famiglia'));
const out5 = await esegui();
t('quello che scegli tu viene archiviato anche se non sembra un documento di famiglia', () => {
  const nomi = richieste.filter((r) => r.action === 'upload').map((r) => r.name);
  assert.ok(nomi.includes('Documenti__2026-09-21__volantino.pdf'), 'caricati: ' + nomi.join(','));
});
t('la corsia diretta non passa dal giudice', () => {
  const visti = richieste.filter((r) => r.action === 'judge').flatMap((r) => r.items.map((i) => i.nome));
  assert.ok(!visti.some((n) => /volantino/.test(n)), 'ha chiesto il giudizio su un file scelto a mano');
});
t('una volta archiviato sparisce dalla cartella di transito', () => {
  assert.ok(!fs.existsSync(path.join(HOME, '.config/archivio-documenti/whatsapp-diretti/Documenti__2026-09-21__volantino.pdf')));
});

console.log('6. Limite giornaliero');
richieste.length = 0;
for (let i = 0; i < 4; i++) scrivi(`Desktop/referto-nuovo-${i}.pdf`, pdfConTesto(`Referto analisi del sangue di Andrea Agnoli numero ${i}`));
const out3 = await esegui(['--max', '2']);
t('carica al massimo il numero indicato', () => assert.strictEqual(richieste.filter((r) => r.action === 'upload').length, 2));
t('avvisa che il resto slitta a domani', () => assert.ok(/restano per domani/.test(out3), out3.slice(-300)));

server.close();
fs.rmSync(HOME, { recursive: true, force: true });
console.log('\n' + passati + ' test superati' + (process.exitCode ? ', CI SONO FALLIMENTI' : ', nessun fallimento'));
