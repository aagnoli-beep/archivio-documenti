'use strict';
const assert = require('assert');
const fs = require('fs');
const { root, nodes } = require('./gas-runtime.js');
const G = globalThis;
const pdfBytes = Array.from(fs.readFileSync(__dirname + '/bolletta.pdf'));
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ✔ ' + name); } catch (e) { console.log('  ✘ ' + name + '\n    ' + (e.stack || e)); process.exitCode = 1; } }
const claudeOk = (meta) => ({ code: 200, body: { model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 4200, output_tokens: 180 }, content: [{ type: 'text', text: JSON.stringify(meta) }] } });
const bolletta = { categoria: 'Utenze', sottocategoria: 'Luce', sotto_sottocategoria: '', tipo_documento: 'Fattura', mittente: 'Enel Energia S.p.A.', destinatario: 'Serena', soggetti: ['Serena'], data_documento: '2026-08-30', titolo_breve: 'Bolletta luce luglio', riassunto: 'Bolletta luce di luglio 2026, 87,40 EUR entro il 20/09/2026.', importo: '87,40 EUR', scadenza: '2026-09-20', numero_pagine: 1, confidenza: 0.92 };

console.log('1. setupProject');
G.__props.ANTHROPIC_API_KEY = 'sk-test';
setupProject();
const props = G.__props;
const inbox = DriveApp.getFolderById(props.INBOX_FOLDER_ID), archive = DriveApp.getFolderById(props.ARCHIVE_FOLDER_ID), backup = DriveApp.getFolderById(props.BACKUP_FOLDER_ID);
const ss = SpreadsheetApp.openById(props.SPREADSHEET_ID);
t('cartelle create sotto "Archivio Documenti"', () => { const r = DriveApp.getFolderById(props.ROOT_FOLDER_ID); assert.strictEqual(r.getName(), 'Archivio Documenti'); assert.deepStrictEqual(r.children.filter(c => c.kind === 'folder').map(c => c.name).sort(), ['00_Inbox', 'Archivio', 'Backup']); });
t('fogli Indice/Config/Categorie/Log con intestazioni, Foglio1 rimosso', () => { assert.deepStrictEqual(ss.getSheets().map(s => s.name), ['Indice', 'Config', 'Categorie', 'Log']); assert.strictEqual(ss.getSheetByName('Indice').rows[0].length, 21); assert.strictEqual(ss.getSheetByName('Config').rows.length, 13); assert.strictEqual(ss.getSheetByName('Categorie').rows.length, 15); });
t('due trigger installati', () => { assert.deepStrictEqual(G.__triggers.map(x => x.getHandlerFunction()), ['processInbox', 'exportIndexXlsx']); });
t('setup rieseguibile senza duplicati', () => { setupProject(); assert.strictEqual(G.__triggers.length, 2); assert.strictEqual(DriveApp.getFolderById(props.ROOT_FOLDER_ID).children.filter(c => c.kind === 'folder').length, 3); });
t('getConfig legge fogli e default', () => { const c = getConfig(); assert.strictEqual(c.model, 'claude-opus-5'); assert.strictEqual(c.confidenceThreshold, 0.75); assert.ok(c.categoryNames.indexOf('Salute') >= 0); assert.deepStrictEqual(c.family, ['Andrea Agnoli', 'Serena']); });

