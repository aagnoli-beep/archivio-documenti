/**
 * Alerts.gs - avvisi email con limite di una email al giorno per tipo di problema.
 */

/**
 * Manda un'email di avviso al massimo una volta al giorno per ogni "key".
 * @param {string} key identificatore del problema (es. "api_auth")
 * @param {string} subject
 * @param {string} body
 * @return {boolean} true se l'email è stata inviata
 */
function sendAlertOnce(key, subject, body) {
  var props = getProps_();
  var propKey = 'ALERT_SENT_' + key;
  var today = Utilities.formatDate(new Date(), 'Europe/Rome', 'yyyy-MM-dd');
  if (props.getProperty(propKey) === today) return false;
  var to = getConfig().alertEmail;
  MailApp.sendEmail({
    to: to,
    subject: '[Archivio Documenti] ' + subject,
    body: body + '\n\n— Questo avviso viene inviato al massimo una volta al giorno.\n' +
      'Foglio indice: ' + getSpreadsheet_().getUrl()
  });
  props.setProperty(propKey, today);
  return true;
}

/** Testo standard per i problemi con la chiave/credito Claude. */
function alertApiProblem(err) {
  var msg = 'La classificazione automatica dei documenti si è fermata.\n\n' +
    'Errore: ' + (err && err.message ? err.message : err) + '\n\n' +
    'Cosa fare:\n' +
    '1. Apri https://console.anthropic.com e controlla che la chiave API sia valida e che ci sia credito.\n' +
    '2. Se serve, aggiorna la Script Property ANTHROPIC_API_KEY nell\'editor Apps Script.\n\n' +
    'I documenti scansionati NON sono persi: restano nella cartella 00_Inbox e verranno ' +
    'classificati automaticamente appena il problema è risolto.';
  return sendAlertOnce('api_problem', 'Classificazione ferma: controlla chiave API / credito', msg);
}
