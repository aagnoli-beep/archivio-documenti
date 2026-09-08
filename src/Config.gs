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
  { key: 'nomeOriginale', header: 'Nome originale' }
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
  ['BACKUP_KEEP', '12', 'Quanti export .xlsx tenere nella cartella Backup']
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
    categories: categories,
    categoryNames: Object.keys(categories)
  };
}