console.log('2. processInbox - caso normale');
G.__httpHandler = () => claudeOk(bolletta);
const f1 = G.__mkfile(inbox, 'Scan_0001.pdf', pdfBytes, 'application/pdf');
const fresh = G.__mkfile(inbox, 'Scan_fresh.pdf', pdfBytes, 'application/pdf', 5000);
processInbox();
t('file rinominato e spostato in Archivio', () => { assert.strictEqual(f1.parent, archive); assert.strictEqual(f1.getName(), '2026-08-30_Utenze_Luce_Enel-Energia-S-p-A_Serena_Bolletta-luce-luglio.pdf'); });
t('file appena caricato (upload in corso) viene saltato', () => { assert.strictEqual(fresh.parent, inbox); });
t('riga nell\'Indice con tutti i campi', () => { const rows = getAllIndexRows(); assert.strictEqual(rows.length, 1); const r = rows[0]; assert.strictEqual(r.id, f1.getId()); assert.strictEqual(r.categoria, 'Utenze'); assert.strictEqual(r.soggetti, 'Serena'); assert.strictEqual(r.importo, '87,40 EUR'); assert.strictEqual(r.scadenza, '2026-09-20'); assert.strictEqual(r.stato, 'Auto'); assert.strictEqual(r.confidenza, 0.92); assert.strictEqual(r.nomeOriginale, 'Scan_0001.pdf'); assert.strictEqual(r.link, 'https://drive.google.com/file/d/' + f1.getId() + '/view'); });
t('descrizione e appProperties scritte su Drive', () => { assert.ok(f1.description.indexOf('Mittente: Enel Energia S.p.A.') >= 0); assert.strictEqual(f1.appProperties.categoria, 'Utenze'); assert.ok(Object.keys(f1.appProperties).every(k => (k + f1.appProperties[k]).length <= 124)); });
t('richiesta a Claude: modello, PDF base64, schema JSON, effort, fallbacks e header beta', () => {
  const req = G.__http.filter(h => h.url.indexOf('anthropic.com') >= 0)[0]; const body = JSON.parse(req.opts.payload);
  assert.strictEqual(req.opts.headers['x-api-key'], 'sk-test'); assert.strictEqual(req.opts.headers['anthropic-version'], '2023-06-01'); assert.strictEqual(req.opts.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(body.model, 'claude-opus-5'); assert.strictEqual(body.fallbacks, 'default'); assert.strictEqual(body.output_config.effort, 'low');
  assert.strictEqual(body.output_config.format.type, 'json_schema'); assert.strictEqual(body.output_config.format.schema.additionalProperties, false); assert.strictEqual(body.output_config.format.schema.required.length, 15);
  assert.ok(body.output_config.format.schema.properties.categoria.enum.indexOf('Utenze') >= 0);
  const doc = body.messages[0].content[0]; assert.strictEqual(doc.type, 'document'); assert.strictEqual(doc.source.media_type, 'application/pdf'); assert.ok(Buffer.from(doc.source.data, 'base64').slice(0, 4).toString() === '%PDF');
  assert.ok(body.system.indexOf('Andrea Agnoli, Serena') >= 0); assert.ok(!('thinking' in body));
});
t('log INFO scritto', () => { const log = ss.getSheetByName('Log').rows; assert.ok(log.some(r => r[1] === 'INFO' && String(r[3]).indexOf('Classificato: Utenze / Luce') === 0)); });

console.log('3. duplicati, confidenza bassa, categoria sconosciuta, data mancante');
G.__httpHandler = () => claudeOk(bolletta);
const f2 = G.__mkfile(inbox, 'Scan_0002.pdf', pdfBytes, 'application/pdf');
processInbox();
t('stesso documento due volte -> suffisso _2', () => { assert.ok(/_Bolletta-luce-luglio_2\.pdf$/.test(f2.getName()), f2.getName()); });
G.__httpHandler = () => claudeOk(Object.assign({}, bolletta, { confidenza: 0.4 }));
const f3 = G.__mkfile(inbox, 'Scan_0003.pdf', pdfBytes, 'application/pdf'); processInbox();
t('confidenza bassa -> Da verificare', () => { assert.strictEqual(getIndexRow(f3.getId()).stato, 'Da verificare'); });
G.__httpHandler = () => claudeOk(Object.assign({}, bolletta, { categoria: 'Inventata', confidenza: 0.9 }));
const f4 = G.__mkfile(inbox, 'Scan_0004.pdf', pdfBytes, 'application/pdf'); processInbox();
t('categoria non ammessa -> Altro + Da verificare', () => { const r = getIndexRow(f4.getId()); assert.strictEqual(r.categoria, 'Altro'); assert.strictEqual(r.stato, 'Da verificare'); assert.ok(f4.getName().indexOf('_Altro_') > 0); });
G.__httpHandler = () => claudeOk(Object.assign({}, bolletta, { data_documento: '', confidenza: 0.95 }));
const f5 = G.__mkfile(inbox, 'Scan_0005.pdf', pdfBytes, 'application/pdf'); processInbox();
t('data mancante -> data di scansione, stato Auto', () => { const r = getIndexRow(f5.getId()); assert.strictEqual(r.dataDocumento, Utilities.formatDate(f5.getDateCreated(), '', 'yyyy-MM-dd')); assert.strictEqual(r.stato, 'Auto'); });

console.log('4. errori API');
G.__httpHandler = () => ({ code: 401, body: { error: { message: 'invalid x-api-key' } } });
const f6 = G.__mkfile(inbox, 'Scan_0006.pdf', pdfBytes, 'application/pdf');
processInbox(); processInbox();
t('401 -> file resta in Inbox, una sola email di avviso', () => { assert.strictEqual(f6.parent, inbox); assert.strictEqual(G.__mail.length, 1); assert.ok(G.__mail[0].subject.indexOf('chiave API') >= 0); assert.ok(G.__mail[0].body.indexOf('00_Inbox') >= 0); });
G.__httpHandler = () => ({ code: 400, body: { error: { message: 'Your credit balance is too low' } } });
processInbox();
t('credito esaurito -> stessa gestione, nessuna seconda email nello stesso giorno', () => { assert.strictEqual(f6.parent, inbox); assert.strictEqual(G.__mail.length, 1); });
let calls = 0; G.__httpHandler = () => { calls++; return { code: 500, body: { error: { message: 'overloaded' } } }; };
processInbox();
t('500 -> 3 tentativi HTTP, file resta in Inbox, contatore tentativi = 1', () => { assert.strictEqual(calls, 3); assert.strictEqual(f6.parent, inbox); assert.strictEqual(G.__props['ATTEMPTS_' + f6.getId()], '1'); });
for (let i = 0; i < 4; i++) processInbox();
t('dopo 5 giri falliti -> archiviato come Non classificato con email', () => { assert.strictEqual(f6.parent, archive); const r = getIndexRow(f6.getId()); assert.strictEqual(r.stato, 'Non classificato'); assert.ok(f6.getName().indexOf('_NonClassificato_') > 0); assert.strictEqual(G.__props['ATTEMPTS_' + f6.getId()], undefined); assert.strictEqual(G.__mail.length, 2); });
G.__httpHandler = () => claudeOk(bolletta);
processInbox();
t('ripristinata la chiave, i file in attesa vengono processati', () => { assert.strictEqual(inbox.getFiles().hasNext(), true); /* solo il file "fresh" resta */ const left = []; const it = inbox.getFiles(); while (it.hasNext()) left.push(it.next().getName()); assert.deepStrictEqual(left, ['Scan_fresh.pdf']); });
G.__httpHandler = () => ({ code: 200, body: { model: 'claude-opus-5', stop_reason: 'refusal', content: [] } });
const f7 = G.__mkfile(inbox, 'Scan_0007.pdf', pdfBytes, 'application/pdf'); processInbox();
t('refusal -> archiviato subito come Non classificato', () => { assert.strictEqual(f7.parent, archive); assert.strictEqual(getIndexRow(f7.getId()).stato, 'Non classificato'); });
G.__httpHandler = () => claudeOk(bolletta);
G.__props.ANTHROPIC_API_KEY = '';
const f8 = G.__mkfile(inbox, 'Scan_0008.pdf', pdfBytes, 'application/pdf'); G.__props.ALERT_SENT_api_problem = '2000-01-01'; processInbox();
t('chiave mancante -> avviso e file in attesa', () => { assert.strictEqual(f8.parent, inbox); assert.strictEqual(G.__mail.length, 3); });
G.__props.ANTHROPIC_API_KEY = 'sk-test';

console.log('5. PDF grande e immagini');
const referto = { categoria: 'Salute', sottocategoria: 'Visita specialistica', sotto_sottocategoria: 'Cardiologia', tipo_documento: 'Referto', mittente: 'Dott. Mario Rossi', destinatario: 'Andrea Agnoli', soggetti: ['Andrea Agnoli'], data_documento: '2026-03-12', titolo_breve: 'Referto cardiologia', riassunto: 'ECG nella norma.', importo: '', scadenza: '', numero_pagine: 2, confidenza: 0.9 };
G.__httpHandler = () => claudeOk(referto);
G.__http.length = 0;
const big = G.__mkfile(inbox, 'Scan_big.pdf', new Array(21 * 1024 * 1024).fill(0), 'application/pdf'); processInbox();
t('PDF > 20MB -> testo OCR via Drive, doc temporaneo eliminato', () => { const body = G.__http.map(h => JSON.parse(h.opts.payload)).find(b => b.messages[0].content[0].type === 'text'); assert.ok(body, 'nessuna richiesta con blocco text'); assert.ok(body.messages[0].content[0].text.indexOf('TESTO OCR') >= 0); assert.ok(!Object.values(nodes).some(n => n.name && n.name.indexOf('tmp-ocr') === 0)); assert.strictEqual(big.parent, archive); assert.ok(/^2026-03-12_Salute_Visita-specialistica_Dott-Mario-Rossi_Andrea-Agnoli_Referto-cardiologia(_\d+)?\.pdf$/.test(big.getName()), big.getName()); });
G.__http.length = 0;
const img = G.__mkfile(inbox, 'foto.jpg', [255, 216, 255, 1, 2, 3], 'image/jpeg'); processInbox();
t('immagine JPEG -> blocco image, estensione conservata', () => { const body = JSON.parse(G.__http[0].opts.payload); assert.strictEqual(body.messages[0].content[0].type, 'image'); assert.strictEqual(body.messages[0].content[0].source.media_type, 'image/jpeg'); assert.ok(/\.jpg$/.test(img.getName())); assert.ok(/_2\.jpg$/.test(img.getName()) === false); });

console.log('6. API del sito (login Google + azioni)');
const CLIENT='123-abc.apps.googleusercontent.com';
ss.getSheetByName('Config').rows.forEach(r => { if (r[0]==='GOOGLE_CLIENT_ID') r[1]=CLIENT; if (r[0]==='ALLOWED_EMAILS') r[1]='serena@example.com, andrea.agnoli.1984@gmail.com'; if (r[0]==='EDITOR_EMAILS') r[1]='andrea.agnoli.1984@gmail.com'; if (r[0]==='SITE_URL') r[1]='https://example.github.io/archivio/'; });
const tokens = { good: { aud: CLIENT, email: 'serena@example.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600), name: 'Serena', picture: 'p' },
  editor: { aud: CLIENT, email: 'andrea.agnoli.1984@gmail.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600), name: 'Andrea' },
  wrongaud: { aud: 'other', email: 'serena@example.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600) },
  stranger: { aud: CLIENT, email: 'hacker@example.com', email_verified: 'true', exp: String(Math.floor(Date.now()/1000)+3600) } };
let tokenCalls = 0;
G.__httpHandler = (url, opts) => {
  if (url.indexOf('tokeninfo') >= 0) { tokenCalls++; const t = decodeURIComponent(url.split('id_token=')[1]); return tokens[t] ? { code: 200, body: tokens[t] } : { code: 400, body: { error: 'invalid' } }; }
  return claudeOk(bolletta);
};
const call = (payload) => JSON.parse(doPost({ postData: { contents: JSON.stringify(payload) }, parameter: {} })._text);
t('visita senza action -> pagina di redirect al sito', () => { const out = doGet({ parameter: {} }); assert.ok(out._html.indexOf('example.github.io') > 0); });
t('senza token -> login_required', () => { const r = call({ action: 'index' }); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'login_required'); });
t('token con client id sbagliato -> rifiutato', () => { const r = call({ action: 'index', token: 'wrongaud' }); assert.strictEqual(r.code, 'forbidden'); });
t('account non in lista -> rifiutato', () => { const r = call({ action: 'index', token: 'stranger' }); assert.strictEqual(r.code, 'forbidden'); assert.ok(r.error.indexOf('hacker@example.com') >= 0); });
t('Serena (in lista) -> indice, non editor', () => { const r = call({ action: 'index', token: 'good' }); assert.strictEqual(r.ok, true); assert.ok(r.data.docs.length >= 8); assert.strictEqual(r.user.email, 'serena@example.com'); assert.strictEqual(r.user.canEdit, false); assert.ok(r.data.categories.Salute.length > 0); });
t('verifica token in cache (una sola chiamata a Google)', () => { const before = tokenCalls; call({ action: 'index', token: 'good' }); call({ action: 'me', token: 'good' }); assert.strictEqual(tokenCalls, before); });
t('Serena non può modificare né caricare', () => { assert.strictEqual(call({ action: 'update', token: 'good', id: f3.getId(), fields: { titolo: 'x' } }).code, 'forbidden'); assert.strictEqual(call({ action: 'upload', token: 'good', data: 'AAAA', name: 'a.pdf' }).code, 'forbidden'); });
t('file: contenuto base64 di un documento indicizzato, rifiuto per file estranei', () => { const r = call({ action: 'file', token: 'good', id: f1.getId() }); assert.strictEqual(r.ok, true); assert.strictEqual(Buffer.from(r.data.base64, 'base64').length, pdfBytes.length); assert.strictEqual(r.data.mime, 'application/pdf'); const other = G.__mkfile(root, 'segreto.pdf', pdfBytes, 'application/pdf'); assert.strictEqual(call({ action: 'file', token: 'good', id: other.getId() }).code, 'not_found'); });
const upd = call({ action: 'update', token: 'editor', id: f3.getId(), fields: { mittente: 'Enel Energia', titolo: 'Bolletta luce', dataDocumento: '2026-08-31', soggetti: 'Serena, Andrea Agnoli', scadenza: 'boh', paroleChiave: 'luce, enel' } }).data;
t('Andrea (editor) modifica: rinomina, aggiorna riga, stato Verificato', () => { assert.strictEqual(upd.stato, 'Verificato'); assert.strictEqual(f3.getName(), '2026-08-31_Utenze_Luce_Enel-Energia_Serena_Bolletta-luce.pdf'); const r = getIndexRow(f3.getId()); assert.strictEqual(r.nomeFile, f3.getName()); assert.strictEqual(r.soggetti, 'Serena, Andrea Agnoli'); assert.strictEqual(r.scadenza, ''); assert.strictEqual(r.paroleChiave, 'luce, enel'); });
const up = call({ action: 'upload', token: 'editor', data: Buffer.from(pdfBytes).toString('base64'), name: 'foto-documento.pdf', mime: 'application/pdf' }).data;
t('upload dell\'editor finisce nella Inbox', () => { const n = nodes[up.id]; assert.strictEqual(n.parent, inbox); assert.strictEqual(n.getSize(), pdfBytes.length); });
G.__http.length = 0;
G.__httpHandler = (url) => url.indexOf('tokeninfo') >= 0 ? { code: 200, body: tokens.good } : { code: 200, body: { model: 'claude-opus-5', stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 80 }, content: [{ type: 'text', text: JSON.stringify({ risposta: 'La bolletta della luce scade il 2026-09-20.', documenti: [f1.getId(), 'inesistente'] }) }] } };
const ans = call({ action: 'ask', token: 'good', question: 'Quando scade la bolletta della luce?', history: [{ role: 'user', text: 'ciao' }, { role: 'assistant', text: 'ciao!' }] });
t('chiedi: risposta con documenti citati (solo ID validi), schede nel prompt', () => { assert.strictEqual(ans.ok, true); assert.ok(ans.data.answer.indexOf('2026-09-20') > 0); assert.strictEqual(ans.data.docs.length, 1); assert.strictEqual(ans.data.docs[0].id, f1.getId()); const body = JSON.parse(G.__http.filter(h => h.url.indexOf('anthropic') >= 0)[0].opts.payload); assert.ok(body.messages[body.messages.length - 1].content.indexOf('SCHEDE DOCUMENTI') === 0); assert.strictEqual(body.messages.length, 3); assert.strictEqual(body.output_config.format.type, 'json_schema'); });
t('chiedi: domanda vuota rifiutata', () => { assert.strictEqual(call({ action: 'ask', token: 'good', question: '  ' }).code, 'bad_request'); });
t('azione sconosciuta -> bad_request', () => { assert.strictEqual(call({ action: 'boh', token: 'good' }).code, 'bad_request'); });
G.__props.MCP_SECRET = 'chiave-di-famiglia-molto-lunga-123456';
t('chiave di famiglia giusta -> accesso come proprietario con permessi di modifica', () => { const r = call({ action: 'index', secret: 'chiave-di-famiglia-molto-lunga-123456' }); assert.strictEqual(r.ok, true); assert.strictEqual(r.user.canEdit, true); assert.strictEqual(r.user.name, 'Claude (MCP)'); });
t('chiave sbagliata o corta -> rifiutata', () => { assert.strictEqual(call({ action: 'index', secret: 'chiave-di-famiglia-molto-lunga-000000' }).code, 'forbidden'); assert.strictEqual(call({ action: 'index', secret: 'corta' }).code, 'forbidden'); });
t('backup_xlsx restituisce l\'export piu recente', () => { const r = call({ action: 'backup_xlsx', secret: 'chiave-di-famiglia-molto-lunga-123456' }); assert.strictEqual(r.ok, true); assert.ok(r.data === null || /^Indice_/.test(r.data.name)); });
console.log('7. export Excel e reindex');
G.__httpHandler = (url) => ({ code: 200, body: '', bytes: [80, 75, 3, 4] });
for (let i = 0; i < 14; i++) { exportIndexXlsx(); backup.children.forEach((c, k) => { if (/^Indice_/.test(c.name) && !c.trashed) c.name = 'Indice_2026-01-' + String(k + 1).padStart(2, '0') + '.xlsx'; }); }
t('export xlsx in Backup, al massimo 12 conservati', () => { const kept = backup.children.filter(c => !c.trashed && /^Indice_/.test(c.name)); assert.ok(kept.length <= 12 && kept.length >= 1, 'kept ' + kept.length); assert.ok(G.__http.some(h => h.url.indexOf('/export?format=xlsx') > 0 && h.opts.headers.Authorization === 'Bearer tok')); });
const orphan = G.__mkfile(archive, '2026-01-01_Casa_Affitto_X_Y_Z.pdf', pdfBytes, 'application/pdf'); orphan.appProperties = { categoria: 'Casa', sottocategoria: 'Affitto', mittente: 'X', soggetti: 'Andrea Agnoli', dataDocumento: '2026-01-01' };
reindexMissing();
t('reindexMissing aggiunge il file orfano con i dati delle appProperties', () => { const r = getIndexRow(orphan.getId()); assert.ok(r); assert.strictEqual(r.categoria, 'Casa'); assert.strictEqual(r.stato, 'Da verificare'); assert.strictEqual(getAllIndexRows().filter(x => x.id === orphan.getId()).length, 1); });
t('reindexMissing non duplica', () => { const before = getAllIndexRows().length; reindexMissing(); assert.strictEqual(getAllIndexRows().length, before); });

console.log('8. modello alternativo (Haiku) -> niente effort/fallbacks');
ss.getSheetByName('Config').rows.forEach(r => { if (r[0] === 'MODEL') r[1] = 'claude-haiku-4-5'; });
G.__http.length = 0; G.__httpHandler = () => claudeOk(bolletta);
G.__mkfile(inbox, 'Scan_haiku.pdf', pdfBytes, 'application/pdf'); processInbox();
t('richiesta per Haiku senza effort, fallbacks e header beta', () => { const req = G.__http[0]; const body = JSON.parse(req.opts.payload); assert.strictEqual(body.model, 'claude-haiku-4-5'); assert.strictEqual(body.output_config.effort, undefined); assert.strictEqual(body.fallbacks, undefined); assert.strictEqual(req.opts.headers['anthropic-beta'], undefined); });

console.log('\n' + passed + ' test superati' + (process.exitCode ? ', CI SONO FALLIMENTI' : ', nessun fallimento'));
console.log('\nEsempio di Indice (prime 4 righe):');
getAllIndexRows().slice(0, 4).forEach(r => console.log('  ' + [r.dataDocumento, r.categoria, r.sottocategoria, r.mittente, r.soggetti, r.stato, r.nomeFile].join(' | ')));
