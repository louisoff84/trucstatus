// Tableau de bord d'administration
let monitors = [];
let notifications = [];
let selectedId = null;
let chartHours = 24;
let chartBeats = [];

const TYPE_LABEL = { http: 'HTTP(S)', keyword: 'HTTP(S) — Mot-clé', json: 'HTTP(S) — Requête JSON', tcp: 'Port TCP', ping: 'Ping', dns: 'DNS', push: 'Push (heartbeat)' };

// Alertes du navigateur quand un monitor change d'état
function browserAlert(m, beat) {
  try {
    if (localStorage.getItem('cs-browser-alerts') !== '1' || !('Notification' in window) || Notification.permission !== 'granted') return;
    new Notification(`${beat.s === 1 ? '✅' : '🔴'} ${m.name} — ${STATUS_LABEL[beat.s]}`, { body: beat.m || '', icon: '/favicon.svg', tag: 'cs-' + m.id });
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
$$('[data-open]').forEach((b) => (b.onclick = () => ({ incidents: openIncidents, notifications: openNotifications, settings: openSettings })[b.dataset.open]()));
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
    if ((beat.s === 0 || beat.s === 1) && m.status !== undefined) browserAlert(m, beat);
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
        </div>
        <div class="actions">
          <button class="btn" id="d-toggle">${m.config.active ? '⏸ Pause' : '▶ Reprendre'}</button>
          <button class="btn" id="d-edit">✏️ Modifier</button>
          <button class="btn" id="d-clone">⧉ Dupliquer</button>
          <button class="btn danger" id="d-del">Supprimer</button>
        </div>
      </div>
      <div class="bars" style="margin-top:20px;height:30px">${beatBarsHTML(m.recent, 60)}</div>
    </div>

    <div class="stats" style="margin-bottom:20px">
      <div class="card stat"><div class="k">Réponse actuelle</div><div class="v">${m.ping ?? '—'}<small>${m.ping != null ? ' ms' : ''}</small></div></div>
      <div class="card stat"><div class="k">Moyenne (24 h)</div><div class="v">${m.avgPing24 ?? '—'}<small>${m.avgPing24 != null ? ' ms' : ''}</small></div></div>
      <div class="card stat"><div class="k">Disponibilité 24 h</div><div class="v">${fmtPct(m.uptime24)}</div></div>
      <div class="card stat"><div class="k">Disponibilité 30 j</div><div class="v">${fmtPct(m.uptime30)}</div></div>
      ${cert ? `<div class="card stat"><div class="k">Certificat TLS</div><div class="v" style="color:${cert.daysLeft < 14 ? 'var(--down)' : 'inherit'}">${cert.daysLeft}<small> j</small></div><div class="muted small">${esc(cert.issuer || '')}</div></div>` : ''}
    </div>

    <div class="card panel">
      <div class="panel-head"><h3>Temps de réponse</h3>
        <div class="tabs" id="ranges">${[[1, '1 h'], [6, '6 h'], [24, '24 h'], [168, '7 j']].map(([h, l]) => `<button data-h="${h}" class="${h === chartHours ? 'on' : ''}">${l}</button>`).join('')}</div>
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
  loadChart();
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
  const cUp = css.getPropertyValue('--up').trim(), cDown = css.getPropertyValue('--down').trim(), cMaint = css.getPropertyValue('--maint').trim();
  const pad = { l: 48, r: 12, t: 12, b: 26 };
  const now = Date.now(), t0 = now - chartHours * 3600e3;
  const pts = chartBeats.filter((b) => b.t >= t0);
  const pings = pts.filter((b) => b.s === 1 && b.p != null).map((b) => b.p);
  const maxP = Math.max(50, ...pings) * 1.15;
  const x = (t) => pad.l + ((t - t0) / (now - t0)) * (W - pad.l - pad.r);
  const y = (p) => pad.t + (1 - p / maxP) * (H - pad.t - pad.b);

  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.fillStyle = cMuted; ctx.strokeStyle = cBorder; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (maxP / 4) * i, yy = y(v);
    ctx.globalAlpha = .6; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(W - pad.r, yy); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.textAlign = 'right'; ctx.fillText(Math.round(v) + ' ms', pad.l - 6, yy + 4);
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
    if (b.s === 0 || b.s === 3) {
      ctx.fillStyle = b.s === 0 ? cDown : cMaint; ctx.globalAlpha = .22;
      ctx.fillRect(x(b.t) - 2, pad.t, 4, H - pad.t - pad.b);
      ctx.globalAlpha = 1;
    }
  }
  if (!pings.length) {
    ctx.fillStyle = cMuted; ctx.font = '13px Inter, system-ui'; ctx.fillText('Pas encore de données', W / 2, H / 2);
    return;
  }
  // Courbe + remplissage
  const up = pts.filter((b) => b.s === 1 && b.p != null);
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, cUp + '55'); grad.addColorStop(1, cUp + '00');
  ctx.beginPath();
  up.forEach((b, i) => (i ? ctx.lineTo(x(b.t), y(b.p)) : ctx.moveTo(x(b.t), y(b.p))));
  ctx.lineTo(x(up[up.length - 1].t), y(0)); ctx.lineTo(x(up[0].t), y(0)); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  ctx.beginPath();
  up.forEach((b, i) => (i ? ctx.lineTo(x(b.t), y(b.p)) : ctx.moveTo(x(b.t), y(b.p))));
  ctx.strokeStyle = cUp; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

  // Infobulle au survol
  cv.onmousemove = (e) => {
    const r = cv.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = null, bd = 1e9;
    for (const b of pts) { const d = Math.abs(x(b.t) - mx); if (d < bd) { bd = d; best = b; } }
    if (best && bd < 20) cv.dataset.tip = `<b>${fmtDate(best.t)}</b><br>${STATUS_LABEL[best.s]}${best.p != null ? ' · ' + best.p + ' ms' : ''}${best.m ? '<br>' + esc(best.m) : ''}`;
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
      <div class="field t-http"><label>URL</label><input name="url" value="${esc(c.url || '')}" placeholder="https://craftpick.fr"></div>
      <div class="row t-host">
        <div class="field"><label>Nom d'hôte / IP</label><input name="hostname" value="${esc(c.hostname || '')}" placeholder="craftpick.fr ou 192.168.1.10"></div>
        <div class="field t-tcp"><label>Port</label><input type="number" name="port" value="${c.port ?? ''}" placeholder="443"></div>
      </div>
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
          <div class="field"><label>Auth basique — mot de passe</label><input type="password" name="basicAuthPass" value="${esc(c.basicAuthPass || '')}" autocomplete="new-password"></div>
        </div>
        <label class="check"><input type="checkbox" name="ignoreTls" ${c.ignoreTls ? 'checked' : ''}> Ignorer les erreurs de certificat TLS</label>
        <label class="check"><input type="checkbox" name="certExpiryAlert" ${c.certExpiryAlert ? 'checked' : ''}> Alerter avant expiration du certificat</label>
        <div class="field" style="max-width:220px"><label>Jours avant expiration</label><input type="number" name="certExpiryDays" value="${c.certExpiryDays}"></div>
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
    $$('.t-host', form).forEach((x) => x.classList.toggle('hidden', http || t === 'push'));
    $$('.t-push', form).forEach((x) => x.classList.toggle('hidden', t !== 'push'));
    $$('.t-notpush', form).forEach((x) => x.classList.toggle('hidden', t === 'push'));
    $('#m-test', el).classList.toggle('hidden', t === 'push');
    $('#lbl-interval', el).textContent = t === 'push' ? 'Délai max entre deux push (s)' : 'Intervalle (s)';
    $$('.t-tcp', form).forEach((x) => x.classList.toggle('hidden', t !== 'tcp'));
    $$('.t-dns', form).forEach((x) => x.classList.toggle('hidden', t !== 'dns'));
    $$('.t-keyword', form).forEach((x) => x.classList.toggle('hidden', t !== 'keyword'));
    $$('.t-json', form).forEach((x) => x.classList.toggle('hidden', t !== 'json'));
  };
  form.type.onchange = sync; sync();
  const collect = () => { const d = formData(form); d.notificationIds ||= []; return d; };
  $('#m-test', el).onclick = async () => {
    $('#test-result').innerHTML = '<span class="muted">Test en cours…</span>';
    try {
      const r = await api('/api/monitors/test', { method: 'POST', body: collect() });
      $('#test-result').innerHTML = r.ok ? `<span style="color:var(--up)">✓ OK — ${esc(r.msg)} (${r.ping} ms)</span>` : `<span style="color:var(--down)">✗ ${esc(r.msg)}</span>`;
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
        <div class="small muted">${esc(SEV_LABEL[i.severity])} · ${esc(INC_STATUS[i.status])} · ${fmtDate(i.createdAt)}</div></div>
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
      <div class="row t-maint">
        <div class="field"><label>Début de la maintenance</label><input type="datetime-local" name="startsAt" value="${toLocalInput(i.startsAt)}"></div>
        <div class="field"><label>Fin prévue</label><input type="datetime-local" name="endsAt" value="${toLocalInput(i.endsAt)}"></div>
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
  const sync = () => $$('.t-maint', form).forEach((x) => x.classList.toggle('hidden', form.severity.value !== 'maintenance'));
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
    try {
      await api(isEdit ? '/api/incidents/' + i.id : '/api/incidents', { method: isEdit ? 'PUT' : 'POST', body: d });
      toast('Incident publié');
      openIncidents();
    } catch (err) { toast(err.message, true); }
  };
}

