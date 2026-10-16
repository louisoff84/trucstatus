// Utilitaires partagés (page publique + admin)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABEL = { 1: 'En ligne', 0: 'Hors ligne', 2: 'En attente', 3: 'Maintenance', 4: 'Dégradé', '-1': 'En pause' };
const INC_STATUS = { investigating: 'Enquête en cours', identified: 'Problème identifié', monitoring: 'Sous surveillance', resolved: 'Résolu', scheduled: 'Planifiée', inprogress: 'En cours' };
const SEV_LABEL = { info: 'Information', warning: 'Dégradation', danger: 'Panne majeure', maintenance: 'Maintenance' };

const fmtPct = (v, d = 2) => (v == null ? '—' : (v >= 100 ? '100' : v.toFixed(d)) + ' %');
const fmtMs = (v) => (v == null ? '—' : v + ' ms');
const fmtDate = (t) => new Date(t).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDay = (k) => new Date(k + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
function ago(t) {
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return `il y a ${Math.max(0, s)} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}

// Classe CSS d'une barre journalière
function dayClass(b) {
  if (b.u == null) return '';
  if (b.u >= 99.9) return b.dg ? 'b4' : 'b1';
  if (b.u >= 95) return 'bpart';
  return 'b0';
}
function dayBarsHTML(bars) {
  return bars.map((b) => `<i class="${dayClass(b)}" data-tip="${esc(
    `<b>${fmtDay(b.d)}</b><br>` + (b.u == null ? 'Aucune donnée' : `Disponibilité : ${fmtPct(b.u)}${b.down ? `<br>${b.down} vérification(s) en échec` : ''}${b.dg ? `<br>${b.dg} vérification(s) dégradée(s)` : ''}${b.p != null ? `<br>Ping moyen : ${b.p} ms` : ''}`)
  )}"></i>`).join('');
}
function beatBarsHTML(beats, n = 40) {
  const list = beats.slice(-n);
  const pad = Array(Math.max(0, n - list.length)).fill('<i></i>').join('');
  return pad + list.map((b) => `<i class="b${b.s}" data-tip="${esc(`<b>${fmtDate(b.t)}</b><br>${STATUS_LABEL[b.s]}${b.p != null ? ` · ${b.p} ms` : ''}${b.m ? `<br>${esc(b.m)}` : ''}`)}"></i>`).join('');
}

// Thème : auto → clair → sombre (mémorisé dans le navigateur)
(function () {
  const root = document.documentElement;
  const get = () => { try { return localStorage.getItem('cs-theme') || 'auto'; } catch { return 'auto'; } };
  const apply = (t) => { if (t === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', t); };
  apply(get());
  const label = { auto: '🌓', light: '☀️', dark: '🌙' };
  const title = { auto: 'Thème : automatique', light: 'Thème : clair', dark: 'Thème : sombre' };
  const init = () => {
    document.querySelectorAll('.theme-toggle').forEach((b) => {
      const paint = () => { b.textContent = label[get()]; b.title = title[get()]; };
      paint();
      b.addEventListener('click', () => {
        const next = { auto: 'light', light: 'dark', dark: 'auto' }[get()];
        try { localStorage.setItem('cs-theme', next); } catch {}
        apply(next); paint();
        if (typeof drawChart === 'function') drawChart();
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

// Infobulles
(function () {
  let tip;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el) { if (tip) tip.remove(), (tip = null); return; }
    if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
    tip.innerHTML = el.dataset.tip;
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, left));
    let top = r.top - tr.height - 8;
    if (top < 8) top = r.bottom + 8;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  });
  document.addEventListener('scroll', () => { if (tip) tip.remove(), (tip = null); }, true);
})();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : (opts.method && opts.method !== 'GET' ? '{}' : undefined),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `Erreur ${res.status}`); err.status = res.status; throw err; }
  return data;
}

function toast(msg, err = false) {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// Mini-courbe SVG (joueurs Minecraft sur 24 h)
function sparklineSVG(values, { w = 240, h = 32 } = {}) {
  const pts = values.map((v, i) => (v == null ? null : [i, v]));
  const vals = values.filter((v) => v != null);
  if (!vals.length) return '';
  const max = Math.max(1, ...vals);
  const x = (i) => (i / Math.max(1, values.length - 1)) * (w - 2) + 1;
  const y = (v) => h - 2 - (v / max) * (h - 4);
  let d = '', open = false;
  if (vals.length === 1) d = `M1 ${y(vals[0]).toFixed(1)} L${w - 1} ${y(vals[0]).toFixed(1)}`; // un seul point : ligne plate
  else for (const p of pts) {
    if (!p) { open = false; continue; }
    d += (open ? 'L' : 'M') + x(p[0]).toFixed(1) + ' ' + y(p[1]).toFixed(1) + ' ';
    open = true;
  }
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// Personnalisation : couleur d'accent, CSS perso, bannière d'annonce
function applyBranding(meta, bannerTarget) {
  if (!meta) return;
  if (meta.accentColor) document.documentElement.style.setProperty('--accent', meta.accentColor);
  let st = document.getElementById('custom-css');
  if (meta.customCss) {
    if (!st) { st = document.createElement('style'); st.id = 'custom-css'; document.head.appendChild(st); }
    st.textContent = meta.customCss;
  } else if (st) st.remove();
  if (bannerTarget) {
    const b = meta.banner;
    bannerTarget.innerHTML = b && b.text ? `<div class="banner ${esc(b.level)}">${{ info: 'ℹ️', success: '✅', warning: '⚠️', event: '🎉' }[b.level] || 'ℹ️'} <span>${esc(b.text)}</span>${b.link ? ` <a href="${esc(b.link)}" target="_blank" rel="noopener">En savoir plus →</a>` : ''}</div>` : '';
  }
}

function liveEvents(onBeat, onRefresh, page) {
  const es = new EventSource('/api/events' + (page ? '?page=' + encodeURIComponent(page) : ''));
  es.addEventListener('beat', (e) => onBeat(JSON.parse(e.data)));
  es.addEventListener('refresh', () => onRefresh && onRefresh());
  return es;
}
