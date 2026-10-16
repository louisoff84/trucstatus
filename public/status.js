// Page de status publique (page principale "/" ou page dédiée "/s/<slug>")
const PAGE = (location.pathname.match(/^\/s\/([a-z0-9-]+)/i) || [])[1] || null;
const q = PAGE ? '?page=' + encodeURIComponent(PAGE) : '';
let state = null;
let lastUpdate = Date.now();
let es = null;

function incidentHTML(i) {
  const resolved = i.status === 'resolved';
  const ups = (i.updates || []).slice().reverse();
  let win = '';
  if (i.severity === 'maintenance' && (i.startsAt || i.endsAt)) {
    win = `<div class="when" style="margin-top:4px">🗓️ ${i.startsAt ? fmtDate(i.startsAt) : '…'} → ${i.endsAt ? fmtDate(i.endsAt) : '…'}</div>`;
  }
  const affected = (i.monitorIds || []).map((id) => state.monitors.find((m) => m.id === id)).filter(Boolean).map((m) => esc(m.name));
  return `<div class="card incident ${resolved ? 'resolved' : esc(i.severity)}">
    <h3>${esc(i.title)} <span class="pill ${resolved ? 's1' : i.severity === 'maintenance' ? 's3' : i.severity === 'danger' ? 's0' : 's2'}">${esc(INC_STATUS[i.status] || i.status)}</span></h3>
    ${win}
    ${affected.length ? `<div class="when" style="margin-top:4px">Services concernés : ${affected.join(', ')}</div>` : ''}
    ${ups.map((u) => `<div class="upd"><b>${esc(INC_STATUS[u.status] || u.status)}</b> — <span class="when">${fmtDate(u.at)}</span><p>${esc(u.text)}</p></div>`).join('')}
  </div>`;
}

function pingText(m) {
  return m.ping != null && (m.status === 1 || m.status === 4) ? m.ping + ' ms' : '';
}

function svcHTML(m) {
  const mc = m.mc;
  return `<div class="svc" data-id="${m.id}">
    <div class="svc-top">
      <div class="svc-name"><span class="dot s${m.status}"></span><span>${esc(m.name)}</span></div>
      <div style="display:flex;gap:10px;align-items:center">
        ${mc ? `<span class="chip" title="Joueurs connectés">👥 ${mc.online}/${mc.max}</span>` : ''}
        <span class="muted small hide-sm ping">${pingText(m)}</span>
        <span class="pill s${m.status}">${STATUS_LABEL[m.status]}</span>
      </div>
    </div>
    ${m.description ? `<div class="svc-desc">${esc(m.description)}</div>` : ''}
    ${mc && mc.motd ? `<div class="svc-desc">${esc(mc.motd)}${mc.version ? ` · <span class="muted">${esc(mc.version)}</span>` : ''}</div>` : ''}
    <div class="bars d90">${dayBarsHTML(m.bars)}</div>
    <div class="svc-meta"><span><span class="hide-sm">Il y a </span>90 jours</span><span><b>${fmtPct(m.uptime90)}</b> de disponibilité</span><span>Aujourd'hui</span></div>
    ${m.players24 && m.players24.some((v) => v != null) ? `<div class="players"><span>Joueurs (24 h)</span>${sparklineSVG(m.players24)}<b>max ${Math.max(...m.players24.filter((v) => v != null))}</b></div>` : ''}
  </div>`;
}

