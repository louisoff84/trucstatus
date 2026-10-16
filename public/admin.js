// Tableau de bord d'administration
let monitors = [];
let notifications = [];
let selectedId = null;
let chartHours = 24;
let chartBeats = [];

const TYPE_LABEL = { http: 'HTTP(S)', keyword: 'HTTP(S) — Mot-clé', json: 'HTTP(S) — Requête JSON', tcp: 'Port TCP', ping: 'Ping', dns: 'DNS', push: 'Push (heartbeat)', minecraft: 'Serveur Minecraft', proxmox: 'Nœud Proxmox', database: 'Base de données' };
let chartMode = 'ping'; // 'ping' ou 'players' (Minecraft)
let pages = [];

// Alertes du navigateur quand un monitor change d'état
function browserAlert(m, beat) {
  try {
    if (localStorage.getItem('cs-browser-alerts') !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${beat.s === 1 ? '✅' : beat.s === 4 ? '🟠' : '🔴'} ${m.name} — ${STATUS_LABEL[beat.s]}`, { body: beat.m || '', icon: '/favicon.svg', tag: 'cs-' + m.id });
  } catch {}
}

// ───────────── Authentification ─────────────
async function init() {
  const me = await api('/api/me');
  if (me.authed) return startApp();
  $('#auth').classList.remove('hidden');
  if (me.setup) {
    $('#auth-title').textContent = 'Bienvenue 👋';
    $('#auth-sub').textContent = 'Crée le mot de passe administrateur (8 caractères minimum).';
    $('#auth-pw2-wrap').classList.remove('hidden');
    $('#auth-pw').autocomplete = 'new-password';
  }
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const pw = $('#auth-pw').value;
    try {
      if (me.setup) {
        if (pw !== $('#auth-pw2').value) return toast('Les mots de passe ne correspondent pas', true);
        await api('/api/setup', { method: 'POST', body: { password: pw } });
      } else {
        await api('/api/login', { method: 'POST', body: { password: pw } });
      }
      $('#auth').classList.add('hidden');
      startApp();
    } catch (err) { toast(err.message, true); }
  };
}

async function startApp() {
  $('#app').classList.remove('hidden');
  const s = await api('/api/settings').catch(() => ({ title: 'Status' }));
  $('#app-title').textContent = s.title;
  await Promise.all([loadMonitors(), loadNotifications()]);
  const m = location.hash.match(/^#m-(\d+)/);
  if (m) selectedId = Number(m[1]);
  render();
  liveEvents(onBeat, () => {});
  setInterval(loadMonitors, 30000);
}

// Bouton d'alertes navigateur
(function () {
  const btn = $('#browser-alerts');
  if (!btn) return;
  if (!('Notification' in window)) { btn.classList.add('hidden'); return; }
  const on = () => { try { return localStorage.getItem('cs-browser-alerts') === '1' && Notification.permission === 'granted'; } catch { return false; } };
  const paint = () => { btn.textContent = on() ? '🔔 Alertes : oui' : '🔕 Alertes : non'; btn.title = 'Notifications du navigateur quand un monitor change d’état'; };
  btn.onclick = async () => {
    if (on()) { try { localStorage.setItem('cs-browser-alerts', '0'); } catch {} }
    else {
      const p = await Notification.requestPermission();
      if (p !== 'granted') toast('Autorisation refusée par le navigateur', true);
      try { localStorage.setItem('cs-browser-alerts', p === 'granted' ? '1' : '0'); } catch {}
    }
    paint();
  };
  paint();
})();

$('#logout').onclick =async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
$('#add-monitor').onclick = () => openMonitorForm();
$('#search').oninput = renderList;
$$('[data-open]').forEach((b) => (b.onclick = () => ({ incidents: openIncidents, notifications: openNotifications, settings: openSettings, pages: openPages })[b.dataset.open]()));
window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#m-(\d+)/);
  selectedId = m ? Number(m[1]) : null;
  render();
});

async function loadMonitors() {
  try {
    monitors = await api('/api/monitors');
    render(true);
  } catch (e) { if (e.status === 401) location.reload(); }
}
async function loadNotifications() { notifications = await api('/api/notifications'); }

// ───────────── Temps réel ─────────────
let reloadTimer;
function onBeat({ monitorId, beat }) {
  const m = monitors.find((x) => x.id === monitorId);
  if (!m) return;
  const changed = m.status !== beat.s && beat.s !== 2;
  m.recent.push(beat);
  if (m.recent.length > 60) m.recent.shift();
  if (beat.s !== 2) m.status = beat.s;
  m.ping = beat.p;
  m.lastMsg = beat.m;
  if (monitorId === selectedId && Date.now() - beat.t < chartHours * 3600e3) { chartBeats.push(beat); }
  if (changed) {
    if (beat.s === 0 || beat.s === 1 || beat.s === 4) browserAlert(m, beat);
    clearTimeout(reloadTimer); reloadTimer = setTimeout(loadMonitors, 400);
  }
  renderList();
  if (monitorId === selectedId) renderDetail(false);
  else if (!selectedId) renderDashboard();
}

// ───────────── Rendu ─────────────
function render(soft) {
  renderList();
  if (selectedId && monitors.find((m) => m.id === selectedId)) renderDetail(!soft);
  else { selectedId = null; renderDashboard(); }
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const list = monitors.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.target || '').toLowerCase().includes(q) || (m.group || '').toLowerCase().includes(q));
  if (!monitors.length) {
    $('#mlist').innerHTML = `<div class="empty" style="padding:30px 10px"><div class="big">📡</div>Aucun monitor.<br>Clique sur « Ajouter » pour commencer.</div>`;
    return;
  }
  const groups = {};
  for (const m of list) (groups[m.group || ''] ||= []).push(m);
  const keys = Object.keys(groups).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  $('#mlist').innerHTML = keys.map((g) => (g ? `<div class="mgroup">${esc(g)}</div>` : '') + groups[g].map((m) => `
    <a class="mitem ${m.id === selectedId ? 'active' : ''}" href="#m-${m.id}">
      <div class="mitem-top">
        <span class="dot s${m.status}"></span>
        <span class="nm">${esc(m.name)}</span>
        <span class="pill s${m.status}">${m.status === -1 ? 'Pause' : fmtPct(m.uptime24, 1)}</span>
      </div>
      <div class="bars mini">${beatBarsHTML(m.recent, 30)}</div>
    </a>`).join('')).join('') || '<p class="muted small" style="padding:10px">Aucun résultat.</p>';
}

function renderDashboard() {
  const c = (s) => monitors.filter((m) => m.status === s).length;
  const events = [];
  for (const m of monitors) for (const b of m.recent) if (b.s === 0) events.push({ ...b, name: m.name, id: m.id });
  events.sort((a, b) => b.t - a.t);
  $('#main').innerHTML = `
    <div class="summary">
      <div class="card stat"><div class="k">En ligne</div><div class="v" style="color:var(--up)">${c(1)}</div></div>
      <div class="card stat"><div class="k">Dégradé</div><div class="v" style="color:var(--degraded)">${c(4)}</div></div>
      <div class="card stat"><div class="k">Hors ligne</div><div class="v" style="color:var(--down)">${c(0)}</div></div>
      <div class="card stat"><div class="k">Maintenance</div><div class="v" style="color:var(--maint)">${c(3)}</div></div>
      <div class="card stat"><div class="k">En pause</div><div class="v" style="color:var(--paused)">${c(-1)}</div></div>
    </div>
    <div class="card panel">
      <div class="panel-head"><h3>Vue d'ensemble</h3></div>
      ${monitors.length ? `<div class="table-scroll"><table>
        <thead><tr><th>Monitor</th><th>Statut</th><th>Ping</th><th>24 h</th><th>30 j</th><th style="min-width:200px">Derniers battements</th></tr></thead>
        <tbody>${monitors.map((m) => `<tr style="cursor:pointer" onclick="location.hash='m-${m.id}'">
          <td><b>${esc(m.name)}</b><div class="muted small">${esc(TYPE_LABEL[m.type])}</div></td>
          <td><span class="pill s${m.status}">${STATUS_LABEL[m.status]}</span></td>
          <td>${fmtMs(m.ping)}</td><td>${fmtPct(m.uptime24)}</td><td>${fmtPct(m.uptime30)}</td>
          <td><div class="bars mini">${beatBarsHTML(m.recent, 30)}</div></td></tr>`).join('')}</tbody>
      </table></div>` : `<div class="empty"><div class="big">🚀</div>Ajoute ton premier monitor pour commencer la surveillance.<br><br><button class="btn primary" onclick="openMonitorForm()">＋ Ajouter un monitor</button></div>`}
    </div>
    <div class="card panel">
      <div class="panel-head"><h3>Dernières pannes détectées</h3></div>
      ${events.length ? `<table><tbody>${events.slice(0, 15).map((e) => `<tr><td><a href="#m-${e.id}"><b>${esc(e.name)}</b></a></td><td class="muted">${fmtDate(e.t)}</td><td>${esc(e.m || '')}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Aucune panne récente. 👌</p>'}
    </div>`;
}

function renderDetail(full = true) {
  const m = monitors.find((x) => x.id === selectedId);
  if (!m) return;
  if (m.type !== 'minecraft') chartMode = 'ping';
  const cert = m.cert;
  const html = `
    <div class="card panel">
      <div class="detail-head">
        <div style="min-width:0">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <h2>${esc(m.name)}</h2><span class="pill s${m.status}">${STATUS_LABEL[m.status]}</span>
            ${m.config.isPublic ? '<span class="pill s-1">Public</span>' : '<span class="pill s-1">Privé</span>'}
          </div>
          <div style="margin-top:6px">${/^https?:/.test(m.target) ? `<a class="tgt" href="${esc(m.target)}" target="_blank" rel="noopener">${esc(m.target)}</a>` : `<span class="tgt">${esc(m.target)}</span>`}
            <span class="muted small"> · ${esc(TYPE_LABEL[m.type])} · ${m.type === 'push' ? 'push attendu' : ''} toutes les ${m.config.interval} s</span></div>
          ${m.lastMsg ? `<div class="muted small" style="margin-top:4px">Dernier résultat : ${esc(m.lastMsg)}</div>` : ''}
          ${depsHTML(m)}
        </div>
        <div class="actions">
          <button class="btn" id="d-toggle">${m.config.active ? '⏸ Pause' : '▶ Reprendre'}</button>
          <button class="btn" id="d-edit">✏️ Modifier</button>
          <button class="btn" id="d-clone">⧉ Dupliquer</button>
          <button class="btn danger" id="d-del">Supprimer</button>
        </div>
      </div>
      <div class="bars" style="margin-top:20px;height:30px">${beatBarsHTML(m.recent, 60)}</div>
      ${extraInfoHTML(m)}
    </div>

    <div class="stats" style="margin-bottom:20px">
      <div class="card stat"><div class="k">Réponse actuelle</div><div class="v">${m.ping ?? '—'}<small>${m.ping != null ? ' ms' : ''}</small></div></div>
      <div class="card stat"><div class="k">Moyenne (24 h)</div><div class="v">${m.avgPing24 ?? '—'}<small>${m.avgPing24 != null ? ' ms' : ''}</small></div></div>
      <div class="card stat"><div class="k">Disponibilité 24 h</div><div class="v">${fmtPct(m.uptime24)}</div></div>
      <div class="card stat"><div class="k">Disponibilité 30 j</div><div class="v">${fmtPct(m.uptime30)}</div></div>
      ${extraStatsHTML(m)}
      ${cert ? `<div class="card stat"><div class="k">Certificat TLS</div><div class="v" style="color:${cert.daysLeft < 14 ? 'var(--down)' : 'inherit'}">${cert.daysLeft}<small> j</small></div><div class="muted small">${esc(cert.issuer || '')}</div></div>` : ''}
    </div>

    <div class="card panel">
      <div class="panel-head"><h3>${chartMode === 'players' ? 'Joueurs connectés' : 'Temps de réponse'}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${m.type === 'minecraft' ? `<div class="tabs" id="cmode"><button data-m="ping" class="${chartMode === 'ping' ? 'on' : ''}">Ping</button><button data-m="players" class="${chartMode === 'players' ? 'on' : ''}">Joueurs</button></div>` : ''}
        <div class="tabs" id="ranges">${[[1, '1 h'], [6, '6 h'], [24, '24 h'], [168, '7 j']].map(([h, l]) => `<button data-h="${h}" class="${h === chartHours ? 'on' : ''}">${l}</button>`).join('')}</div>
        </div>
      </div>
      <div class="chart-wrap"><canvas id="chart"></canvas></div>
    </div>

    <div class="card panel">
      <div class="panel-head"><h3>Disponibilité sur 90 jours</h3><span class="muted small">${fmtPct(m.uptime90)}</span></div>
      <div class="bars">${dayBarsHTML(m.bars)}</div>
    </div>

    <div class="card panel">
      <div class="panel-head"><h3>Événements importants</h3></div>
      <div id="events"><p class="muted">Chargement…</p></div>
    </div>

    <div class="card panel">
      <div class="panel-head"><h3>Badge</h3></div>
      <p class="muted small" style="margin-top:0">À intégrer dans un README ou un site (monitor public uniquement) :</p>
      <input readonly value="${esc(location.origin)}/api/badge/${m.id}" onclick="this.select()">
    </div>
    ${m.type === 'push' ? `<div class="card panel">
      <div class="panel-head"><h3>URL de push</h3></div>
      <p class="muted small" style="margin-top:0">Ton service (cron, script, serveur de jeu…) doit appeler cette URL au moins toutes les ${m.config.interval} s. Paramètres optionnels : <code>status=down</code>, <code>msg=…</code>, <code>ping=…</code>.</p>
      <input readonly value="${esc(location.origin + m.pushPath)}?status=up&amp;msg=OK" onclick="this.select()">
      <p class="muted small">Exemple cron Linux : <code>*/1 * * * * curl -fsS "${esc(location.origin + m.pushPath)}" &gt;/dev/null</code></p>
    </div>` : ''}`;

  if (!full && $('#chart')) {
    // mise à jour légère : on ne refait que le haut et le graphe
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const panels = $$('#main > *');
    const fresh = [...tmp.children];
    [0, 1, 3].forEach((i) => panels[i] && fresh[i] && panels[i].replaceWith(fresh[i]));
    bindDetail(m);
    drawChart();
    renderEvents();
    return;
  }
  $('#main').innerHTML = html;
  bindDetail(m);
  $$('#ranges button').forEach((b) => (b.onclick = () => { chartHours = Number(b.dataset.h); $$('#ranges button').forEach((x) => x.classList.toggle('on', x === b)); loadChart(); }));
  $$('#cmode button').forEach((b) => (b.onclick = () => { chartMode = b.dataset.m; renderDetail(true); }));
  loadChart();
}

function depsHTML(m) {
  const parent = m.config.parentId ? monitors.find((x) => x.id === m.config.parentId) : null;
  const kids = monitors.filter((x) => x.config.parentId === m.id);
  if (!parent && !kids.length) return '';
  return `<div class="small" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
    ${parent ? `<span class="muted">Dépend de</span> <a class="chip" href="#m-${parent.id}"><span class="dot s${parent.status}" style="width:8px;height:8px;animation:none"></span>${esc(parent.name)}</a>` : ''}
    ${kids.length ? `<span class="muted">${parent ? ' · ' : ''}Services dépendants</span> ${kids.map((k) => `<a class="chip" href="#m-${k.id}"><span class="dot s${k.status}" style="width:8px;height:8px;animation:none"></span>${esc(k.name)}</a>`).join('')}` : ''}
  </div>`;
}
function fmtUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d ? `${d} j ${h} h` : `${h} h ${Math.floor((sec % 3600) / 60)} min`;
}
function meter(label, v, limit) {
  const warn = limit && v > limit;
  return `<div class="card stat"><div class="k">${label}</div><div class="v" style="${warn ? 'color:var(--degraded)' : ''}">${v}<small> %</small></div><div class="meter"><span class="${warn ? 'warn' : ''}" style="width:${Math.min(100, v)}%"></span></div>${limit ? `<div class="muted small" style="margin-top:4px">seuil ${limit} %</div>` : ''}</div>`;
}
function extraStatsHTML(m) {
  const x = m.extra;
  if (!x) return '';
  if (x.kind === 'minecraft') return `
    <div class="card stat"><div class="k">Joueurs</div><div class="v">${x.online}<small> / ${x.max}</small></div></div>
    <div class="card stat"><div class="k">Version</div><div class="v" style="font-size:16px">${esc(x.version || '—')}</div></div>`;
  if (x.kind === 'database') return `
    <div class="card stat"><div class="k">Moteur</div><div class="v" style="font-size:16px">${esc({ mysql: 'MySQL / MariaDB', postgres: 'PostgreSQL', redis: 'Redis' }[x.engine] || x.engine)}</div><div class="muted small">${esc(x.version || (x.ssl != null ? (x.ssl ? 'SSL disponible' : 'SSL non activé') : ''))}</div></div>`;
  if (x.kind === 'proxmox') return `
    ${meter('CPU', x.cpu, m.config.pveCpu)}${meter('RAM', x.mem, m.config.pveMem)}${meter('Disque', x.disk, m.config.pveDisk)}
    <div class="card stat"><div class="k">VM / CT actives</div><div class="v">${x.running}<small> / ${x.total}</small></div></div>
    <div class="card stat"><div class="k">Uptime du nœud</div><div class="v" style="font-size:18px">${fmtUptime(x.uptime)}</div><div class="muted small">${esc(x.pveVersion || '')}</div></div>`;
  return '';
}
function extraInfoHTML(m) {
  const x = m.extra;
  if (!x) return '';
  if (x.kind === 'minecraft') return `<div style="margin-top:14px">
    ${x.motd ? `<div class="small"><span class="muted">MOTD :</span> ${esc(x.motd)}</div>` : ''}
    ${x.sample && x.sample.length ? `<div class="guests" style="margin-top:8px">${x.sample.map((n) => `<span class="chip">👤 ${esc(n)}</span>`).join('')}</div>` : ''}
  </div>`;
  if (x.kind === 'proxmox' && x.guests && x.guests.length) {
    const watched = String(m.config.pveVmids || '').split(/[\s,;]+/).map(Number).filter(Boolean);
    return `<div class="guests" style="margin-top:14px">${x.guests.map((g) => `<span class="chip" title="${esc(g.kind)} ${g.vmid}${watched.includes(Number(g.vmid)) ? ' — surveillée' : ''}"><span class="dot ${g.status === 'running' ? 's1' : 's-1'}" style="width:8px;height:8px;animation:none"></span>${watched.includes(Number(g.vmid)) ? '👁 ' : ''}${g.vmid} ${esc(g.name || '')}</span>`).join('')}</div>`;
  }
  return '';
}

function bindDetail(m) {
  $('#d-toggle').onclick = async () => { await api(`/api/monitors/${m.id}/toggle`, { method: 'POST' }); loadMonitors(); };
  $('#d-edit').onclick = () => openMonitorForm(m.config);
  $('#d-clone').onclick = () => openMonitorForm({ ...m.config, id: undefined, pushToken: undefined, name: m.config.name + ' (copie)' });
  $('#d-del').onclick = async () => {
    if (!confirm(`Supprimer « ${m.name} » et tout son historique ?`)) return;
    await api(`/api/monitors/${m.id}`, { method: 'DELETE' });
    location.hash = '';
    await loadMonitors();
    toast('Monitor supprimé');
  };
}

async function loadChart() {
  const id = selectedId;
  chartBeats = await api(`/api/monitors/${id}/beats?hours=${chartHours}`);
  if (id !== selectedId) return;
  drawChart();
  renderEvents();
}

function renderEvents() {
  const el = $('#events');
  if (!el) return;
  const imp = chartBeats.filter((b) => b.important).slice(-30).reverse();
  el.innerHTML = imp.length ? `<div class="table-scroll"><table><thead><tr><th>Statut</th><th>Date</th><th>Message</th></tr></thead><tbody>
    ${imp.map((b) => `<tr><td><span class="pill s${b.s}">${STATUS_LABEL[b.s]}</span></td><td class="muted" style="white-space:nowrap">${fmtDate(b.t)}</td><td>${esc(b.m || '')}</td></tr>`).join('')}
  </tbody></table></div>` : '<p class="muted">Aucun changement d’état sur la période.</p>';
}

function drawChart() {
  const cv = $('#chart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const cMuted = css.getPropertyValue('--muted').trim(), cBorder = css.getPropertyValue('--border').trim();
  const cUp = css.getPropertyValue(chartMode === 'players' ? '--maint' : '--up').trim(), cDown = css.getPropertyValue('--down').trim(), cMaint = css.getPropertyValue('--maint').trim(), cDeg = css.getPropertyValue('--degraded').trim();
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const now = Date.now(), t0 = now - chartHours * 3600e3;
  const pts = chartBeats.filter((b) => b.t >= t0);
  const players = chartMode === 'players';
  const val = players ? (b) => b.pl : (b) => b.p;
  const unit = players ? '' : ' ms';
  const okBeat = (b) => (players ? b.pl != null : (b.s === 1 || b.s === 4) && b.p != null);
  const pings = pts.filter(okBeat).map(val);
  const maxP = Math.max(players ? 5 : 50, ...pings) * 1.15;
  const x = (t) => pad.l + ((t - t0) / (now - t0)) * (W - pad.l - pad.r);
  const y = (p) => pad.t + (1 - p / maxP) * (H - pad.t - pad.b);

  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.fillStyle = cMuted; ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (maxP / 4) * i, yy = y(v);
    ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.textAlign = 'right'; ctx.fillText(Math.round(v) + unit, pad.l - 6, yy + 4);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 5; i++) {
    const t = t0 + ((now - t0) / 5) * i;
    const d = new Date(t);
    const lbl = chartHours > 24 ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(lbl, Math.min(W - 40, Math.max(pad.l + 20, x(t))), H - 8);
  }
  // Zones de panne / maintenance
  for (const b of pts) {
    if (b.s === 0 || b.s === 3 || b.s === 4) {
      ctx.fillStyle = b.s === 0 ? cDown : b.s === 4 ? cDeg : cMaint; ctx.globalAlpha = b.s === 4 ? .14 : .22;
      ctx.fillRect(x(b.t) - 2, pad.t, 4, H - pad.t - pad.b);
      ctx.globalAlpha = 1;
    }
  }
  if (!pings.length) {
    ctx.fillStyle = cMuted; ctx.font = '13px Inter, system-ui'; ctx.fillText('Pas encore de données', W / 2, H / 2);
    return;
  }
  // Courbe + remplissage
  const up = pts.filter(okBeat);
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, cUp + '55'); grad.addColorStop(1, cUp + '00');
  ctx.beginPath();
  up.forEach((b, i) => (i ? ctx.lineTo(x(b.t), y(val(b))) : ctx.moveTo(x(b.t), y(val(b)))));
  ctx.lineTo(x(up[up.length - 1].t), y(0)); ctx.lineTo(x(up[0].t), y(0)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  up.forEach((b, i) => (i ? ctx.lineTo(x(b.t), y(val(b))) : ctx.moveTo(x(b.t), y(val(b)))));
  ctx.strokeStyle = cUp; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  // Infobulle au survol
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = null, bd = 1e9;
    for (const b of pts) { const d = Math.abs(x(b.t) - mx); if (d < bd) { bd = d; best = b; } }
    if (best && bd < 20) cv.dataset.tip = `<b>${fmtDate(best.t)}</b><br>${STATUS_LABEL[best.s]}${best.p != null ? ' · ' + best.p + ' ms' : ''}${best.pl != null ? ' · ' + best.pl + ' joueur(s)' : ''}${best.m ? '<br>' + esc(best.m) : ''}`;
    else delete cv.dataset.tip;
    cv.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
  };
}
window.addEventListener('resize', () => drawChart());

// ───────────── Modales ─────────────
function modal(html, wide = false) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-bg"><div class="card modal ${wide ? 'wide' : ''}">${html}</div></div>`;
  const bg = root.firstElementChild;
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) closeModal(); });
  document.onkeydown = (e) => { if (e.key === 'Escape') closeModal(); };
  return bg.firstElementChild;
}
function closeModal() { $('#modal-root').innerHTML = ''; document.onkeydown = null; }

