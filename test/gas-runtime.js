/* Ambiente Google Apps Script simulato (Drive, Sheets, UrlFetch, trigger, email) per eseguire src/*.gs in Node: `npm test` */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const G = globalThis;
G.__props = {};
G.__mail = [];
G.__http = [];           // richieste registrate
G.__httpHandler = null;  // function(url, opts) -> {code, body}
G.__triggers = [];
G.__docs = {};           // id -> testo (DocumentApp)
let idSeq = 1;
const newId = (p) => p + '_' + (idSeq++);

// ---------- Drive ----------
const nodes = {};   // id -> node
class Blob {
  constructor(bytes, mime, name) { this.bytes = bytes; this.mime = mime; this.name = name; }
  getBytes() { return this.bytes; } getName() { return this.name; } setName(n) { this.name = n; return this; }
  getContentType() { return this.mime; }
}
class Node {
  constructor(kind, name, parent) {
    this.id = newId(kind); this.kind = kind; this.name = name; this.parent = parent; this.trashed = false;
    this.created = new Date(Date.now() - 3600 * 1000); this.updated = this.created; this.description = ''; this.appProperties = {};
    if (kind === 'folder') this.children = [];
    nodes[this.id] = this;
    if (parent) parent.children.push(this);
  }
  getId() { return this.id; } getName() { return this.name; } isTrashed() { return this.trashed; }
  getUrl() { return 'https://drive.google.com/' + this.kind + '/' + this.id; }
  setTrashed(v) { this.trashed = v; return this; }
  getParents() { const p = this.parent ? [this.parent] : []; return iter(p); }
  // folder
  createFolder(n) { return new Node('folder', n, this); }
  getFoldersByName(n) { return iter(this.children.filter(c => c.kind === 'folder' && c.name === n && !c.trashed)); }
  getFilesByName(n) { return iter(this.children.filter(c => c.kind === 'file' && c.name === n && !c.trashed)); }
  getFiles() { return iter(this.children.filter(c => c.kind === 'file' && !c.trashed).slice()); }
  createFile(blob) { const f = new Node('file', blob.getName(), this); f.blob = blob; f.created = new Date(); f.updated = new Date(); return f; }
  // file
  setName(n) { this.name = n; return this; } getMimeType() { return this.blob ? this.blob.mime : 'application/octet-stream'; }
  getSize() { return this.blob ? this.blob.bytes.length : 0; } getBlob() { return this.blob; }
  getLastUpdated() { return this.updated; } getDateCreated() { return this.created; }
  getDescription() { return this.description; }
  moveTo(folder) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = folder; folder.children.push(this); return this; }
}
function iter(arr) { let i = 0; return { hasNext: () => i < arr.length, next: () => arr[i++] }; }
const root = new Node('folder', 'Il mio Drive', null);
G.DriveApp = {
  getRootFolder: () => root,
  getFolderById: (id) => { const n = nodes[id]; if (!n || n.kind !== 'folder') throw new Error('Folder not found ' + id); return n; },
  getFileById: (id) => { const n = nodes[id]; if (!n || n.kind !== 'file') throw new Error('File not found ' + id); return n; }
};
G.Drive = { Files: {
  update: (res, id) => { const n = nodes[id]; if (!n) throw new Error('404'); if (res.description !== undefined) n.description = res.description; if (res.appProperties) n.appProperties = res.appProperties; return { id }; },
  copy: (res, id) => { const src = nodes[id]; const doc = new Node('file', res.name, root); doc.blob = new Blob([], res.mimeType, res.name); G.__docs[doc.id] = 'TESTO OCR DI ' + src.name + ': ' + 'Referto visita cardiologica. Paziente Andrea Agnoli. Dott. Mario Rossi. 12/03/2026.'; return { id: doc.id }; },
  get: (id, opts) => { const n = nodes[id]; if (!n) throw new Error('404'); return { appProperties: n.appProperties, capabilities: { canEdit: G.__canEdit !== false } }; },
  remove: (id) => { const n = nodes[id]; if (n) { n.trashed = true; n.parent.children = n.parent.children.filter(c => c !== n); delete nodes[id]; } }
} };
G.DocumentApp = { openById: (id) => ({ getBody: () => ({ getText: () => G.__docs[id] || '' }) }) };
G.__mkfile = (folder, name, bytes, mime, ageMs) => { const f = folder.createFile(new Blob(bytes, mime, name)); const t = new Date(Date.now() - (ageMs == null ? 600000 : ageMs)); f.created = t; f.updated = t; return f; };
G.__nodes = nodes;

