(function () {
  'use strict';
  var CFG = window.ARCHIVIO_CONFIG || {};
  var PAGE = 60;
  var TOKEN_KEY = 'archivio_token';
  var state = { token: null, user: null, docs: [], filtered: [], shown: 0, canEdit: false, categories: {}, family: [], current: null, meta: null, files: {}, history: [] };
  var $ = function (id) { return document.getElementById(id); };
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(msg, ms) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, ms || 2600); }
  function fmtDate(d) { var m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : String(d || ''); }

  // ---------- API ----------
  function api(action, payload) {
    var body = Object.assign({ action: action, token: state.token }, payload || {});
    return fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) {
          if (res.code === 'login_required') { logout('Sessione scaduta, accedi di nuovo.'); }
          var err = new Error(res.error || 'Errore'); err.code = res.code; throw err;
        }
        if (res.user) state.user = res.user;
        return res.data;
      });
  }

  // ---------- login ----------
  function saveToken(t) { state.token = t; try { sessionStorage.setItem(TOKEN_KEY, t); } catch (e) {} }
  function loadToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function logout(msg) {
    state.token = null; state.user = null; state.docs = []; state.files = {};
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (e) {}
    try { if (window.google && google.accounts) google.accounts.id.disableAutoSelect(); } catch (e) {}
    showLogin(msg || '');
  }
  function showLogin(msg) {
    $('viewApp').hidden = true; $('viewLogin').hidden = false;
    $('loginMsg').textContent = msg || '';
    if (!CFG.CLIENT_ID || !CFG.API_URL) { $('loginMsg').textContent = 'Sito non ancora configurato (config.js).'; return; }
    renderGsi();
  }
  function renderGsi() {
    if (!(window.google && google.accounts && google.accounts.id)) { setTimeout(renderGsi, 200); return; }
    google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: onCredential, auto_select: false, ux_mode: 'popup', itp_support: true });
    $('gsiButton').innerHTML = '';
    google.accounts.id.renderButton($('gsiButton'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', locale: 'it', width: 280 });
  }
  function onCredential(resp) {
    if (!resp || !resp.credential) return;
    saveToken(resp.credential);
    $('loginMsg').textContent = 'Accesso in corso…';
    enter();
  }
  function enter() {
    api('index').then(function (data) { onData(data); showApp(); })
      .catch(function (err) {
        if (err.code === 'forbidden') logout(err.message);
        else if (err.code !== 'login_required') { $('loginMsg').textContent = 'Errore: ' + err.message; }
      });
  }
  function showApp() {
    $('viewLogin').hidden = true; $('viewApp').hidden = false;
    var u = state.user || {};
    $('userName').textContent = u.name || u.email || '';
    if (u.picture) { $('avatar').src = u.picture; $('avatar').hidden = false; } else { $('avatar').hidden = true; }
    $('btnUpload').hidden = !state.canEdit;
  }

  // ---------- dati ----------
  function onData(data) {
    state.docs = (data.docs || []).map(prepareDoc);
    state.docs.sort(function (a, b) { return a.dataDocumento < b.dataDocumento ? 1 : a.dataDocumento > b.dataDocumento ? -1 : 0; });
    state.canEdit = !!(state.user && state.user.canEdit);
    state.categories = data.categories || {};
    state.family = data.family || [];
    $('sheetLink').href = data.sheetUrl || '#';
    $('archiveLink').href = data.archiveUrl || '#';
    buildFilters();
    applyFilters();
    if (state.current) { var cur = byId(state.current); if (cur) fillDetail(cur); }
  }
  function byId(id) { return state.docs.filter(function (d) { return d.id === id; })[0]; }
  function prepareDoc(d) {
    d.hay = norm([d.titolo, d.nomeFile, d.categoria, d.sottocategoria, d.sottoSottocategoria, d.tipoDocumento, d.mittente,
      d.destinatario, d.soggetti, d.riassunto, d.importo, d.dataDocumento, d.scadenza, d.nomeOriginale, d.paroleChiave].join(' | '));
    d.year = String(d.dataDocumento || '').substring(0, 4);
    d.soggettiList = String(d.soggetti || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return d;
  }

  // ---------- filtri ----------
  function fillSelect(sel, values, keepFirst) {
    var current = sel.value;
    while (sel.options.length > (keepFirst ? 1 : 0)) sel.remove(sel.options.length - 1);
    values.forEach(function (v) { var o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); });
    sel.value = values.indexOf(current) >= 0 ? current : '';
  }
  function uniq(arr) { var seen = {}; return arr.filter(function (v) { if (!v || seen[v]) return false; seen[v] = true; return true; }); }
  function buildFilters() {
    fillSelect($('fCat'), uniq(Object.keys(state.categories).concat(state.docs.map(function (d) { return d.categoria; }))), true);
    var subs = {};
    state.docs.forEach(function (d) { d.soggettiList.forEach(function (s) { subs[s] = (subs[s] || 0) + 1; }); });
    fillSelect($('fSub'), Object.keys(subs).sort(function (a, b) { return subs[b] - subs[a]; }), true);
    fillSelect($('fYear'), uniq(state.docs.map(function (d) { return d.year; })).sort().reverse(), true);
    fillSelect($('fStato'), uniq(state.docs.map(function (d) { return d.stato; })), true);
    if (state.docs.some(function (d) { return d.stato === 'Da verificare' || d.stato === 'Non classificato'; })) {
      var o = document.createElement('option'); o.value = '__check'; o.textContent = 'Da controllare (tutti)'; $('fStato').appendChild(o);
    }
  }
  function applyFilters() {
    var q = norm($('q').value).split(/\s+/).filter(Boolean);
    var cat = $('fCat').value, sub = $('fSub').value, year = $('fYear').value, stato = $('fStato').value;
    state.filtered = state.docs.filter(function (d) {
      if (cat && d.categoria !== cat) return false;
      if (sub && d.soggettiList.indexOf(sub) < 0) return false;
      if (year && d.year !== year) return false;
      if (stato === '__check') { if (d.stato !== 'Da verificare' && d.stato !== 'Non classificato') return false; }
      else if (stato && d.stato !== stato) return false;
      for (var i = 0; i < q.length; i++) if (d.hay.indexOf(q[i]) < 0) return false;
      return true;
    });
    state.shown = 0; $('list').innerHTML = ''; renderMore();
    var toCheck = state.docs.filter(function (d) { return d.stato === 'Da verificare' || d.stato === 'Non classificato'; }).length;
    var b = $('banner');
    b.hidden = !(toCheck && state.canEdit && !stato);
    if (!b.hidden) b.textContent = toCheck + (toCheck === 1 ? ' documento da verificare' : ' documenti da verificare') + ' · tocca per vederli';
    $('summary').textContent = state.filtered.length === state.docs.length ? state.docs.length + ' documenti in archivio' : state.filtered.length + ' di ' + state.docs.length + ' documenti';
  }
  function tagClass(stato) { return stato === 'Verificato' ? 'ok' : stato === 'Auto' ? '' : stato === 'Non classificato' ? 'bad' : 'warn'; }
  function renderMore() {
    var frag = document.createDocumentFragment();
    var slice = state.filtered.slice(state.shown, state.shown + PAGE);
    slice.forEach(function (d) {
      var li = document.createElement('li');
      li.className = 'card'; li.setAttribute('data-id', d.id);
      li.innerHTML = '<div class="t">' + esc(d.titolo || d.nomeFile) + '</div><div class="d">' + esc(fmtDate(d.dataDocumento)) + '</div>' +
        '<div class="s">' + (d.mittente ? '<b>' + esc(d.mittente) + '</b>' : '') + (d.soggettiList.length ? ' · ' + esc(d.soggettiList.join(', ')) : '') + '</div>' +
        '<div class="s"><span class="tag">' + esc(d.categoria) + (d.sottocategoria ? ' › ' + esc(d.sottocategoria) : '') + '</span>' +
        (d.stato && d.stato !== 'Auto' ? '<span class="tag ' + tagClass(d.stato) + '">' + esc(d.stato) + '</span>' : '') + '</div>';
      frag.appendChild(li);
    });
    $('list').appendChild(frag);
    state.shown += slice.length;
    $('more').hidden = state.shown >= state.filtered.length;
    $('empty').hidden = state.filtered.length > 0;
  }

  // ---------- scheda ----------
  function openDetail(id) {
    var d = byId(id); if (!d) return;
    state.current = id; fillDetail(d);
    $('editForm').hidden = true; $('overlay').hidden = false; $('detail').hidden = false; $('detail').scrollTop = 0;
    document.body.style.overflow = 'hidden';
    loadFile(d);
  }
  function closeDetail() {
    state.current = null; $('detail').hidden = true; $('overlay').hidden = true;
    $('dPreview').hidden = true; $('dPreview').src = 'about:blank'; document.body.style.overflow = '';
  }
  function fillDetail(d) {
    state.meta = d;
    $('dTitle').textContent = d.titolo || d.nomeFile;
    $('dBadges').innerHTML = '<span class="tag">' + esc(d.categoria) + (d.sottocategoria ? ' › ' + esc(d.sottocategoria) : '') + (d.sottoSottocategoria ? ' › ' + esc(d.sottoSottocategoria) : '') + '</span>' +
      '<span class="tag ' + tagClass(d.stato) + '">' + esc(d.stato || '') + (d.confidenza ? ' · ' + Math.round(parseFloat(String(d.confidenza).replace(',', '.')) * 100) + '%' : '') + '</span>';
    $('dDrive').href = d.link || ('https://drive.google.com/file/d/' + encodeURIComponent(d.id) + '/view');
    $('btnEdit').hidden = !state.canEdit;
    var rows = [['Data documento', fmtDate(d.dataDocumento)], ['Tipo', d.tipoDocumento], ['Mittente', d.mittente], ['Destinatario', d.destinatario],
      ['Persone', d.soggetti], ['Importo', d.importo], ['Scadenza', fmtDate(d.scadenza)], ['Riassunto', d.riassunto], ['Parole chiave', d.paroleChiave],
      ['Pagine', d.pagine], ['Scansionato il', d.dataScansione], ['Nome file', d.nomeFile]];
    $('dMeta').innerHTML = rows.filter(function (r) { return r[1] !== '' && r[1] != null; }).map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
  }
  function loadFile(d) {
    $('previewLoading').hidden = false; $('dPreview').hidden = true;
    $('dOpen').disabled = true; $('dDownload').removeAttribute('href');
    var ready = state.files[d.id] ? Promise.resolve(state.files[d.id]) : api('file', { id: d.id }).then(function (f) {
      var bin = atob(f.base64), arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      var url = URL.createObjectURL(new Blob([arr], { type: f.mime || 'application/pdf' }));
      state.files[d.id] = { url: url, name: f.name, mime: f.mime };
      return state.files[d.id];
    });
    ready.then(function (f) {
      if (state.current !== d.id) return;
      $('previewLoading').hidden = true;
      $('dPreview').src = f.url; $('dPreview').hidden = false;
      $('dOpen').disabled = false; $('dOpen').onclick = function () { window.open(f.url, '_blank'); };
      $('dDownload').href = f.url; $('dDownload').download = f.name || (d.nomeFile || 'documento.pdf');
    }).catch(function (err) {
      $('previewLoading').textContent = 'Anteprima non disponibile: ' + err.message + '. Usa "Su Drive".';
    });
  }

  // ---------- modifica ----------
  function startEdit() {
    var d = state.meta; if (!d) return;
    var f = $('editForm'), cat = $('eCat');
    fillSelect(cat, Object.keys(state.categories), false);
    if (Object.keys(state.categories).indexOf(d.categoria) < 0) { var o = document.createElement('option'); o.value = d.categoria; o.textContent = d.categoria; cat.appendChild(o); }
    cat.value = d.categoria; updateSubList();
    ['sottocategoria', 'sottoSottocategoria', 'tipoDocumento', 'mittente', 'destinatario', 'soggetti', 'dataDocumento', 'titolo', 'riassunto', 'importo', 'scadenza', 'paroleChiave']
      .forEach(function (k) { f.elements[k].value = d[k] || ''; });
    f.hidden = false; f.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function updateSubList() {
    var dl = $('subList'); dl.innerHTML = '';
    (state.categories[$('eCat').value] || []).forEach(function (s) { var o = document.createElement('option'); o.value = s; dl.appendChild(o); });
  }
  function saveEdit(ev) {
    ev.preventDefault();
    var f = $('editForm'), fields = {};
    Array.prototype.forEach.call(f.elements, function (el) { if (el.name) fields[el.name] = el.value; });
    var btn = f.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Salvo…';
    api('update', { id: state.current, fields: fields }).then(function (meta) {
      btn.disabled = false; btn.textContent = 'Salva';
      var idx = state.docs.findIndex(function (x) { return x.id === meta.id; });
      var prepared = prepareDoc(meta);
      if (idx >= 0) state.docs[idx] = prepared; else state.docs.push(prepared);
      f.hidden = true; fillDetail(prepared); buildFilters(); applyFilters();
      toast('Salvato: file rinominato e indice aggiornato');
    }).catch(function (err) { btn.disabled = false; btn.textContent = 'Salva'; toast('Errore: ' + err.message, 5000); });
  }

  // ---------- upload ----------
  function onFileChosen() {
    var file = $('fileInput').files[0]; if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('File troppo grande (max 25 MB)', 4000); return; }
    var reader = new FileReader();
    toast('Carico ' + file.name + '…', 60000);
    reader.onload = function () {
      api('upload', { data: String(reader.result).split(',')[1], name: file.name, mime: file.type || 'application/pdf' })
        .then(function (r) { toast('Caricato: ' + r.name + '. Verrà classificato entro pochi minuti.', 5000); $('fileInput').value = ''; })
        .catch(function (err) { toast('Errore upload: ' + err.message, 5000); $('fileInput').value = ''; });
    };
    reader.readAsDataURL(file);
  }

  // ---------- chiedi ----------
  function addMsg(role, text, docs) {
    var wrap = document.createElement('div'); wrap.className = 'msg ' + role;
    var b = document.createElement('div'); b.className = 'bubble' + (text === null ? ' thinking' : ''); b.textContent = text === null ? 'Cerco nei documenti…' : text;
    wrap.appendChild(b);
    if (docs && docs.length) {
      var chips = document.createElement('div'); chips.className = 'chips';
      docs.forEach(function (d) {
        var c = document.createElement('button'); c.className = 'chip doc'; c.textContent = (d.titolo || d.nomeFile) + ' · ' + fmtDate(d.dataDocumento);
        c.addEventListener('click', function () { openDetail(d.id); }); chips.appendChild(c);
      });
      wrap.appendChild(chips);
    }
    $('chat').appendChild(wrap); wrap.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return wrap;
  }
  function ask(q) {
    q = String(q || '').trim(); if (!q) return;
    $('askInput').value = ''; addMsg('user', q);
    var pending = addMsg('bot', null);
    $('askSend').disabled = true;
    api('ask', { question: q, history: state.history.slice(-6) }).then(function (r) {
      pending.remove();
      r.docs.forEach(function (d) { if (!byId(d.id)) state.docs.push(prepareDoc(d)); });
      addMsg('bot', r.answer || 'Non ho trovato nulla.', r.docs);
      state.history.push({ role: 'user', text: q }, { role: 'assistant', text: r.answer || '' });
    }).catch(function (err) { pending.remove(); addMsg('bot', 'Errore: ' + err.message); })
      .then(function () { $('askSend').disabled = false; });
  }

  // ---------- tabs ----------
  function showTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === name); });
    $('tabDocs').hidden = name !== 'docs'; $('tabAsk').hidden = name !== 'ask';
    $('btnUpload').hidden = !(state.canEdit && name === 'docs');
    if (name === 'ask') setTimeout(function () { $('askInput').focus(); }, 50);
  }

  // ---------- eventi ----------
  var debounce;
  $('q').addEventListener('input', function () { clearTimeout(debounce); debounce = setTimeout(applyFilters, 120); });
  ['fCat', 'fSub', 'fYear', 'fStato'].forEach(function (id) { $(id).addEventListener('change', applyFilters); });
  $('list').addEventListener('click', function (e) { var li = e.target.closest('li[data-id]'); if (li) openDetail(li.getAttribute('data-id')); });
  $('more').addEventListener('click', renderMore);
  $('banner').addEventListener('click', function () { $('fStato').value = '__check'; applyFilters(); });
  $('btnClose').addEventListener('click', closeDetail);
  $('overlay').addEventListener('click', closeDetail);
  $('btnEdit').addEventListener('click', startEdit);
  $('btnCancel').addEventListener('click', function () { $('editForm').hidden = true; });
  $('eCat').addEventListener('change', updateSubList);
  $('editForm').addEventListener('submit', saveEdit);
  $('btnUpload').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', onFileChosen);
  $('btnLogout').addEventListener('click', function () { logout('Sei uscito.'); });
  $('askForm').addEventListener('submit', function (e) { e.preventDefault(); ask($('askInput').value); });
  $('chat').addEventListener('click', function (e) { var c = e.target.closest('.chip[data-q]'); if (c) ask(c.getAttribute('data-q')); });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { showTab(t.getAttribute('data-tab')); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('detail').hidden) closeDetail(); });

  // ---------- avvio ----------
  var saved = loadToken();
  if (saved) { state.token = saved; enter(); } else { showLogin(''); }
})();
