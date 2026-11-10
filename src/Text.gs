/**
 * Text.gs - testo integrale dei documenti.
 *
 * L'Indice contiene solo le schede (titolo, riassunto, parole chiave). Per domande come
 * "quanto pesavo nel 2020" serve invece il testo scritto dentro al PDF. Qui c'e':
 *  - l'estrazione del testo con l'OCR di Drive (lo stesso usato dal classificatore);
 *  - una copia del testo in Drive (cartella "Testi", un .txt per documento) per non rifare l'OCR;
 *  - la ricerca a testo pieno appoggiata all'indice di Google Drive, limitata ai documenti dell'archivio;
 *  - gli estratti, cioe' le righe intorno alle parole cercate.
 *
 * L'OCR di un documento richiede qualche secondo, quindi ogni funzione ha un tetto di tempo:
 * meglio rispondere con quello che si ha che far scadere la richiesta.
 */

var TESTO_CHUNK_DEFAULT = 15000;   // caratteri per risposta (il web app di Google rifiuta risposte grandi)
var TESTO_CHUNK_MAX = 40000;
var TESTO_MAX_CHARS = 400000;      // oltre questo il testo viene troncato nella copia salvata
var TESTO_ESTRAI_MAX = 6;          // quanti documenti al massimo si possono OCR-izzare in una ricerca
var TESTO_BUDGET_MS = 150000;      // tetto di tempo per una singola chiamata

/** Cartella "Testi" (creata alla prima occorrenza): contiene un .txt per documento. */
function getTestiFolder_() {
  var id = getProp_(PROP.TESTI_FOLDER_ID, false);
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* cartella cancellata: la ricreo */ }
  }
  var root = DriveApp.getFolderById(getProp_(PROP.ROOT_FOLDER_ID, true));
  var it = root.getFoldersByName(FOLDER_NAMES.TEXTS);
  var folder = it.hasNext() ? it.next() : root.createFolder(FOLDER_NAMES.TEXTS);
  getProps_().setProperty(PROP.TESTI_FOLDER_ID, folder.getId());
  return folder;
}

function testoCacheGet_(fileId) {
  try {
    var it = getTestiFolder_().getFilesByName(fileId + '.txt');
    if (!it.hasNext()) return null;
    return it.next().getBlob().getDataAsString('UTF-8');
  } catch (e) {
    return null;
  }
}

function testoCachePut_(fileId, testo) {
  try {
    var folder = getTestiFolder_();
    var it = folder.getFilesByName(fileId + '.txt');
    while (it.hasNext()) it.next().setTrashed(true);
    folder.createFile(Utilities.newBlob(String(testo).substring(0, TESTO_MAX_CHARS), 'text/plain', fileId + '.txt'));
  } catch (e) {
    logEvent('WARN', fileId, 'Testo non salvato in cache: ' + e.message);
  }
}

/** Estrae il testo di un documento: .txt diretto, tutto il resto via OCR/conversione di Drive. */
function estraiTesto_(file) {
  var mime = String(file.getMimeType() || '');
  if (/^text\//.test(mime) || /\.(txt|md|csv)$/i.test(file.getName())) {
    return file.getBlob().getDataAsString('UTF-8');
  }
  return ocrTextViaDrive(file);
}

/**
 * Testo di un documento dell'archivio, a pezzi.
 * @return {{id, nome, caratteri, offset, length, more, origine, testo}}
 */
function getTesto(fileId, opts) {
  opts = opts || {};
  var meta = getIndexRow(fileId);
  if (!meta) throw new ApiError('not_found', 'Documento non trovato');
  var testo = testoCacheGet_(fileId);
  var origine = 'copia salvata';
  if (testo === null) {
    try {
      testo = estraiTesto_(DriveApp.getFileById(fileId));
    } catch (e) {
      throw new ApiError('no_text', 'Testo non estraibile da questo documento: ' + e.message);
    }
    origine = 'OCR appena fatto';
    testoCachePut_(fileId, testo);
  }
  testo = String(testo || '');
  var offset = Math.max(0, parseInt(opts.offset, 10) || 0);
  var quanti = Math.min(TESTO_CHUNK_MAX, Math.max(1, parseInt(opts.length, 10) || TESTO_CHUNK_DEFAULT));
  var fetta = testo.substring(offset, offset + quanti);
  return {
    id: fileId, nome: meta.nomeFile, titolo: meta.titolo, dataDocumento: meta.dataDocumento,
    caratteri: testo.length, offset: offset, length: fetta.length,
    more: offset + fetta.length < testo.length,
    next: (offset + fetta.length < testo.length) ? offset + fetta.length : null,
    origine: origine, testo: fetta
  };
}