function render() {
  const s = state;
  document.title = s.title;
  $('#title').textContent = s.title;
  $('#desc').textContent = s.description || '';
  if (s.logoUrl) { $('#logo').src = s.logoUrl; $('#logo').classList.remove('hidden'); }
  $('#footer-text').textContent = s.footer || '';

  if (s.setup) {
    $('#overall').className = 'overall empty';
    $('#overall').innerHTML = `<div class="ic">⚙️</div><div>Bienvenue ! <small>Rends-toi sur <a href="/admin">/admin</a> pour créer ton compte et ajouter tes premiers services.</small></div>`;
  } else {
    const ms = s.monitors;
    const down = ms.filter((m) => m.status === 0).length;
    const degraded = ms.filter((m) => m.status === 4).length;
    const maint = ms.filter((m) => m.status === 3).length;
    const activeInc = s.incidents.filter((i) => i.status !== 'resolved' && i.severity !== 'maintenance' && i.severity !== 'info');
    let cls = 'ok', ic = '✓', txt = 'Tous les systèmes sont opérationnels';
    if (!ms.length) { cls = 'empty'; ic = '…'; txt = 'Aucun service surveillé pour le moment'; }
    else if (ms.every((m) => m.status === 2)) { cls = 'empty'; ic = '…'; txt = 'Vérification des services en cours…'; }
    else if (down && down >= Math.ceil(ms.length / 2)) { cls = 'major'; ic = '!'; txt = 'Panne majeure en cours'; }
    else if (down || activeInc.some((i) => i.severity === 'danger')) { cls = 'partial'; ic = '!'; txt = down ? `Perturbation partielle — ${down} service${down > 1 ? 's' : ''} hors ligne` : 'Incident en cours'; }
    else if (degraded || activeInc.length) { cls = 'degraded'; ic = '!'; txt = degraded ? `Performances dégradées — ${degraded} service${degraded > 1 ? 's' : ''} ralenti${degraded > 1 ? 's' : ''}` : 'Certains services sont dégradés'; }
    else if (maint) { cls = 'maint'; ic = '🔧'; txt = 'Maintenance en cours'; }
    $('#overall').className = 'overall ' + cls;
    $('#overall').innerHTML = `<div class="ic">${ic}</div><div>${txt}<small>${ms.length} service${ms.length > 1 ? 's' : ''} surveillé${ms.length > 1 ? 's' : ''}</small></div>`;
  }

  const active = s.incidents.filter((i) => i.status !== 'resolved');
  $('#incidents').innerHTML = active.length ? `<div class="section-title">Incidents & maintenances en cours</div>` + active.map(incidentHTML).join('') : '';

  const groups = {};
  for (const m of s.monitors) (groups[m.group || 'Services'] ||= []).push(m);
  $('#groups').innerHTML = Object.entries(groups).map(([g, list]) => {
    const anyDown = list.some((m) => m.status === 0);
    const anyDeg = list.some((m) => m.status === 4);
    const anyPending = list.some((m) => m.status === 2);
    const [gc, gl] = anyDown ? ['s0', 'Perturbé'] : anyDeg ? ['s4', 'Dégradé'] : anyPending ? ['s2', 'Vérification…'] : ['s1', 'Opérationnel'];
    return `<div class="card group">
      <div class="group-head"><span>${esc(g)}</span><span class="pill ${gc}">${gl}</span></div>
      ${list.map(svcHTML).join('')}
    </div>`;
  }).join('');

  const past = s.incidents.filter((i) => i.status === 'resolved');
  $('#past').innerHTML = `<div class="section-title">Incidents récents (7 jours)</div>` +
    (past.length ? past.map(incidentHTML).join('') : `<div class="card" style="padding:18px 20px" ><span class="muted">Aucun incident signalé ces 7 derniers jours. 🎉</span></div>`);
}

// Page protégée par mot de passe
function renderLock(title) {
  document.title = title || 'Page protégée';
  $('#title').textContent = title || 'Page protégée';
  $('#desc').textContent = '';
  $('#overall').className = 'hidden';
  $('#incidents').innerHTML = ''; $('#past').innerHTML = '';
  $('#groups').innerHTML = `<form class="card lock" id="unlock">
    <div style="font-size:34px">🔒</div>
    <h2>Page protégée</h2>
    <p class="muted small" style="margin:0 0 18px">Saisis le mot de passe pour voir l'état des services.</p>
    <div class="field"><input type="password" id="page-pw" placeholder="Mot de passe" required autocomplete="current-password"></div>
    <button class="btn primary" style="width:100%;justify-content:center">Déverrouiller</button>
  </form>`;
  $('#page-pw').focus();
  $('#unlock').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/api/pages/${encodeURIComponent(PAGE)}/unlock`, { method: 'POST', body: { password: $('#page-pw').value } });
      $('#overall').className = 'overall empty';
      connect();
      load();
    } catch (err) { toast(err.message, true); }
  };
}

async function load() {
  try {
    state = await api('/api/status' + q);
    lastUpdate = Date.now();
    render();
  } catch (e) {
    if (e.status === 401) {
      const info = await fetch('/api/status' + q).then((r) => r.json()).catch(() => ({}));
      return renderLock(info.title);
    }
    if (e.status === 404) {
      $('#overall').className = 'overall empty';
      $('#overall').innerHTML = `<div class="ic">?</div><div>Cette page de status n'existe pas<small><a href="/">Retour à la page principale</a></small></div>`;
      return;
    }
    $('#overall').className = 'overall major';
    $('#overall').innerHTML = `<div class="ic">!</div><div>Impossible de joindre le serveur de status</div>`;
  }
}

setInterval(() => { if (state) $('#updated').textContent = `Mis à jour ${ago(lastUpdate)} · actualisation en temps réel`; }, 1000);
setInterval(() => { if (state) load(); }, 60000);

let refreshTimer;
function connect() {
  if (es) es.close();
  es = liveEvents(({ monitorId, beat }) => {
    if (!state) return;
    const m = state.monitors.find((x) => x.id === monitorId);
    if (!m) return;
    lastUpdate = Date.now();
    // Le statut change : on recharge les stats complètes (avec anti-rebond)
    if (beat.s !== m.status && beat.s !== 2) { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 500); return; }
    m.ping = beat.p;
    const el = document.querySelector(`.svc[data-id="${monitorId}"] .ping`);
    if (el) el.textContent = pingText(m);
    if (beat.pl != null && m.mc) {
      m.mc.online = beat.pl;
      const chip = document.querySelector(`.svc[data-id="${monitorId}"] .chip`);
      if (chip) chip.textContent = `👥 ${m.mc.online}/${m.mc.max}`;
    }
  }, load, PAGE);
}

// Liens d'historique propres à la page
if (PAGE) $$('a[href="/history"]').forEach((a) => (a.href = `/s/${PAGE}/history`));
connect();
load();