// ---------- Spreadsheet ----------
class Range {
  constructor(sheet, r, c, nr, nc) { this.s = sheet; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = this.s.rows[this.r - 1 + i] || []; const o = []; for (let j = 0; j < this.nc; j++) o.push(row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j]); out.push(o); } return out; }
  setValues(v) { for (let i = 0; i < v.length; i++) { while (this.s.rows.length < this.r + i) this.s.rows.push([]); const row = this.s.rows[this.r - 1 + i]; for (let j = 0; j < v[i].length; j++) row[this.c - 1 + j] = v[i][j]; } return this; }
  setFontWeight() { return this; } createFilter() { this.s.filter = true; return this; }
}
class Sheet {
  constructor(ss, name) { this.ss = ss; this.name = name; this.rows = []; this.filter = null; }
  getName() { return this.name; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr || 1, nc || 1); }
  getLastRow() { let n = this.rows.length; while (n > 0 && !(this.rows[n - 1] || []).some(v => v !== '' && v !== undefined)) n--; return n; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  appendRow(v) { this.rows.push(v.slice()); return this; }
  deleteRows(start, n) { this.rows.splice(start - 1, n); }
  setFrozenRows() { return this; } getFilter() { return this.filter; } autoResizeColumns() { return this; }
}
class Spreadsheet {
  constructor(name) { this.id = newId('ss'); this.name = name; this.sheets = [new Sheet(this, 'Foglio1')]; const f = new Node('file', name, root); f.id = this.id; nodes[this.id] = f; delete nodes[Object.keys(nodes).find(k => nodes[k] === f && k !== this.id)]; this.file = f; }
  getId() { return this.id; } getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(this, n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); } deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
}
const spreadsheets = {};
G.SpreadsheetApp = {
  getActiveSpreadsheet: () => null,
  create: (name) => { const ss = new Spreadsheet(name); spreadsheets[ss.id] = ss; return ss; },
  openById: (id) => { const ss = spreadsheets[id]; if (!ss) throw new Error('Spreadsheet not found ' + id); return ss; }
};

// ---------- servizi vari ----------
G.PropertiesService = { getScriptProperties: () => ({
  getProperty: (k) => (k in G.__props ? G.__props[k] : null),
  setProperty: (k, v) => { G.__props[k] = String(v); }, setProperties: (o) => { Object.keys(o).forEach(k => G.__props[k] = String(o[k])); },
  deleteProperty: (k) => { delete G.__props[k]; }
}) };
G.MimeType = { PDF: 'application/pdf', JPEG: 'image/jpeg', PNG: 'image/png' };
G.Utilities = {
  formatDate: (d, tz, fmt) => { const p = (n) => String(n).padStart(2, '0'); const s = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; return fmt.indexOf('HH') >= 0 ? s + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) : s; },
  base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
  base64Decode: (s) => Array.from(Buffer.from(s, 'base64')),
  sleep: () => {},
  newBlob: (bytes, mime, name) => new Blob(bytes, mime, name)
};
G.UrlFetchApp = { fetch: (url, opts) => {
  G.__http.push({ url, opts });
  const r = G.__httpHandler(url, opts);
  return { getResponseCode: () => r.code, getContentText: () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), getBlob: () => new Blob(r.bytes || [1, 2, 3], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'export.xlsx') };
} };
G.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
G.ScriptApp = {
  WeekDay: { MONDAY: 'MONDAY' },
  getProjectTriggers: () => G.__triggers.slice(),
  deleteTrigger: (t) => { G.__triggers = G.__triggers.filter(x => x !== t); },
  newTrigger: (fn) => { const t = { getHandlerFunction: () => fn, spec: [] }; const b = { timeBased: () => b, everyMinutes: (n) => { t.spec.push('every ' + n + ' min'); return b; }, onWeekDay: (d) => { t.spec.push(d); return b; }, everyDays: (n) => { t.spec.push('every ' + n + ' day'); return b; }, atHour: (h) => { t.spec.push('at ' + h); return b; }, create: () => { G.__triggers.push(t); return t; } }; return b; },
  getOAuthToken: () => 'tok'
};
G.MailApp = { sendEmail: (m) => { G.__mail.push(m); } };
G.Session = { getActiveUser: () => ({ getEmail: () => G.__user || 'serena@example.com' }), getEffectiveUser: () => ({ getEmail: () => 'andrea@example.com' }) };
G.HtmlService = { createTemplateFromFile: () => ({ evaluate: () => ({ setTitle() { return this; }, addMetaTag() { return this; }, setXFrameOptionsMode() { return this; } }) }), createHtmlOutputFromFile: () => ({ getContent: () => '' }), XFrameOptionsMode: { ALLOWALL: 1 } };

// carica i sorgenti
const SRC = process.env.SRC || path.join(__dirname, '..', 'src');
for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.gs'))) vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
module.exports = { root, nodes, Blob };
