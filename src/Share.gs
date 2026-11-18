/**
 * Share.gs - chi può aprire i file dell'archivio su Google Drive.
 *
 * L'indice contiene il link a ogni documento, ma il link funziona solo per chi ha accesso al file.
 * Finora l'unico account con accesso era quello proprietario dell'archivio: aprendo il link da un
 * altro indirizzo si otteneva "Accesso negato", e il link restituito dal connettore MCP era inutile.
 *
 * Qui l'accesso viene dato una volta sola sulla cartella "Archivio": Drive lo eredita su tutti i file
 * che ci stanno dentro, quelli di ieri e quelli di domani. Restano da sistemare a mano solo i file
 * finiti fuori da quella cartella, che vengono cercati e corretti uno per uno.
 */

var CONDIVISIONE_RUOLO = 'reader';   // sola lettura: scrivere nell'archivio si fa dal sito
var CONDIVISIONE_KO = 'CONDIVISIONE_IMPOSSIBILI';   // indirizzi che Drive rifiuta (non sono account Google)

/** Gli indirizzi che devono poter aprire i documenti (foglio Config, con i soliti valori di riserva). */
function emailCondivisione_(cfg) {
  cfg = cfg || getConfig();
  return cfg.shareEmails;
}

function permessiCartella_(folderId) {
  var out = {};
  var pageToken = null;
  do {
    var res = Drive.Permissions.list(folderId, {
      fields: 'nextPageToken, permissions(id,emailAddress,role,type)',
      pageSize: 100, pageToken: pageToken || undefined, supportsAllDrives: true
    });
    (res.permissions || []).forEach(function (p) {
      if (p.emailAddress) out[String(p.emailAddress).toLowerCase()] = p;
    });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Scrive gli indirizzi nella riga SHARE_EMAILS del foglio Config, così restano anche dopo.
 * @param {Array<string>|string} emails
 */
function impostaIndirizziCondivisione_(emails) {
  var elenco = (Array.isArray(emails) ? emails : String(emails || '').split(','))
    .map(function (e) { return String(e).trim().toLowerCase(); }).filter(Boolean);
  var unici = elenco.filter(function (e, i) { return elenco.indexOf(e) === i; });
  if (!unici.length) throw new ApiError('bad_request', 'Nessun indirizzo da impostare');
  var sh = getSheet_(SHEET.CONFIG);
  var valori = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 2).getValues();
  for (var i = 0; i < valori.length; i++) {
    if (String(valori[i][0]).trim() === 'SHARE_EMAILS') {
      sh.getRange(i + 2, 2).setValue(unici.join(', '));
      return unici;
    }
  }
  sh.appendRow(['SHARE_EMAILS', unici.join(', '), 'Indirizzi che possono aprire e scaricare i file da Drive']);
  return unici;
}

/**
 * Toglie l'accesso alla cartella Archivio a uno o più indirizzi (e li leva da SHARE_EMAILS).
 * Serve quando un indirizzo non deve più vedere l'archivio: una casella di lavoro, un account chiuso.
 * @return {Array<{email:string, esito:string, dettaglio?:string}>}
 */
function revocaAccesso(emails, cfg) {
  cfg = cfg || getConfig();
  var folderId = getProp_(PROP.ARCHIVE_FOLDER_ID, true);
  var elenco = (Array.isArray(emails) ? emails : String(emails || '').split(','))
    .map(function (e) { return String(e).trim().toLowerCase(); }).filter(Boolean);
  if (!elenco.length) throw new ApiError('bad_request', 'Nessun indirizzo da togliere');
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var gia = permessiCartella_(folderId);

  var esiti = elenco.map(function (email) {
    if (email === owner) return { email: email, esito: 'non tolgo il proprietario' };
    var p = gia[email];
    if (!p) return { email: email, esito: 'non aveva accesso' };
    try {
      Drive.Permissions.remove(folderId, p.id, { supportsAllDrives: true });
      return { email: email, esito: 'accesso tolto' };
    } catch (e) {
      logEvent('WARN', '', 'Accesso non tolto a ' + email + ': ' + e.message);
      return { email: email, esito: 'non riuscito', dettaglio: e.message };
    }
  });

  // L'indirizzo esce anche dall'elenco di casa, altrimenti la prossima condivisione glielo ridà.
  var restano = emailCondivisione_(cfg).filter(function (e) { return elenco.indexOf(e) < 0; });
  if (restano.length) impostaIndirizziCondivisione_(restano);
  logEvent('INFO', '', 'Accessi tolti: ' + esiti.map(function (x) { return x.email + ' = ' + x.esito; }).join('; '));
  return { cartella: folderId, indirizzi: esiti, attesi: restano };
}

/**
 * Dà accesso in lettura alla cartella Archivio a tutti gli indirizzi di famiglia.
 * @return {{cartella:string, indirizzi:Array<{email:string, esito:string, dettaglio?:string}>}}
 */
function condividiArchivio(cfg, emails, rimuovi) {
  if (rimuovi && rimuovi.length) { revocaAccesso(rimuovi, cfg); cfg = null; }
  if (emails && emails.length) { impostaIndirizziCondivisione_(emails); cfg = null; }
  cfg = cfg || getConfig();
  var folderId = getProp_(PROP.ARCHIVE_FOLDER_ID, true);
  var emails = emailCondivisione_(cfg);
  if (!emails.length) throw new ApiError('config', 'Nessun indirizzo in SHARE_EMAILS (foglio Config)');
  var gia = permessiCartella_(folderId);
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();

  var esiti = emails.map(function (email) {
    if (email === owner) return { email: email, esito: 'proprietario' };
    var p = gia[email];
    if (p && (p.role === 'writer' || p.role === 'owner' || p.role === CONDIVISIONE_RUOLO)) {
      return { email: email, esito: 'già aveva accesso', dettaglio: p.role };
    }
    try {
      Drive.Permissions.create({ type: 'user', role: CONDIVISIONE_RUOLO, emailAddress: email }, folderId,
        { sendNotificationEmail: false, supportsAllDrives: true });
      return { email: email, esito: 'accesso aggiunto' };
    } catch (e) {
      // Succede con gli indirizzi che non sono account Google (es. outlook.com): Drive li rifiuta.
      logEvent('WARN', '', 'Accesso non concesso a ' + email + ': ' + e.message);
      return { email: email, esito: 'non riuscito', dettaglio: e.message };
    }
  });
  // Un indirizzo che non è un account Google non potrà mai avere accesso: me lo segno, così il
  // controllo di salute non manda un avviso identico ogni giorno per una cosa che non si può sistemare.
  var impossibili = esiti.filter(function (x) { return x.esito === 'non riuscito'; }).map(function (x) { return x.email; });
  getProps_().setProperty(CONDIVISIONE_KO, JSON.stringify(impossibili));
  logEvent('INFO', '', 'Condivisione archivio: ' + esiti.map(function (x) { return x.email + ' = ' + x.esito; }).join('; '));
  return { cartella: folderId, indirizzi: esiti, non_condivisibili: impossibili };
}

/**
 * Controlla che i documenti dell'Indice stiano davvero dentro la cartella Archivio (e quindi
 * ereditino l'accesso). Quelli fuori posto ricevono un permesso esplicito, se `sistema` è vero.
 * Ha un tetto di tempo perché su più di mille documenti una passata completa non sta in una richiesta.
 */
function verificaAccessiDocumenti(opts) {
  opts = opts || {};
  var cfg = getConfig();
  var emails = emailCondivisione_(cfg).filter(function (e) { return e !== String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); });
  var archiveId = getProp_(PROP.ARCHIVE_FOLDER_ID, true);
  var sistema = opts.sistema !== false;
  var budget = Math.min(300000, Math.max(10000, parseInt(opts.budgetMs, 10) || 120000));
  var inizio = Date.now();
  var da = Math.max(0, parseInt(opts.offset, 10) || 0);

  var righe = getAllIndexRows();
  var dentro = 0, fuori = 0, sistemati = 0, mancanti = 0, visti = 0;
  var problemi = [];
  for (var i = da; i < righe.length; i++) {
    if (Date.now() - inizio > budget) break;
    visti++;
    var d = righe[i];
    var info;
    try {
      info = Drive.Files.get(d.id, { fields: 'id,name,parents,trashed', supportsAllDrives: true });
    } catch (e) {
      mancanti++;
      problemi.push({ id: d.id, nome: d.nomeFile, problema: 'file non trovato su Drive' });
      continue;
    }
    if (info.trashed) {
      mancanti++;
      problemi.push({ id: d.id, nome: d.nomeFile, problema: 'file nel cestino' });
      continue;
    }
    if ((info.parents || []).indexOf(archiveId) >= 0) { dentro++; continue; }
    fuori++;
    if (!sistema) { problemi.push({ id: d.id, nome: d.nomeFile, problema: 'fuori dalla cartella Archivio' }); continue; }
    var ok = true;
    emails.forEach(function (email) {
      try {
        Drive.Permissions.create({ type: 'user', role: CONDIVISIONE_RUOLO, emailAddress: email }, d.id,
          { sendNotificationEmail: false, supportsAllDrives: true });
      } catch (e) { ok = false; }
    });
    if (ok) sistemati++;
    else problemi.push({ id: d.id, nome: d.nomeFile, problema: 'fuori dalla cartella e accesso non concesso' });
  }
  var prossimo = (da + visti < righe.length) ? da + visti : null;
  logEvent('INFO', '', 'Verifica accessi: ' + dentro + ' a posto, ' + fuori + ' fuori cartella (' + sistemati + ' sistemati), ' + mancanti + ' irreperibili');
  return { controllati: visti, dentro_cartella: dentro, fuori_cartella: fuori, sistemati: sistemati,
    irreperibili: mancanti, problemi: problemi.slice(0, 50), offset: da, next: prossimo, totale: righe.length };
}

/** Chi può aprire i documenti, come lo vede Drive adesso. */
function statoCondivisione(cfg) {
  cfg = cfg || getConfig();
  var folderId = getProp_(PROP.ARCHIVE_FOLDER_ID, true);
  var attuali = permessiCartella_(folderId);
  var attesi = emailCondivisione_(cfg);
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var impossibili;
  try { impossibili = JSON.parse(getProps_().getProperty(CONDIVISIONE_KO) || '[]'); } catch (e) { impossibili = []; }
  var senza = attesi.filter(function (e) { return e !== owner && !attuali[e]; });
  return {
    cartella: 'https://drive.google.com/drive/folders/' + folderId,
    proprietario: owner,
    attesi: attesi,
    con_accesso: Object.keys(attuali).map(function (e) { return { email: e, ruolo: attuali[e].role }; }),
    senza_accesso: senza,
    non_condivisibili: impossibili,
    da_sistemare: senza.filter(function (e) { return impossibili.indexOf(e) < 0; })
  };
}
