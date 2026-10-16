// Message Discord « en direct » : un seul message publié via webhook, puis modifié à chaque changement
const http = require('http');
const https = require('https');
const db = require('./db');

const EMOJI = { 1: '🟢', 4: '🟠', 0: '🔴', 3: '🔧', 2: '⚪', '-1': '⏸️' };
const LABEL = { 1: 'En ligne', 4: 'Dégradé', 0: 'Hors ligne', 3: 'Maintenance', 2: 'Vérification…', '-1': 'En pause' };
const MIN_GAP = 15000; // Discord limite les modifications : au plus une toutes les 15 s

let getStatus = null;  // fonction (slug) => { title, monitors, incidents, url }
let timer = null;
let lastRun = 0;
let running = false;

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : '';
    const req = lib.request(u, { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 10000 }, (res) => {
      let txt = '';
      res.on('data', (c) => (txt += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(txt); } catch {} resolve({ status: res.statusCode, body: j, text: txt }); });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

function withPath(url, extra, params = {}) {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/+$/, '') + extra;
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function buildEmbed(st) {
  const ms = st.monitors;
  const down = ms.filter((m) => m.status === 0).length;
  const deg = ms.filter((m) => m.status === 4).length;
  const maint = ms.filter((m) => m.status === 3).length;
  const [color, headline] = !ms.length ? [0x6b7280, 'Aucun service surveillé']
    : down ? [0xe74c3c, `🔴 ${down} service${down > 1 ? 's' : ''} hors ligne`]
    : deg ? [0xf39c12, `🟠 Performances dégradées (${deg})`]
    : maint ? [0x3b82f6, '🔧 Maintenance en cours']
    : [0x2ecc71, '🟢 Tous les systèmes sont opérationnels'];

  const groups = {};
  for (const m of ms) (groups[m.group || 'Services'] ||= []).push(m);
  const fields = Object.entries(groups).slice(0, 20).map(([g, list]) => ({
    name: g,
    value: list.map((m) => {
      const extra = [];
      if (m.mc && (m.status === 1 || m.status === 4)) extra.push(`👥 ${m.mc.online}/${m.mc.max}`);
      if (m.ping != null && (m.status === 1 || m.status === 4)) extra.push(`${m.ping} ms`);
      return `${EMOJI[m.status] || '⚪'} **${m.name}** — ${LABEL[m.status] || ''}${extra.length ? ' · ' + extra.join(' · ') : ''}`;
    }).join('\n').slice(0, 1024),
  }));
  const active = (st.incidents || []).filter((i) => i.status !== 'resolved' && (i.severity !== 'maintenance' || i.activeNow));
  const desc = [headline, ...active.slice(0, 5).map((i) => `${i.severity === 'maintenance' ? '🔧' : '⚠️'} ${i.title}`)].join('\n');
  return {
    title: st.title,
    url: st.url || undefined,
    description: desc.slice(0, 4000),
    color,
    fields,
    footer: { text: 'Mis à jour automatiquement' },
    timestamp: new Date().toISOString(),
  };
}

// Publie ou met à jour le message ; renvoie { ok, messageId } ou lève une erreur
async function publish() {
  const cfg = db.data.settings.discordLive;
  if (!cfg || !cfg.webhookUrl || !getStatus) return { ok: false, error: 'Non configuré' };
  const st = getStatus(cfg.page || null);
  if (!st) throw new Error('Page introuvable');
  const body = { username: cfg.username || 'Craftpick Status', embeds: [buildEmbed(st)] };
  if (cfg.messageId) {
    const r = await request('PATCH', withPath(cfg.webhookUrl, `/messages/${cfg.messageId}`), { embeds: body.embeds });
    if (r.status < 300) { cfg.lastError = null; db.save(); return { ok: true, messageId: cfg.messageId }; }
    if (r.status !== 404) throw new Error(`Discord : HTTP ${r.status} ${r.text.slice(0, 150)}`);
    cfg.messageId = null; // message supprimé : on en recrée un
  }
  const r = await request('POST', withPath(cfg.webhookUrl, '', { wait: 'true' }), body);
  if (r.status >= 300 || !r.body || !r.body.id) throw new Error(`Discord : HTTP ${r.status} ${r.text.slice(0, 150)}`);
  cfg.messageId = r.body.id;
  cfg.lastError = null;
  db.save();
  return { ok: true, messageId: cfg.messageId, created: true };
}

async function run() {
  const cfg = db.data.settings.discordLive;
  if (!cfg || !cfg.enabled || running) return;
  running = true;
  lastRun = Date.now();
  try { await publish(); }
  catch (e) { cfg.lastError = e.message; db.save(); console.error('[discord-live]', e.message); }
  finally { running = false; }
}

// Demande une mise à jour (anti-rebond + délai minimal entre deux modifications)
function schedule(delay = 3000) {
  const cfg = db.data.settings.discordLive;
  if (!cfg || !cfg.enabled || timer) return;
  const wait = Math.max(delay, MIN_GAP - (Date.now() - lastRun));
  timer = setTimeout(() => { timer = null; run(); }, wait);
}

function start(statusFn) {
  getStatus = statusFn;
  setTimeout(() => schedule(0), 5000);
  // rafraîchissement régulier (joueurs, ping) toutes les 2 minutes
  setInterval(() => schedule(0), 120000).unref();
}

module.exports = { start, schedule, publish, buildEmbed };