function formData(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') { if (el.dataset.list) (o[el.name] ||= []).push(...(el.checked ? [Number(el.value)] : [])); else o[el.name] = el.checked; }
    else if (el.type === 'number') o[el.name] = el.value === '' ? null : Number(el.value);
    else o[el.name] = el.value;
  }
  return o;
}

// Formulaire monitor
function openMonitorForm(cfg = {}) {
  const c = { type: 'http', method: 'GET', interval: 60, retryInterval: 30, timeout: 30, retries: 1, expectedStatus: '200-299', isPublic: true, active: true, certExpiryDays: 14, dnsType: 'A', ...cfg };
  const isEdit = !!c.id;
  const groups = [...new Set(monitors.map((m) => m.group).filter(Boolean))];
  const el = modal(`
    <h2>${isEdit ? 'Modifier le monitor' : 'Nouveau monitor'}</h2>
    <form id="mform">
      <div class="row">
        <div class="field"><label>Type de surveillance</label><select name="type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Nom affiché</label><input name="name" required value="${esc(c.name || '')}" placeholder="Site web, API, Base de données…"></div>
      </div>
      <div class="field t-url"><label id="lbl-url">URL</label><input name="url" value="${esc(c.url || '')}" placeholder="https://craftpick.fr"></div>
      <div class="row t-host">
        <div class="field"><label>Nom d'hôte / IP</label><input name="hostname" value="${esc(c.hostname || '')}" placeholder="craftpick.fr ou 192.168.1.10"></div>
        <div class="field t-port"><label>Port</label><input type="number" name="port" value="${c.port ?? ''}" placeholder="443"></div>
      </div>
      <div class="row t-mc">
        <div class="field"><label>Édition</label><select name="mcEdition"><option value="java" ${c.mcEdition !== 'bedrock' ? 'selected' : ''}>Java</option><option value="bedrock" ${c.mcEdition === 'bedrock' ? 'selected' : ''}>Bedrock</option></select></div>
        <p class="muted small" style="margin:24px 0 0">Java : port vide = enregistrement SRV puis 25565. Bedrock : 19132 par défaut (UDP).</p>
      </div>
      <div class="t-db">
        <div class="row3">
          <div class="field"><label>Moteur</label><select name="dbKind">${[['mysql', 'MySQL / MariaDB'], ['postgres', 'PostgreSQL'], ['redis', 'Redis']].map(([k, v]) => `<option value="${k}" ${c.dbKind === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
          <div class="field t-redis"><label>Utilisateur Redis (optionnel)</label><input name="dbUser" value="${esc(c.dbUser || '')}" autocomplete="off"></div>
          <div class="field t-redis"><label>Mot de passe Redis</label><input type="password" name="dbPassword" value="" autocomplete="new-password" placeholder="${c.secretsSet && c.secretsSet.dbPassword ? '•••••••• (inchangé)' : 'optionnel'}"></div>
        </div>
        <p class="muted small" style="margin-top:-6px">MySQL/PostgreSQL : vérifie que le serveur répond à son protocole (aucun identifiant nécessaire). Redis : envoie PING (et AUTH si un mot de passe est saisi).</p>
      </div>
      <fieldset class="t-pve"><legend>Proxmox VE</legend>
        <div class="row">
          <div class="field"><label>Nom du nœud</label><input name="pveNode" value="${esc(c.pveNode || '')}" placeholder="pve"></div>
          <div class="field"><label>ID du jeton API</label><input name="pveTokenId" value="${esc(c.pveTokenId || '')}" placeholder="root@pam!status" autocomplete="off"></div>
        </div>
        <div class="field"><label>Secret du jeton</label><input type="password" name="pveTokenSecret" value="" autocomplete="new-password" placeholder="${c.secretsSet && c.secretsSet.pveTokenSecret ? '•••••••• (laisser vide pour conserver)' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}"></div>
        <div class="field"><label>VM / CT à surveiller (IDs, panne si arrêtée)</label><input name="pveVmids" value="${esc(c.pveVmids || '')}" placeholder="100, 101, 105"></div>
        <div class="row3">
          <div class="field"><label>Seuil CPU (%)</label><input type="number" name="pveCpu" min="0" max="100" value="${c.pveCpu || ''}" placeholder="90"></div>
          <div class="field"><label>Seuil RAM (%)</label><input type="number" name="pveMem" min="0" max="100" value="${c.pveMem || ''}" placeholder="90"></div>
          <div class="field"><label>Seuil disque (%)</label><input type="number" name="pveDisk" min="0" max="100" value="${c.pveDisk || ''}" placeholder="85"></div>
        </div>
        <p class="muted small" style="margin-top:-4px">Un seuil dépassé passe le monitor en « Dégradé ». Jeton conseillé : rôle <code>PVEAuditor</code> (lecture seule) sur <code>/</code>.</p>
      </fieldset>
      <div class="row t-dns">
        <div class="field"><label>Type d'enregistrement</label><select name="dnsType">${['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SRV', 'CAA'].map((t) => `<option ${c.dnsType === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
        <div class="field"><label>Serveur DNS (optionnel)</label><input name="dnsServer" value="${esc(c.dnsServer || '')}" placeholder="1.1.1.1"></div>
      </div>
      <div class="field t-keyword"><label>Mot-clé à rechercher</label><input name="keyword" value="${esc(c.keyword || '')}">
        <div style="display:flex;gap:16px;margin-top:8px"><label class="check"><input type="checkbox" name="invertKeyword" ${c.invertKeyword ? 'checked' : ''}> Inverser (alerte si présent)</label><label class="check"><input type="checkbox" name="caseSensitive" ${c.caseSensitive ? 'checked' : ''}> Sensible à la casse</label></div></div>
      <div class="row t-json">
        <div class="field"><label>Chemin JSON</label><input name="jsonPath" value="${esc(c.jsonPath || '')}" placeholder="status ou data.health"></div>
        <div class="field"><label>Valeur attendue</label><input name="jsonExpected" value="${esc(c.jsonExpected || '')}" placeholder="ok"></div>
      </div>
      <div class="field t-push"><label>URL de push</label>
        ${c.pushToken ? `<input readonly value="${esc(location.origin)}/api/push/${esc(c.pushToken)}" onclick="this.select()">` : '<p class="muted small" style="margin:0">L’URL sera générée à la création. Ton service devra l’appeler régulièrement ; sans appel dans l’intervalle, le monitor passe hors ligne.</p>'}
      </div>

      <div class="row3">
        <div class="field"><label id="lbl-interval">Intervalle (s)</label><input type="number" name="interval" min="10" value="${c.interval}"></div>
        <div class="field t-notpush"><label>Tentatives avant alerte</label><input type="number" name="retries" min="0" max="10" value="${c.retries}"></div>
        <div class="field t-notpush"><label>Intervalle en panne (s)</label><input type="number" name="retryInterval" min="10" value="${c.retryInterval}"></div>
      </div>
      <div class="row">
        <div class="field t-notpush"><label>Délai d'expiration (s)</label><input type="number" name="timeout" min="1" max="300" value="${c.timeout}"></div>
        <div class="field"><label>Rappel en panne (toutes les N vérifications, 0 = jamais)</label><input type="number" name="resendEvery" min="0" value="${c.resendEvery || 0}"></div>
      </div>
      <div class="row">
        <div class="field"><label>Groupe (page publique)</label><input name="group" list="groups" value="${esc(c.group || '')}" placeholder="Services"><datalist id="groups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist></div>
        <div class="field"><label>Dépend de (alertes masquées si ce parent est en panne)</label><select name="parentId"><option value="">— Aucun —</option>${monitors.filter((x) => x.id !== c.id).map((x) => `<option value="${x.id}" ${c.parentId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Description (affichée publiquement)</label><input name="description" value="${esc(c.description || '')}"></div>

      <fieldset class="t-http"><legend>Options HTTP avancées</legend>
        <div class="row">
          <div class="field"><label>Méthode</label><select name="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((x) => `<option ${c.method === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div class="field"><label>Codes HTTP acceptés</label><input name="expectedStatus" value="${esc(c.expectedStatus)}" placeholder="200-299,301"></div>
        </div>
        <div class="field"><label>En-têtes (JSON)</label><textarea name="headers" placeholder='{"Authorization": "Bearer …"}'>${esc(c.headers || '')}</textarea></div>
        <div class="field"><label>Corps de la requête</label><textarea name="body">${esc(c.body || '')}</textarea></div>
        <div class="row">
          <div class="field"><label>Auth basique — utilisateur</label><input name="basicAuthUser" value="${esc(c.basicAuthUser || '')}" autocomplete="off"></div>
          <div class="field"><label>Auth basique — mot de passe</label><input type="password" name="basicAuthPass" value="" autocomplete="new-password" placeholder="${c.secretsSet && c.secretsSet.basicAuthPass ? '•••••••• (laisser vide pour conserver)' : ''}"></div>
        </div>
        <label class="check"><input type="checkbox" name="certExpiryAlert" ${c.certExpiryAlert ? 'checked' : ''}> Alerter avant expiration du certificat</label>
        <div class="field" style="max-width:220px"><label>Jours avant expiration</label><input type="number" name="certExpiryDays" value="${c.certExpiryDays}"></div>
      </fieldset>

      <label class="check t-tls" style="margin-bottom:14px"><input type="checkbox" name="ignoreTls" ${c.ignoreTls ? 'checked' : ''}> Ignorer les erreurs de certificat TLS <span class="muted small">(certificat auto-signé, ex. Proxmox)</span></label>

      <fieldset><legend>Statut « Dégradé »</legend>
        <div class="row">
          <div class="field"><label>Seuil de temps de réponse (ms, 0 = désactivé)</label><input type="number" name="degradedMs" min="0" value="${c.degradedMs || 0}" placeholder="1500"></div>
          <label class="check" style="margin-top:28px"><input type="checkbox" name="notifyDegraded" ${c.notifyDegraded ? 'checked' : ''}> Notifier aussi en cas de dégradation</label>
        </div>
        <p class="muted small" style="margin-top:-6px">Le service reste compté comme disponible, mais s'affiche en orange sur la page publique.</p>
      </fieldset>

      <fieldset><legend>Visibilité & notifications</legend>
        <label class="check"><input type="checkbox" name="isPublic" ${c.isPublic ? 'checked' : ''}> Afficher sur la page publique</label>
        <label class="check"><input type="checkbox" name="showTarget" ${c.showTarget ? 'checked' : ''}> Afficher l'URL / l'hôte publiquement</label>
        <label class="check"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Monitor actif</label>
        <div style="margin-top:10px">${notifications.length ? notifications.map((n) => `<label class="check"><input type="checkbox" data-list="1" name="notificationIds" value="${n.id}" ${(c.notificationIds || []).includes(n.id) || (!isEdit && n.applyAll) ? 'checked' : ''}> 🔔 ${esc(n.name)} <span class="muted small">(${esc(n.type)})</span></label>`).join('') : '<p class="muted small">Aucune notification configurée — voir le menu « Notifications ».</p>'}</div>
      </fieldset>

      <div id="test-result" class="small" style="min-height:20px"></div>
      <div class="modal-foot">
        <button type="button" class="btn" id="m-test">Tester maintenant</button>
        <button type="button" class="btn ghost" onclick="closeModal()">Annuler</button>
        <button type="submit" class="btn primary">${isEdit ? 'Enregistrer' : 'Créer'}</button>
      </div>
    </form>`);
  const form = $('#mform', el);
  const sync = () => {
    const t = form.type.value;
    const http = ['http', 'keyword', 'json'].includes(t);
    $$('.t-http', form).forEach((x) => x.classList.toggle('hidden', !http));
    $$('.t-url', form).forEach((x) => x.classList.toggle('hidden', !http && t !== 'proxmox'));
    $$('.t-tls', form).forEach((x) => x.classList.toggle('hidden', !http && t !== 'proxmox'));
    $$('.t-host', form).forEach((x) => x.classList.toggle('hidden', http || t === 'push' || t === 'proxmox'));
    $$('.t-port', form).forEach((x) => x.classList.toggle('hidden', t !== 'tcp' && t !== 'minecraft' && t !== 'database'));
    $$('.t-db', form).forEach((x) => x.classList.toggle('hidden', t !== 'database'));
    $$('.t-redis', form).forEach((x) => x.classList.toggle('hidden', form.dbKind.value !== 'redis'));
    $$('.t-mc', form).forEach((x) => x.classList.toggle('hidden', t !== 'minecraft'));
    $$('.t-pve', form).forEach((x) => x.classList.toggle('hidden', t !== 'proxmox'));
    $('#lbl-url', el).textContent = t === 'proxmox' ? 'URL de l’API Proxmox' : 'URL';
    form.url.placeholder = t === 'proxmox' ? 'https://192.168.1.10:8006' : 'https://craftpick.fr';
    form.port.placeholder = t === 'minecraft' ? (form.mcEdition.value === 'bedrock' ? '19132' : '25565 (ou SRV)') : t === 'database' ? { mysql: '3306', postgres: '5432', redis: '6379' }[form.dbKind.value] : '443';
    if (t === 'proxmox' && !isEdit && !form.dataset.tlsSet) { form.ignoreTls.checked = true; form.dataset.tlsSet = '1'; }
    $$('.t-push', form).forEach((x) => x.classList.toggle('hidden', t !== 'push'));
    $$('.t-notpush', form).forEach((x) => x.classList.toggle('hidden', t === 'push'));
    $('#m-test', el).classList.toggle('hidden', t === 'push');
    $('#lbl-interval', el).textContent = t === 'push' ? 'Délai max entre deux push (s)' : 'Intervalle (s)';
    $$('.t-dns', form).forEach((x) => x.classList.toggle('hidden', t !== 'dns'));
    $$('.t-keyword', form).forEach((x) => x.classList.toggle('hidden', t !== 'keyword'));
    $$('.t-json', form).forEach((x) => x.classList.toggle('hidden', t !== 'json'));
  };
  form.type.onchange = sync; form.mcEdition.onchange = sync; form.dbKind.onchange = sync; sync();
  const collect = () => { const d = formData(form); d.notificationIds ||= []; return d; };
  $('#m-test', el).onclick = async () => {
    $('#test-result').innerHTML = '<span class="muted">Test en cours…</span>';
    try {
      const r = await api('/api/monitors/test', { method: 'POST', body: collect() });
      $('#test-result').innerHTML = !r.ok ? `<span style="color:var(--down)">✗ ${esc(r.msg)}</span>`
        : r.degraded ? `<span style="color:var(--degraded)">◐ Dégradé — ${esc(r.msg)} (${r.ping} ms)</span>`
        : `<span style="color:var(--up)">✓ OK — ${esc(r.msg)} (${r.ping} ms)</span>`;
    } catch (e) { $('#test-result').innerHTML = `<span style="color:var(--down)">✗ ${esc(e.message)}</span>`; }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api(isEdit ? `/api/monitors/${c.id}` : '/api/monitors', { method: isEdit ? 'PUT' : 'POST', body: collect() });
      closeModal();
      toast(isEdit ? 'Monitor mis à jour' : 'Monitor créé');
      await loadMonitors();
      location.hash = 'm-' + r.id;
    } catch (err) { toast(err.message, true); }
  };
}

// Incidents
async function openIncidents() {
  const list = await api('/api/incidents');
  const el = modal(`
    <div class="panel-head"><h2 style="margin:0">Incidents & maintenances</h2><button class="btn primary" id="i-new">＋ Nouveau</button></div>
    <div id="i-list">${list.length ? list.map((i) => `<div class="list-item">
      <div style="min-width:0"><b>${esc(i.title)}</b>
        <div class="small muted">${esc(SEV_LABEL[i.severity])} · ${esc(INC_STATUS[i.status])}${i.recurrence ? ' · 🔁 récurrente' : ''} · ${fmtDate(i.createdAt)}</div></div>
      <div class="actions"><button class="btn sm" data-edit="${i.id}">Mettre à jour</button><button class="btn sm danger" data-del="${i.id}">✕</button></div>
    </div>`).join('') : '<p class="muted">Aucun incident. Publie un incident ou planifie une maintenance pour informer tes utilisateurs.</p>'}</div>
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Fermer</button></div>`, true);
  $('#i-new', el).onclick = () => incidentForm();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => incidentForm(list.find((i) => i.id === Number(b.dataset.edit)))));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => { if (confirm('Supprimer cet incident ?')) { await api('/api/incidents/' + b.dataset.del, { method: 'DELETE' }); openIncidents(); } }));
}
function toLocalInput(iso) { if (!iso) return ''; const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function incidentForm(i) {
  const isEdit = !!i;
  i = { severity: 'warning', status: 'investigating', monitorIds: [], ...(i || {}) };
  const el = modal(`
    <h2>${isEdit ? 'Mettre à jour l’incident' : 'Nouvel incident'}</h2>
    <form id="iform">
      <div class="field"><label>Titre</label><input name="title" required value="${esc(i.title || '')}" placeholder="Lenteurs sur l'API"></div>
      <div class="row">
        <div class="field"><label>Type</label><select name="severity">${Object.entries(SEV_LABEL).map(([k, v]) => `<option value="${k}" ${i.severity === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        <div class="field"><label>Statut</label><select name="status">${Object.entries(INC_STATUS).map(([k, v]) => `<option value="${k}" ${i.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
      </div>
      <label class="check t-maint"><input type="checkbox" id="i-rec" ${i.recurrence ? 'checked' : ''}> 🔁 Maintenance récurrente (ex. redémarrage quotidien du serveur)</label>
      <fieldset class="t-maint t-rec"><legend>Récurrence</legend>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="chip" style="cursor:pointer"><input type="checkbox" data-day="${d}" ${!i.recurrence || i.recurrence.days.includes(d) ? 'checked' : ''}> ${['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d]}</label>`).join('')}</div>
        <div class="row">
          <div class="field"><label>De</label><input type="time" id="i-rs" value="${esc(i.recurrence ? i.recurrence.start : '04:00')}"></div>
          <div class="field"><label>À</label><input type="time" id="i-re" value="${esc(i.recurrence ? i.recurrence.end : '04:15')}"></div>
        </div>
        <p class="muted small" style="margin-top:-6px">Heure du serveur. Un créneau peut passer minuit (ex. 23:30 → 00:30).</p>
      </fieldset>
      <div class="row t-maint">
        <div class="field"><label id="i-sl">Début de la maintenance</label><input type="datetime-local" name="startsAt" value="${toLocalInput(i.startsAt)}"></div>
        <div class="field"><label id="i-el">Fin prévue</label><input type="datetime-local" name="endsAt" value="${toLocalInput(i.endsAt)}"></div>
      </div>
      <p class="muted small t-maint" style="margin-top:-6px">Pendant la fenêtre de maintenance, les monitors concernés passent en « Maintenance » et n’envoient pas d’alerte.</p>
      ${isEdit ? `<div class="field"><label>Nouveau message de suivi</label><textarea name="updateText" placeholder="Le correctif a été déployé, nous surveillons la situation…"></textarea></div>`
               : `<div class="field"><label>Message</label><textarea name="content" placeholder="Nous enquêtons sur…">${esc(i.content || '')}</textarea></div>`}
      <fieldset><legend>Services concernés</legend>
        ${monitors.map((m) => `<label class="check"><input type="checkbox" data-list="1" name="monitorIds" value="${m.id}" ${(i.monitorIds || []).includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`).join('') || '<p class="muted small">Aucun monitor.</p>'}
      </fieldset>
      <div class="modal-foot"><button type="button" class="btn ghost" id="i-back">Retour</button><button class="btn primary" type="submit">${isEdit ? 'Publier la mise à jour' : 'Publier'}</button></div>
    </form>`);
  const form = $('#iform', el);
  const sync = () => {
    const maint = form.severity.value === 'maintenance';
    const rec = $('#i-rec', el).checked;
    $$('.t-maint', form).forEach((x) => x.classList.toggle('hidden', !maint));
    $$('.t-rec', form).forEach((x) => x.classList.toggle('hidden', !maint || !rec));
    $('#i-sl', el).textContent = rec ? 'Valable à partir du (optionnel)' : 'Début de la maintenance';
    $('#i-el', el).textContent = rec ? 'Jusqu’au (optionnel)' : 'Fin prévue';
  };
  $('#i-rec', el).onchange = sync;
  form.severity.onchange = () => { sync(); if (form.severity.value === 'maintenance' && !isEdit) form.status.value = 'scheduled'; };
  sync();
  $('#i-back', el).onclick = openIncidents;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(form);
    d.monitorIds ||= [];
    if (isEdit) d.content = i.content;
    d.startsAt = d.startsAt ? new Date(d.startsAt).toISOString() : null;
    d.endsAt = d.endsAt ? new Date(d.endsAt).toISOString() : null;
    d.recurrence = d.severity === 'maintenance' && $('#i-rec', el).checked
      ? { days: $$('[data-day]', form).filter((c) => c.checked).map((c) => Number(c.dataset.day)), start: $('#i-rs', el).value, end: $('#i-re', el).value }
      : null;
    try {
      await api(isEdit ? '/api/incidents/' + i.id : '/api/incidents', { method: isEdit ? 'PUT' : 'POST', body: d });
      toast('Incident publié');
      openIncidents();
    } catch (err) { toast(err.message, true); }
  };
}

// Notifications
const NOTIF_FIELDS = {
  email: [['smtpHost', 'Serveur SMTP', 'smtp.gmail.com'], ['smtpPort', 'Port', '587 (STARTTLS) ou 465 (TLS)'], ['smtpSecure', 'TLS implicite (port 465)', '', 'checkbox'], ['smtpUser', 'Utilisateur', 'alertes@craftpick.fr'], ['smtpPass', 'Mot de passe (ou mot de passe d’application)', '', 'password'], ['mailFrom', 'Expéditeur', 'Craftpick Status <alertes@craftpick.fr>'], ['mailTo', 'Destinataires (séparés par des virgules)', 'louis@craftpick.fr']],
  discord: [['webhookUrl', 'URL du webhook Discord', 'https://discord.com/api/webhooks/…'], ['username', 'Nom du bot (optionnel)', 'Craftpick Status']],
  slack: [['webhookUrl', 'URL du webhook Slack', 'https://hooks.slack.com/services/…']],
  telegram: [['botToken', 'Token du bot', '123456:ABC…'], ['chatId', 'Chat ID', '-1001234567']],
  ntfy: [['server', 'Serveur', 'https://ntfy.sh'], ['topic', 'Topic', 'craftpick-alertes']],
  gotify: [['server', 'URL du serveur Gotify', 'https://gotify.exemple.fr'], ['token', "Jeton d'application", 'AbC…']],
  pushover: [['token', "Jeton d'application (API token)", 'azGDORePK8gMaC0…'], ['userKey', 'Clé utilisateur', 'uQiRzpo4DXghDmr…']],
  webhook: [['url', 'URL (POST JSON)', 'https://exemple.fr/hook']],
};
async function openNotifications() {
  await loadNotifications();
  const el = modal(`
    <div class="panel-head"><h2 style="margin:0">Notifications</h2><button class="btn primary" id="n-new">＋ Nouvelle</button></div>
    ${notifications.length ? notifications.map((n) => `<div class="list-item"><div><b>🔔 ${esc(n.name)}</b><div class="muted small">${esc(n.type)}${n.applyAll ? ' · tous les monitors' : ''}${n.active === false ? ' · désactivée' : ''}</div></div>
      <div class="actions"><button class="btn sm" data-edit="${n.id}">Modifier</button><button class="btn sm danger" data-del="${n.id}">✕</button></div></div>`).join('')
      : '<p class="muted">Aucune notification. Ajoute Discord, Slack, Telegram, ntfy ou un webhook pour être alerté des pannes.</p>'}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Fermer</button></div>`);
  $('#n-new', el).onclick = () => notifForm();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => notifForm(notifications.find((n) => n.id === Number(b.dataset.edit)))));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => { if (confirm('Supprimer cette notification ?')) { await api('/api/notifications/' + b.dataset.del, { method: 'DELETE' }); openNotifications(); } }));
}
function notifForm(n) {
  const isEdit = !!n;
  n = { type: 'discord', active: true, config: {}, ...(n || {}) };
  const el = modal(`
    <h2>${isEdit ? 'Modifier la notification' : 'Nouvelle notification'}</h2>
    <form id="nform">
      <div class="row">
        <div class="field"><label>Type</label><select name="type">${Object.keys(NOTIF_FIELDS).map((k) => `<option value="${k}" ${n.type === k ? 'selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select></div>
        <div class="field"><label>Nom</label><input name="name" required value="${esc(n.name || '')}" placeholder="Discord équipe"></div>
      </div>
      <div id="n-fields"></div>
      <label class="check"><input type="checkbox" name="applyAll" ${n.applyAll ? 'checked' : ''}> Appliquer à tous les monitors</label>
      <label class="check"><input type="checkbox" name="active" ${n.active !== false ? 'checked' : ''}> Activée</label>
      <div class="modal-foot"><button type="button" class="btn" id="n-test">Envoyer un test</button><button type="button" class="btn ghost" id="n-back">Retour</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`);
  const form = $('#nform', el);
  const fields = () => { $('#n-fields', el).innerHTML = NOTIF_FIELDS[form.type.value].map(([k, l, ph, t]) => t === 'checkbox'
    ? `<label class="check"><input type="checkbox" data-cfg="${k}" ${n.config[k] ? 'checked' : ''}> ${l}</label>`
    : `<div class="field"><label>${l}</label><input ${t === 'password' ? 'type="password" autocomplete="new-password"' : ''} data-cfg="${k}" value="${esc(n.config[k] || '')}" placeholder="${esc(ph)}"></div>`).join(''); };
  form.type.onchange = fields; fields();
  const collect = () => { const d = formData(form); d.config = {}; $$('[data-cfg]', el).forEach((i) => (d.config[i.dataset.cfg] = i.type === 'checkbox' ? i.checked : i.value)); return d; };
  $('#n-back', el).onclick = openNotifications;
  $('#n-test', el).onclick = async () => { const r = await api('/api/notifications/test', { method: 'POST', body: collect() }); r.ok ? toast('Notification de test envoyée ✓') : toast('Échec : ' + r.error, true); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(isEdit ? '/api/notifications/' + n.id : '/api/notifications', { method: isEdit ? 'PUT' : 'POST', body: collect() }); toast('Notification enregistrée'); openNotifications(); }
    catch (err) { toast(err.message, true); }
  };
}

// Pages de status
async function openPages() {
  pages = await api('/api/pages');
  const el = modal(`
    <div class="panel-head"><h2 style="margin:0">Pages de status</h2><button class="btn primary" id="p-new">＋ Nouvelle page</button></div>
    <p class="muted small" style="margin-top:0">La page principale (<a href="/" target="_blank">/</a>) affiche les monitors publics. Crée des pages dédiées — par exemple « joueurs » ou « infra » — avec leur propre sélection de services, éventuellement protégées par mot de passe.</p>
    ${pages.length ? pages.map((p) => `<div class="list-item">
      <div style="min-width:0"><b>${p.protected ? '🔒 ' : ''}${esc(p.title)}</b>
        <div class="small muted"><a href="/s/${esc(p.slug)}" target="_blank">/s/${esc(p.slug)}</a> · ${p.monitorIds.length} service(s)</div></div>
      <div class="actions"><button class="btn sm" data-edit="${p.id}">Modifier</button><button class="btn sm danger" data-del="${p.id}">✕</button></div>
    </div>`).join('') : '<p class="muted">Aucune page dédiée pour le moment.</p>'}
    <div class="modal-foot"><button class="btn" onclick="closeModal()">Fermer</button></div>`, true);
  $('#p-new', el).onclick = () => pageForm();
  $$('[data-edit]', el).forEach((b) => (b.onclick = () => pageForm(pages.find((p) => p.id === Number(b.dataset.edit)))));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => { if (confirm('Supprimer cette page ? Les monitors ne sont pas supprimés.')) { await api('/api/pages/' + b.dataset.del, { method: 'DELETE' }); openPages(); } }));
}
function pageForm(p) {
  const isEdit = !!p;
  p = { monitorIds: [], ...(p || {}) };
  const sel = new Set(p.monitorIds);
  // Ordre d'affichage : d'abord ceux de la page dans leur ordre, puis les autres
  const ordered = [...p.monitorIds.map((id) => monitors.find((m) => m.id === id)).filter(Boolean), ...monitors.filter((m) => !sel.has(m.id))];
  const el = modal(`
    <h2>${isEdit ? 'Modifier la page' : 'Nouvelle page de status'}</h2>
    <form id="pform">
      <div class="row">
        <div class="field"><label>Titre</label><input name="title" required value="${esc(p.title || '')}" placeholder="Craftpick — Joueurs"></div>
        <div class="field"><label>Adresse</label><div style="display:flex;align-items:center;gap:6px"><span class="muted small">/s/</span><input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{0,39}" value="${esc(p.slug || '')}" placeholder="joueurs"></div></div>
      </div>
      <div class="field"><label>Description</label><input name="description" value="${esc(p.description || '')}"></div>
      <div class="row">
        <div class="field"><label>URL du logo (optionnel)</label><input name="logoUrl" value="${esc(p.logoUrl || '')}"></div>
        <div class="field"><label>Pied de page (optionnel)</label><input name="footer" value="${esc(p.footer || '')}"></div>
      </div>
      <fieldset><legend>Services affichés (dans cet ordre)</legend>
        ${ordered.length ? ordered.map((m) => `<div class="check" style="justify-content:space-between" data-mid="${m.id}">
          <label class="check" style="margin:0;flex:1"><input type="checkbox" data-pm="${m.id}" ${sel.has(m.id) ? 'checked' : ''}> <span class="dot s${m.status}" style="animation:none"></span> ${esc(m.name)} <span class="muted small">${esc(TYPE_LABEL[m.type])}${m.config.isPublic ? '' : ' · privé'}</span></label>
          <span><button type="button" class="btn sm ghost" data-up="${m.id}" title="Monter">↑</button><button type="button" class="btn sm ghost" data-down="${m.id}" title="Descendre">↓</button></span>
        </div>`).join('') : '<p class="muted small">Aucun monitor.</p>'}
        <p class="muted small">Un monitor « privé » (non public) peut quand même apparaître ici : pratique pour une page interne protégée.</p>
      </fieldset>
      <fieldset><legend>Protection</legend>
        <div class="field"><label>${p.protected ? 'Nouveau mot de passe (laisser vide pour conserver)' : 'Mot de passe (laisser vide = page publique)'}</label><input type="password" name="password" autocomplete="new-password"></div>
        ${p.protected ? '<label class="check"><input type="checkbox" name="removePassword"> Retirer la protection</label>' : ''}
      </fieldset>
      <div class="modal-foot"><button type="button" class="btn ghost" id="p-back">Retour</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`);
  const form = $('#pform', el);
  if (!isEdit) form.elements.title.oninput = () => { if (!form.slug.dataset.touched) form.slug.value = form.elements.title.value.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); };
  form.slug.oninput = () => (form.slug.dataset.touched = '1');
  // Réordonner
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-up],[data-down]');
    if (!b) return;
    const row = b.closest('[data-mid]');
    if (b.dataset.up && row.previousElementSibling && row.previousElementSibling.dataset.mid) row.parentNode.insertBefore(row, row.previousElementSibling);
    if (b.dataset.down && row.nextElementSibling && row.nextElementSibling.dataset.mid) row.parentNode.insertBefore(row.nextElementSibling, row);
  });
  $('#p-back', el).onclick = openPages;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = {
      title: form.elements.title.value, slug: form.slug.value, description: form.description.value, logoUrl: form.logoUrl.value, footer: form.footer.value,
      password: form.password.value, removePassword: form.removePassword ? form.removePassword.checked : false,
      monitorIds: $$('[data-pm]', form).filter((c) => c.checked).map((c) => Number(c.dataset.pm)),
    };
    try {
      await api(isEdit ? '/api/pages/' + p.id : '/api/pages', { method: isEdit ? 'PUT' : 'POST', body: d });
      toast('Page enregistrée');
      openPages();
    } catch (err) { toast(err.message, true); }
  };
}

// Paramètres
async function openSettings() {
  const s = await api('/api/settings');
  await loadNotifications();
  const dl = s.discordLive, wr = s.weeklyReport;
  const pageOpts = (sel) => `<option value="">Page principale (/)</option>${s.pages.map((p) => `<option value="${esc(p.slug)}" ${sel === p.slug ? 'selected' : ''}>${esc(p.title)} (/s/${esc(p.slug)})${p.protected ? ' 🔒' : ''}</option>`).join('')}`;
  const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
  const el = modal(`
    <h2>Paramètres</h2>
    <form id="sform">
      <fieldset><legend>Page publique</legend>
        <div class="field"><label>Titre</label><input name="title" value="${esc(s.title)}"></div>
        <div class="field"><label>Description</label><input name="description" value="${esc(s.description)}"></div>
        <div class="field"><label>URL du logo</label><input name="logoUrl" value="${esc(s.logoUrl)}" placeholder="https://…/logo.png"></div>
        <div class="field"><label>Texte de pied de page</label><input name="footer" value="${esc(s.footer)}" placeholder="© Craftpick"></div>
        <div class="field"><label>URL publique de la page de status (liens Discord, flux…)</label><input name="publicUrl" value="${esc(s.publicUrl)}" placeholder="https://status.craftpick.fr"></div>
      </fieldset>

      <fieldset><legend>🎨 Personnalisation</legend>
        <div class="row">
          <div class="field"><label>Couleur d'accent</label><div style="display:flex;gap:8px;align-items:center"><input type="color" id="ac-color" value="${esc(s.accentColor || '#2ecc71')}" style="width:56px;height:40px;padding:3px"><label class="check" style="margin:0"><input type="checkbox" id="ac-on" ${s.accentColor ? 'checked' : ''}> Utiliser</label></div></div>
          <div class="field"><label>Bannière : style</label><select id="bn-level">${[['info', 'ℹ️ Information'], ['event', '🎉 Événement'], ['success', '✅ Bonne nouvelle'], ['warning', '⚠️ Avertissement']].map(([k, v]) => `<option value="${k}" ${s.banner.level === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label>Bannière d'annonce (vide = masquée)</label><input id="bn-text" value="${esc(s.banner.text)}" placeholder="🎉 Event PvP ce soir à 21h sur play.craftpick.fr !"></div>
        <div class="field"><label>Lien de la bannière (optionnel)</label><input id="bn-link" value="${esc(s.banner.link)}" placeholder="https://discord.gg/craftpick"></div>
        <div class="field"><label>CSS personnalisé (page publique, pages dédiées, widget)</label><textarea id="css" placeholder=".brand h1 { color: #ffb400; }">${esc(s.customCss)}</textarea></div>
      </fieldset>

      <fieldset><legend>💬 Message Discord en direct</legend>
        <p class="muted small" style="margin-top:0">Un message unique dans ton salon, modifié automatiquement à chaque changement d'état (et toutes les 2 min pour les joueurs). Salon → Paramètres → Intégrations → Webhooks.</p>
        <label class="check"><input type="checkbox" id="dl-on" ${dl.enabled ? 'checked' : ''}> Activer</label>
        <div class="field"><label>URL du webhook Discord</label><input id="dl-url" value="${esc(dl.webhookUrl)}" placeholder="https://discord.com/api/webhooks/…"></div>
        <div class="row">
          <div class="field"><label>Services affichés</label><select id="dl-page">${pageOpts(dl.page)}</select></div>
          <div class="field"><label>Nom du bot</label><input id="dl-name" value="${esc(dl.username)}" placeholder="Craftpick Status"></div>
        </div>
        <div class="actions" style="margin-bottom:12px;align-items:center"><button type="button" class="btn sm" id="dl-pub">Publier maintenant</button>
          <span class="small ${dl.lastError ? '' : 'muted'}" style="${dl.lastError ? 'color:var(--down)' : ''}">${dl.lastError ? '⚠ ' + esc(dl.lastError) : dl.messageId ? '✓ Message actif' : ''}</span></div>
      </fieldset>

      <fieldset><legend>📊 Rapport hebdomadaire</legend>
        <label class="check"><input type="checkbox" id="wr-on" ${wr.enabled ? 'checked' : ''}> Envoyer automatiquement un rapport de disponibilité chaque semaine</label>
        <div class="row">
          <div class="field"><label>Jour</label><select id="wr-day">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<option value="${d}" ${wr.day === d ? 'selected' : ''}>${DAYS[d]}</option>`).join('')}</select></div>
          <div class="field"><label>Heure</label><select id="wr-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${wr.hour === h ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div>
        </div>
        <div style="margin-bottom:10px">${notifications.length ? notifications.map((n) => `<label class="check"><input type="checkbox" data-wr="${n.id}" ${(wr.notificationIds || []).includes(n.id) ? 'checked' : ''}> 🔔 ${esc(n.name)} <span class="muted small">(${esc(n.type)})</span></label>`).join('') : '<p class="muted small">Ajoute d’abord une notification (menu « Notifications »).</p>'}</div>
        <div class="actions" style="margin-bottom:12px"><button type="button" class="btn sm" id="wr-prev">Aperçu</button><button type="button" class="btn sm" id="wr-send">Envoyer maintenant</button></div>
        <pre id="wr-out" class="small hidden" style="white-space:pre-wrap;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;margin:0 0 12px"></pre>
      </fieldset>

      <fieldset><legend>🧩 Widget à intégrer sur ton site</legend>
        <div class="row">
          <div class="field"><label>Services</label><select id="wg-page">${pageOpts('')}</select></div>
          <div class="field"><label>Thème</label><select id="wg-theme"><option value="">Automatique</option><option value="light">Clair</option><option value="dark">Sombre</option></select></div>
        </div>
        <label class="check"><input type="checkbox" id="wg-up"> Afficher la disponibilité sur 30 jours</label>
        <div class="field"><label>Code à coller dans ton site</label><textarea id="wg-code" readonly onclick="this.select()" style="min-height:64px"></textarea></div>
        <iframe id="wg-prev" style="width:100%;max-width:420px;height:260px;border:0;border-radius:12px" title="Aperçu du widget"></iframe>
      </fieldset>

      <fieldset><legend>Changer le mot de passe</legend>
        <div class="row">
          <div class="field"><label>Mot de passe actuel</label><input type="password" name="currentPassword" autocomplete="current-password"></div>
          <div class="field"><label>Nouveau mot de passe</label><input type="password" name="newPassword" autocomplete="new-password"></div>
        </div>
      </fieldset>
      <fieldset><legend>Sauvegarde</legend>
        <div class="actions" style="margin-bottom:12px">
          <a class="btn" href="/api/export">⬇ Exporter la configuration</a>
          <label class="btn" style="margin:0;color:var(--text)">⬆ Importer<input type="file" accept=".json" id="imp" hidden></label>
          <button type="button" class="btn" id="bk-now">💾 Sauvegarder maintenant</button>
        </div>
        <p class="muted small" style="margin-top:0">Sauvegarde automatique chaque jour dans <code>data/backups/</code> (14 dernières conservées).</p>
        <div id="bk-list" style="margin-bottom:12px"></div>
      </fieldset>
      <div class="modal-foot"><button type="button" class="btn ghost" onclick="closeModal()">Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`, true);

  // Widget : code + aperçu
  const widget = () => {
    const q = new URLSearchParams();
    if ($('#wg-page', el).value) q.set('page', $('#wg-page', el).value);
    if ($('#wg-theme', el).value) q.set('theme', $('#wg-theme', el).value);
    if ($('#wg-up', el).checked) q.set('uptime', '1');
    const base = (s.publicUrl || location.origin).replace(/\/+$/, '');
    const src = `${base}/embed${q.toString() ? '?' + q : ''}`;
    $('#wg-code', el).value = `<iframe src="${src}" style="width:100%;max-width:420px;height:320px;border:0" title="Statut des services" loading="lazy"></iframe>`;
    $('#wg-prev', el).src = `/embed${q.toString() ? '?' + q : ''}`;
  };
  ['#wg-page', '#wg-theme', '#wg-up'].forEach((sel) => ($(sel, el).onchange = widget));
  widget();

  const paintBackups = (list) => {
    $('#bk-list', el).innerHTML = list.length ? list.slice(0, 14).map((b) => `<div class="list-item" style="padding:8px 12px"><span class="small">${esc(b.name)} <span class="muted">· ${Math.round(b.size / 1024)} Ko · ${fmtDate(b.date)}</span></span><a class="btn sm" href="/api/backups/${encodeURIComponent(b.name)}">⬇</a></div>`).join('') : '<p class="muted small">Aucune sauvegarde pour le moment.</p>';
  };
  paintBackups(s.backups || []);
  $('#bk-now', el).onclick = async () => { const r = await api('/api/backups', { method: 'POST' }); paintBackups(r.backups); toast('Sauvegarde créée ✓'); };
  const collect = () => {
    const d = formData($('#sform', el));
    d.accentColor = $('#ac-on', el).checked ? $('#ac-color', el).value : '';
    d.banner = { text: $('#bn-text', el).value, level: $('#bn-level', el).value, link: $('#bn-link', el).value.trim() };
    d.customCss = $('#css', el).value;
    d.discordLive = { enabled: $('#dl-on', el).checked, webhookUrl: $('#dl-url', el).value.trim(), page: $('#dl-page', el).value, username: $('#dl-name', el).value };
    d.weeklyReport = { enabled: $('#wr-on', el).checked, day: Number($('#wr-day', el).value), hour: Number($('#wr-hour', el).value), notificationIds: $$('[data-wr]', el).filter((c) => c.checked).map((c) => Number(c.dataset.wr)) };
    return d;
  };
  $('#dl-pub', el).onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: collect() });
      const r = await api('/api/discord-live/publish', { method: 'POST' });
      r.ok ? toast(r.created ? 'Message Discord publié ✓' : 'Message Discord mis à jour ✓') : toast('Discord : ' + r.error, true);
    } catch (err) { toast(err.message, true); }
  };
  $('#wr-prev', el).onclick = async () => {
    const r = await api('/api/report/preview');
    const out = $('#wr-out', el);
    out.textContent = `${r.title}\n\n${r.text.replace(/\*\*/g, '')}`;
    out.classList.remove('hidden');
  };
  $('#wr-send', el).onclick = async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: collect() });
      const r = await api('/api/report/send', { method: 'POST' });
      r.errors.length ? toast('Erreurs : ' + r.errors.join(' ; '), true) : toast(`Rapport envoyé (${r.sent}) ✓`);
    } catch (err) { toast(err.message, true); }
  };
  $('#imp', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await api('/api/import', { method: 'POST', body: JSON.parse(await f.text()) }); toast(`${r.imported} monitor(s) importé(s)`); await Promise.all([loadMonitors(), loadNotifications()]); }
    catch (err) { toast(err.message, true); }
  };
  $('#sform', el).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = collect();
      await api('/api/settings', { method: 'PUT', body: d });
      $('#app-title').textContent = d.title;
      toast('Paramètres enregistrés'); closeModal();
    } catch (err) { toast(err.message, true); }
  };
}

init();
