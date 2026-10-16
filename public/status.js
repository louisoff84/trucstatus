// Page de status publique
let state = null;
let lastUpdate = Date.now();

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
    const maint = ms.filter((m) => m.status === 3).length;
    const activeInc = s.incidents.filter((i) => i.status !== 'resolved' && i.severity !== 'maintenance');
    let cls = 'ok', ic = '✓', txt = 'Tous les systèmes sont opérationnels';
    if (!ms.length) { cls = 'empty'; ic = '…'; txt = 'Aucun service surveillé pour le moment'; }
    else if (down && down >= Math.ceil(ms.length / 2)) { cls = 'major'; ic = '!'; txt = 'Panne majeure en cours'; }
    else if (down || activeInc.some((i) => i.severity === 'danger')) { cls = 'partial'; ic = '!'; txt = `Perturbation partielle — ${down} service${down > 1 ? 's' : ''} hors ligne`; }
    else if (activeInc.length) { cls = 'partial'; ic = '!'; txt = 'Certains services sont dégradés'; }
    else if (maint) { cls = 'maint'; ic = '🔧'; txt = 'Maintenance en cours'; }
    if (!down && activeInc.length && activeInc.every((i) => i.severity === 'info')) { cls = 'ok'; ic = '✓'; txt = 'Tous les systèmes sont opérationnels'; }
    $('#overall').className = 'overall ' + cls;
    $('#overall').innerHTML = `<div class="ic">${ic}</div><div>${txt}<small>${ms.length} service${ms.length > 1 ? 's' : ''} surveillé${ms.length > 1 ? 's' : ''}</small></div>`;
  }

  const active = s.incidents.filter((i) => i.status !== 'resolved');
  $('#incidents').innerHTML = active.length ? `<div class="section-title">Incidents & maintenances en cours</div>` + active.map(incidentHTML).join('') : '';

  const groups = {};
  for (const m of s.monitors) (groups[m.group || 'Services'] ||= []).push(m);
  $('#groups').innerHTML = Object.entries(groups).map(([g, list]) => {
    const allUp = list.every((m) => m.status === 1 || m.status === 3);
    return `<div class="card group">
      <div class="group-head"><span>${esc(g)}</span><span class="pill ${allUp ? 's1' : 's0'}">${allUp ? 'Opérationnel' : 'Perturbé'}</span></div>
      ${list.map((m) => `<div class="svc" data-id="${m.id}">
        <div class="svc-top">
          <div class="svc-name"><span class="dot s${m.status}"></span><span>${esc(m.name)}</span></div>
          <div style="display:flex;gap:10px;align-items:center">
            <span class="muted small hide-sm">${m.ping != null && m.status === 1 ? m.ping + ' ms' : ''}</span>
            <span class="pill s${m.status}">${STATUS_LABEL[m.status]}</span>
          </div>
        </div>
        ${m.description ? `<div class="svc-desc">${esc(m.description)}</div>` : ''}
        <div class="bars d90">${dayBarsHTML(m.bars)}</div>
        <div class="svc-meta"><span><span class="hide-sm">Il y a </span>90 jours</span><span><b>${fmtPct(m.uptime90)}</b> de disponibilité</span><span>Aujourd'hui</span></div>
      </div>`).join('')}
    </div>`;
  }).join('');

  const past = s.incidents.filter((i) => i.status === 'resolved');
  $('#past').innerHTML = `<div class="section-title">Incidents récents (7 jours)</div>` +
    (past.length ? past.map(incidentHTML).join('') : `<div class="card" style="padding:18px 20px" ><span class="muted">Aucun incident signalé ces 7 derniers jours. 🎉</span></div>`);
}

async function load() {
  try {
    state = await api('/api/status');
    lastUpdate = Date.now();
    render();
  } catch (e) {
    $('#overall').className = 'overall major';
    $('#overall').innerHTML = `<div class="ic">!</div><div>Impossible de joindre le serveur de status</div>`;
  }
}

setInterval(() => { $('#updated').textContent = `Mis à jour ${ago(lastUpdate)} · actualisation en temps réel`; }, 1000);
setInterval(load, 60000);

let refreshTimer;
liveEvents(({ monitorId, beat }) => {
  if (!state) return;
  const m = state.monitors.find((x) => x.id === monitorId);
  if (!m) return;
  lastUpdate = Date.now();
  // Le statut change : on recharge les stats complètes (léger, avec anti-rebond)
  if (beat.s !== m.status) { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 500); return; }
  m.ping = beat.p;
  const el = document.querySelector(`.svc[data-id="${monitorId}"] .muted.small`);
  if (el) el.textContent = beat.p != null && beat.s === 1 ? beat.p + ' ms' : '';
}, load);

load();
