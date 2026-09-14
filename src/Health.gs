/**
 * Health.gs - controllo di salute dell'archivio.
 *
 * Gira una volta al giorno insieme al rendiconto. Non manda niente se va tutto bene: scrive solo
 * quando qualcosa si è fermato, perché questo archivio deve funzionare per anni senza manutenzione.
 * Controlla: la coda di Inbox ferma, lo standby per il credito API, e il battito del Mac
 * (la raccolta notturna chiama l'azione "heartbeat" a fine giro: se manca da giorni, il Mac è spento
 * o il lavoro automatico si è rotto).
 */

var SALUTE_INBOX_ORE = 12;          // file fermi in Inbox da più di così = qualcosa non gira
var SALUTE_BATTITO_GIORNI = 4;      // giorni senza notizie dal Mac prima di avvisare

/** Registra che un lavoro sul Mac è arrivato in fondo. */
function registraBattito(nome, dettaglio) {
  var chiave = 'HEARTBEAT_' + String(nome || 'mac').replace(/[^a-z0-9_]/gi, '').substring(0, 30);
  getProps_().setProperty(chiave, JSON.stringify({ quando: new Date().toISOString(), dettaglio: String(dettaglio || '').substring(0, 200) }));
  return { registrato: true };
}

function leggiBattito_(nome) {
  try { return JSON.parse(getProps_().getProperty('HEARTBEAT_' + nome) || 'null'); } catch (e) { return null; }
}

/** @return {Array<string>} elenco dei problemi trovati (vuoto = tutto a posto) */
function controllaSalute() {
  var problemi = [];
  var ora = Date.now();

  var standbyFino = parseInt(getProps_().getProperty('API_STANDBY_UNTIL'), 10) || 0;
  if (standbyFino > ora) {
    problemi.push('La classificazione è in standby (credito API o chiave): riprende da sola appena il credito torna disponibile.');
  }

  try {
    var inbox = DriveApp.getFolderById(getProp_(PROP.INBOX_FOLDER_ID, true));
    var file = inbox.getFiles();
    var vecchi = 0, totale = 0;
    while (file.hasNext()) {
      var f = file.next();
      totale++;
      if (ora - f.getDateCreated().getTime() > SALUTE_INBOX_ORE * 3600 * 1000) vecchi++;
      if (totale > 500) break;
    }
    if (vecchi > 0 && standbyFino <= ora) {
      problemi.push(vecchi + ' documenti sono fermi in 00_Inbox da più di ' + SALUTE_INBOX_ORE + ' ore: controlla gli attivatori in Apps Script.');
    }
  } catch (e) {
    problemi.push('Non riesco a leggere la cartella 00_Inbox: ' + e.message);
  }

  var battito = leggiBattito_('raccolta');
  if (battito && battito.quando) {
    var giorni = Math.floor((ora - new Date(battito.quando).getTime()) / (24 * 3600 * 1000));
    if (giorni >= SALUTE_BATTITO_GIORNI) {
      problemi.push('La raccolta notturna sul Mac non dà notizie da ' + giorni + ' giorni: il Mac è spento oppure il lavoro automatico si è fermato.');
    }
  }

  return problemi;
}

/** Manda l'email solo se c'è davvero qualcosa che non va (al massimo una al giorno). */
function avvisaSeQualcosaNonVa() {
  var problemi = controllaSalute();
  if (!problemi.length) return false;
  var corpo = 'Controllo dell\'archivio di casa:\n\n- ' + problemi.join('\n- ') +
    '\n\nI documenti già archiviati non corrono alcun rischio: restano su Drive, nel foglio indice,' +
    '\nnell\'Excel di backup e nella copia su iCloud.';
  return sendAlertOnce('salute', 'Qualcosa si è fermato nell\'archivio', corpo);
}
