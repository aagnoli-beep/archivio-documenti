/**
 * Config.gs - costanti, Script Properties e lettura del foglio Config/Categorie.
 *
 * Tutto ciò che Andrea può voler cambiare senza toccare il codice sta nel
 * foglio "Config" (chiave/valore) e nel foglio "Categorie".
 * Gli ID delle cartelle e del foglio vengono scritti nelle Script Properties da setupProject().
 */

var PROP = {
  ROOT_FOLDER_ID: 'ROOT_FOLDER_ID',
  INBOX_FOLDER_ID: 'INBOX_FOLDER_ID',
  ARCHIVE_FOLDER_ID: 'ARCHIVE_FOLDER_ID',
  BACKUP_FOLDER_ID: 'BACKUP_FOLDER_ID',
  SPREADSHEET_ID: 'SPREADSHEET_ID',
  ANTHROPIC_API_KEY: 'ANTHROPIC_API_KEY'
};

var SHEET = {
  INDEX: 'Indice',
  CONFIG: 'Config',
  CATEGORIES: 'Categorie',
  LOG: 'Log'
};

var FOLDER_NAMES = {
  ROOT: 'Archivio Documenti',
  INBOX: '00_Inbox',
  ARCHIVE: 'Archivio',
  BACKUP: 'Backup'
};

/** Colonne del foglio Indice, nell'ordine. Le chiavi sono usate nel codice e nella web app. */
var INDEX_COLUMNS = [
  { key: 'id', header: 'ID Drive' },
  { key: 'nomeFile', header: 'Nome file' },
  { key: 'link', header: 'Link' },
  { key: 'dataDocumento', header: 'Data documento' },
  { key: 'dataScansione', header: 'Data scansione' },
  { key: 'categoria', header: 'Categoria' },
  { key: 'sottocategoria', header: 'Sottocategoria' },
  { key: 'sottoSottocategoria', header: 'Sotto-sottocategoria' },
  { key: 'tipoDocumento', header: 'Tipo documento' },
  { key: 'mittente', header: 'Mittente' },
  { key: 'destinatario', header: 'Destinatario' },
  { key: 'soggetti', header: 'Soggetti' },
  { key: 'titolo', header: 'Titolo' },
  { key: 'riassunto', header: 'Riassunto' },
  { key: 'importo', header: 'Importo' },
  { key: 'scadenza', header: 'Scadenza' },
  { key: 'pagine', header: 'Pagine' },
  { key: 'confidenza', header: 'Confidenza' },
  { key: 'stato', header: 'Stato' },
  { key: 'nomeOriginale', header: 'Nome originale' },
  { key: 'paroleChiave', header: 'Parole chiave' }
];

var STATO = {
  AUTO: 'Auto',
  VERIFICATO: 'Verificato',
  DA_VERIFICARE: 'Da verificare',
  NON_CLASSIFICATO: 'Non classificato'
};

