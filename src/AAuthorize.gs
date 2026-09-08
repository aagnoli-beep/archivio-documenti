/**
 * AAuthorize.gs - prima funzione del primo file: e' quella proposta dall'editor.
 * Eseguila una volta nel nuovo progetto per concedere le autorizzazioni (non crea nulla).
 */
function authorizeAll() {
  DriveApp.getRootFolder().getName();
  UrlFetchApp.fetch('https://www.google.com');
  console.log('Autorizzato come ' + Session.getEffectiveUser().getEmail());
}