// Notifications
const NOTIF_FIELDS = {
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
  const fields = () => { $('#n-fields', el).innerHTML = NOTIF_FIELDS[form.type.value].map(([k, l, ph]) => `<div class="field"><label>${l}</label><input data-cfg="${k}" value="${esc(n.config[k] || '')}" placeholder="${esc(ph)}"></div>`).join(''); };
  form.type.onchange = fields; fields();
  const collect = () => { const d = formData(form); d.config = {}; $$('[data-cfg]', el).forEach((i) => (d.config[i.dataset.cfg] = i.value)); return d; };
  $('#n-back', el).onclick = openNotifications;
  $('#n-test', el).onclick = async () => { const r = await api('/api/notifications/test', { method: 'POST', body: collect() }); r.ok ? toast('Notification de test envoyée ✓') : toast('Échec : ' + r.error, true); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api(isEdit ? '/api/notifications/' + n.id : '/api/notifications', { method: isEdit ? 'PUT' : 'POST', body: collect() }); toast('Notification enregistrée'); openNotifications(); }
    catch (err) { toast(err.message, true); }
  };
}

// Paramètres
async function openSettings() {
  const s = await api('/api/settings');
  const el = modal(`
    <h2>Paramètres</h2>
    <form id="sform">
      <fieldset><legend>Page publique</legend>
        <div class="field"><label>Titre</label><input name="title" value="${esc(s.title)}"></div>
        <div class="field"><label>Description</label><input name="description" value="${esc(s.description)}"></div>
        <div class="field"><label>URL du logo</label><input name="logoUrl" value="${esc(s.logoUrl)}" placeholder="https://…/logo.png"></div>
        <div class="field"><label>Texte de pied de page</label><input name="footer" value="${esc(s.footer)}" placeholder="© Craftpick"></div>
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
        </div>
      </fieldset>
      <div class="modal-foot"><button type="button" class="btn ghost" onclick="closeModal()">Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`);
  $('#imp', el).onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await api('/api/import', { method: 'POST', body: JSON.parse(await f.text()) }); toast(`${r.imported} monitor(s) importé(s)`); await Promise.all([loadMonitors(), loadNotifications()]); }
    catch (err) { toast(err.message, true); }
  };
  $('#sform', el).onsubmit = async (e) => {
    e.preventDefault();
    try {
      const d = formData(e.target);
      await api('/api/settings', { method: 'PUT', body: d });
      $('#app-title').textContent = d.title;
      toast('Paramètres enregistrés'); closeModal();
    } catch (err) { toast(err.message, true); }
  };
}

init();