/** Minuscole senza accenti mantenendo la stessa lunghezza, per poter tagliare gli estratti sul testo originale. */
var TESTO_ACCENTI = { 'à': 'a', 'á': 'a', 'â': 'a', 'ä': 'a', 'å': 'a', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e', 'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ò': 'o', 'ó': 'o', 'ô': 'o', 'ö': 'o', 'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u', 'ç': 'c', 'ñ': 'n' };
function normStessaLunghezza_(s) {
  return String(s || '').toLowerCase().replace(/[^\u0000-\u007f]/g, function (c) { return TESTO_ACCENTI[c] || c; });
}

function termini_(query) {
  return normStessaLunghezza_(query).replace(/[^a-z0-9%.,\s]/g, ' ').split(/\s+/)
    .filter(function (t) { return t.length > 2; })
    .filter(function (t, i, a) { return a.indexOf(t) === i; })
    .slice(0, 6);
}

/**
 * Righe intorno alle parole cercate. Restituisce al massimo `max` estratti, senza sovrapposizioni.
 */
function estrattiDaTesto_(testo, parole, max) {
  testo = String(testo || '');
  var hay = normStessaLunghezza_(testo);
  var prima = 160, dopo = 220;
  var punti = [];
  parole.forEach(function (t) {
    var da = 0, trovati = 0;
    while (trovati < 3) {
      var p = hay.indexOf(t, da);
      if (p < 0) break;
      punti.push({ pos: p, len: t.length });
      da = p + t.length;
      trovati++;
    }
  });
  punti.sort(function (a, b) { return a.pos - b.pos; });
  var out = [], fineUltimo = -1;
  for (var i = 0; i < punti.length && out.length < (max || 4); i++) {
    var p = punti[i];
    if (p.pos < fineUltimo) continue;                       // già dentro l'estratto precedente
    var da2 = Math.max(0, p.pos - prima);
    var a2 = Math.min(testo.length, p.pos + p.len + dopo);
    var pezzo = testo.substring(da2, a2).replace(/\s+/g, ' ').trim();
    out.push((da2 > 0 ? '…' : '') + pezzo + (a2 < testo.length ? '…' : ''));
    fineUltimo = a2;
  }
  return out;
}

/** ID dei file dell'archivio che contengono le parole cercate, secondo l'indice di Google Drive. */
function idPerTestoPieno_(query, noti) {
  var parole = termini_(query);
  var frasi = [String(query || '').trim()].concat(parole.length > 1 ? parole : []);
  var punteggio = {};
  frasi.forEach(function (frase, i) {
    if (!frase) return;
    var v = String(frase).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    var pageToken = null, pagine = 0;
    do {
      var res;
      try {
        res = Drive.Files.list({
          q: "fullText contains '" + v + "' and trashed = false",
          fields: 'nextPageToken, files(id)',
          pageSize: 100, pageToken: pageToken || undefined,
          supportsAllDrives: true, includeItemsFromAllDrives: true
        });
      } catch (e) {
        logEvent('WARN', '', 'Ricerca a testo pieno non riuscita per "' + frase + '": ' + e.message);
        return;
      }
      (res.files || []).forEach(function (f) {
        if (!noti[f.id]) return;                            // solo documenti dell'archivio
        punteggio[f.id] = (punteggio[f.id] || 0) + (i === 0 ? 3 : 1);
      });
      pageToken = res.nextPageToken;
      pagine++;
    } while (pageToken && pagine < 3);
  });
  return Object.keys(punteggio).sort(function (a, b) { return punteggio[b] - punteggio[a]; })
    .map(function (id) { return { id: id, punteggio: punteggio[id] }; });
}

/**
 * Ricerca nel testo dei documenti (non solo nelle schede): usa l'indice di Google Drive per trovare
 * i candidati e poi ritaglia gli estratti dal testo, facendo l'OCR al massimo di TESTO_ESTRAI_MAX documenti.
 * @return {{total, estratti_mancanti, docs: Array<meta & {estratti: string[]}>}}
 */
function cercaTestoPieno(query, opts) {
  opts = opts || {};
  query = String(query || '').trim();
  if (!query) throw new ApiError('bad_request', 'Scrivi che cosa cercare.');
  var limite = Math.min(50, Math.max(1, parseInt(opts.limit, 10) || 10));
  var daEstrarre = Math.min(TESTO_ESTRAI_MAX, Math.max(0, opts.estrai === undefined ? TESTO_ESTRAI_MAX : parseInt(opts.estrai, 10)));
  var inizio = Date.now();

  var tutte = getAllIndexRows();
  var byId = {};
  tutte.forEach(function (d) { byId[d.id] = d; });
  var trovati = idPerTestoPieno_(query, byId);

  var parole = termini_(query);
  var docs = [], estrattiMancanti = 0, estratti = 0;
  trovati.slice(0, limite).forEach(function (x) {
    var d = byId[x.id];
    var testo = testoCacheGet_(x.id);
    if (testo === null && estratti < daEstrarre && Date.now() - inizio < TESTO_BUDGET_MS) {
      try {
        testo = estraiTesto_(DriveApp.getFileById(x.id));
        testoCachePut_(x.id, testo);
        estratti++;
      } catch (e) {
        testo = null;
      }
    }
    if (testo === null) estrattiMancanti++;
    docs.push(Object.assign({}, d, { estratti: testo === null ? [] : estrattiDaTesto_(testo, parole, 4) }));
  });
  logEvent('INFO', '', 'Ricerca nel testo "' + query.substring(0, 80) + '": ' + trovati.length + ' documenti, ' + estratti + ' OCR nuovi');
  return { total: trovati.length, estratti_mancanti: estrattiMancanti, docs: docs, query: query };
}

/**
 * Prepara la copia del testo per un gruppo di documenti (per ID, o per categoria/anno), entro un tetto di tempo.
 * Serve a rendere istantanee le ricerche nel testo su una parte dell'archivio senza consumare
 * la quota giornaliera di Apps Script tutta in una volta.
 */
function indicizzaTesti(opts) {
  opts = opts || {};
  var budget = Math.min(300000, Math.max(10000, parseInt(opts.budgetMs, 10) || TESTO_BUDGET_MS));
  var inizio = Date.now();
  var elenco;
  if (opts.ids && opts.ids.length) {
    var byId = {};
    getAllIndexRows().forEach(function (d) { byId[d.id] = d; });
    elenco = opts.ids.map(function (id) { return byId[String(id)]; }).filter(Boolean);
  } else {
    elenco = getAllIndexRows().filter(function (d) {
      if (opts.categoria && String(d.categoria) !== String(opts.categoria)) return false;
      if (opts.anno && String(d.dataDocumento || '').substring(0, 4) !== String(opts.anno)) return false;
      return true;
    });
    elenco.sort(function (a, b) { return a.dataScansione < b.dataScansione ? 1 : -1; });
  }
  var fatti = 0, gia = 0, falliti = 0, visti = 0;
  for (var i = 0; i < elenco.length; i++) {
    if (Date.now() - inizio > budget) break;
    visti++;
    var d = elenco[i];
    if (testoCacheGet_(d.id) !== null) { gia++; continue; }
    try {
      testoCachePut_(d.id, estraiTesto_(DriveApp.getFileById(d.id)));
      fatti++;
    } catch (e) {
      falliti++;
      logEvent('WARN', d.nomeFile, 'Testo non estraibile: ' + e.message);
    }
  }
  var rimasti = elenco.length - visti;
  logEvent('INFO', '', 'Indicizzazione testi: ' + fatti + ' nuovi, ' + gia + ' già fatti, ' + falliti + ' non estraibili, ' + rimasti + ' da fare');
  return { nuovi: fatti, gia_presenti: gia, non_estraibili: falliti, rimasti: rimasti, totale: elenco.length };
}

/** Salva la copia del testo di un documento appena archiviato. Non deve mai bloccare la pipeline. */
function salvaTestoSePossibile_(fileId) {
  try {
    if (testoCacheGet_(fileId) !== null) return;
    testoCachePut_(fileId, estraiTesto_(DriveApp.getFileById(fileId)));
  } catch (e) {
    logEvent('WARN', fileId, 'Testo non estratto all\'archiviazione: ' + e.message);
  }
}