/** Valori di default del foglio Config (chiave, valore, descrizione). */
var DEFAULT_CONFIG = [
  ['ALERT_EMAIL', '', 'Email a cui mandare gli avvisi (vuoto = proprietario dello script)'],
  ['CONFIDENCE_THRESHOLD', '0.75', 'Sotto questa confidenza il documento finisce in "Da verificare"'],
  ['MODEL', 'claude-opus-5', 'Modello Claude usato per la classificazione'],
  ['EFFORT', 'low', 'Livello di effort (low/medium/high) per i modelli che lo supportano'],
  ['FAMILY', 'Andrea Agnoli, Serena', 'Nomi dei familiari, separati da virgola (aiutano a riconoscere i soggetti)'],
  ['MAX_PDF_MB', '20', 'Sopra questa dimensione il PDF viene letto via OCR di Drive invece che inviato intero'],
  ['MIN_FILE_AGE_SEC', '60', 'Secondi di attesa dopo l\'ultima modifica prima di processare un file (upload in corso)'],
  ['BACKUP_KEEP', '12', 'Quanti export .xlsx tenere nella cartella Backup'],
  ['GOOGLE_CLIENT_ID', '', 'Client ID OAuth di Google usato dal sito per "Accedi con Google"'],
  ['ALLOWED_EMAILS', '', 'Chi può entrare nel sito: email Google separate da virgola'],
  ['EDITOR_EMAILS', '', 'Chi può correggere i metadati e caricare documenti: email separate da virgola (vuoto = tutti gli ALLOWED)'],
  ['SITE_URL', '', 'Indirizzo del sito (GitHub Pages), usato per il redirect e nelle email'],
  ['DIGEST_EMAILS', '', 'Destinatari del rendiconto giornaliero dei documenti scansionati (email separate da virgola; vuoto = disattivato)'],
  ['DIGEST_HOUR', '20', 'Ora del rendiconto giornaliero (0-23)'],
  ['DIGEST_REPLY_TO', '', 'Indirizzo a cui vanno le risposte al rendiconto (il mittente resta l\'account Google dello script)'],
  ['DIGEST_SENDER_NAME', 'Archivio di casa', 'Nome del mittente mostrato nel rendiconto'],
  ['MAIL_INTAKE_ADDRESS', '', 'Indirizzo a cui inoltrare email e foto da archiviare (vuoto = <account>+archivio@gmail.com)'],
  ['MAIL_SENDERS', '', 'Mittenti ammessi per l\'ingresso via email (vuoto = ALLOWED_EMAILS + DIGEST_EMAILS + proprietario)']
];

/** Categorie iniziali: Categoria | Sottocategorie (separate da virgola). */
var DEFAULT_CATEGORIES = [
  ['Salute', 'Visita specialistica, Esami di laboratorio, Ricetta, Certificato medico, Vaccinazione, Ricovero, Farmacia, Dentista, Altro'],
  ['Casa', 'Affitto, Mutuo, Condominio, Manutenzione, Elettrodomestici, Arredamento, Contratti, Altro'],
  ['Utenze', 'Luce, Gas, Acqua, Internet-Telefono, Rifiuti, Altro'],
  ['Banca-Finanza', 'Estratto conto, Carta di credito, Investimenti, Prestito, Bonifico, Altro'],
  ['Assicurazioni', 'Auto, Casa, Vita, Salute, Viaggio, Altro'],
  ['Auto-Veicoli', 'Bollo, Revisione, Manutenzione, Multa, Libretto, Altro'],
  ['Lavoro', 'Busta paga, Contratto, CUD-CU, Ferie-Permessi, Rimborsi, Altro'],
  ['Fisco-Tasse', 'Dichiarazione redditi, IMU-TARI, Agenzia Entrate, F24, Altro'],
  ['Scuola-Figli', 'Iscrizione, Pagelle, Comunicazioni, Attivita sportive, Pediatra, Altro'],
  ['Acquisti-Garanzie', 'Scontrino, Fattura, Garanzia, Manuale, Altro'],
  ['Documenti-Identita', 'Carta identita, Passaporto, Patente, Tessera sanitaria, Codice fiscale, Altro'],
  ['Legale', 'Contratto, Atto notarile, Avvocato, Tribunale, Altro'],
  ['Viaggi', 'Prenotazione, Biglietto, Altro'],
  ['Altro', 'Altro']
];

function getProps_() {
  return PropertiesService.getScriptProperties();
}

function getProp_(key, required) {
  var v = getProps_().getProperty(key);
  if (!v && required) {
    throw new Error('Script Property mancante: ' + key + '. Esegui setupProject() (o imposta ' + key + ' nelle proprietà dello script).');
  }
  return v;
}

function getSpreadsheet_() {
  var id = getProp_(PROP.SPREADSHEET_ID, false);
  if (id) return SpreadsheetApp.openById(id);
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  throw new Error('Foglio indice non trovato: esegui setupProject().');
}

function getSheet_(name) {
  var sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Foglio "' + name + '" mancante: esegui setupProject().');
  return sh;
}

/**
 * Legge la configurazione completa: valori del foglio Config + categorie.
 * @return {{ alertEmail:string, confidenceThreshold:number, model:string, effort:string,
 *            family:string[], maxPdfBytes:number, minFileAgeMs:number, backupKeep:number,
 *            categories:Object<string,string[]>, categoryNames:string[] }}
 */
function getConfig() {
  var kv = {};
  DEFAULT_CONFIG.forEach(function (r) { kv[r[0]] = r[1]; });
  var sh = getSpreadsheet_().getSheetByName(SHEET.CONFIG);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
      if (r[0]) kv[String(r[0]).trim()] = String(r[1]).trim();
    });
  }
  var categories = {};
  var catSheet = getSpreadsheet_().getSheetByName(SHEET.CATEGORIES);
  var rows = (catSheet && catSheet.getLastRow() > 1)
    ? catSheet.getRange(2, 1, catSheet.getLastRow() - 1, 2).getValues()
    : DEFAULT_CATEGORIES;
  rows.forEach(function (r) {
    var name = String(r[0]).trim();
    if (!name) return;
    categories[name] = String(r[1] || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  });
  if (!Object.keys(categories).length) {
    DEFAULT_CATEGORIES.forEach(function (r) { categories[r[0]] = r[1].split(',').map(function (s) { return s.trim(); }); });
  }
  if (!categories['Altro']) categories['Altro'] = ['Altro'];

  return {
    alertEmail: kv.ALERT_EMAIL || Session.getEffectiveUser().getEmail(),
    confidenceThreshold: parseFloat(kv.CONFIDENCE_THRESHOLD) || 0.75,
    model: kv.MODEL || 'claude-opus-5',
    effort: kv.EFFORT || 'low',
    family: String(kv.FAMILY || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    maxPdfBytes: (parseFloat(kv.MAX_PDF_MB) || 20) * 1024 * 1024,
    minFileAgeMs: (parseInt(kv.MIN_FILE_AGE_SEC, 10) || 60) * 1000,
    backupKeep: parseInt(kv.BACKUP_KEEP, 10) || 12,
    googleClientId: kv.GOOGLE_CLIENT_ID || '',
    allowedEmails: splitEmails_(kv.ALLOWED_EMAILS),
    editorEmails: splitEmails_(kv.EDITOR_EMAILS),
    siteUrl: kv.SITE_URL || '',
    digestEmails: splitEmails_(kv.DIGEST_EMAILS),
    digestHour: Math.min(23, Math.max(0, parseInt(kv.DIGEST_HOUR, 10) || 20)),
    digestReplyTo: String(kv.DIGEST_REPLY_TO || '').trim(),
    digestSenderName: String(kv.DIGEST_SENDER_NAME || 'Archivio di casa').trim(),
    mailIntakeAddress: (kv.MAIL_INTAKE_ADDRESS || defaultIntakeAddress_()).toLowerCase(),
    mailSenders: (function () {
      var explicit = splitEmails_(kv.MAIL_SENDERS);
      if (explicit.length) return explicit;
      var all = splitEmails_(kv.ALLOWED_EMAILS).concat(splitEmails_(kv.DIGEST_EMAILS), [String(Session.getEffectiveUser().getEmail() || '').toLowerCase()]);
      return all.filter(function (e, i) { return e && all.indexOf(e) === i; });
    })(),
    categories: categories,
    categoryNames: Object.keys(categories)
  };
}

function splitEmails_(s) {
  return String(s || '').toLowerCase().split(/[,;\s]+/).map(function (e) { return e.trim(); }).filter(Boolean);
}

/** Aggiunge al foglio Config le chiavi mancanti (per aggiornamenti successivi al primo setup). */
function ensureConfigDefaults_() {
  var sh = getSpreadsheet_().getSheetByName(SHEET.CONFIG);
  if (!sh) return;
  var existing = {};
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { if (r[0]) existing[String(r[0]).trim()] = true; });
  DEFAULT_CONFIG.forEach(function (row) { if (!existing[row[0]]) sh.appendRow(row); });
}

/** <account>+archivio@dominio: alias Gmail che non richiede configurazione. */
function defaultIntakeAddress_() {
  var owner = String(Session.getEffectiveUser().getEmail() || '');
  var at = owner.indexOf('@');
  return at > 0 ? owner.substring(0, at) + '+archivio' + owner.substring(at) : '';
}
