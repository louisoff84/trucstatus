// Moteur de surveillance : HTTP(S), mot-clé, JSON, TCP, ping, DNS
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const db = require('./db');
const notify = require('./notify');

const timers = new Map();   // monitorId -> timeout
const state = new Map();    // monitorId -> { status, retries, cert, lastBeat }
let emit = () => {};

function statusMatches(code, spec) {
  return String(spec || '200-299').split(',').some((part) => {
    part = part.trim();
    if (part.includes('-')) { const [a, b] = part.split('-').map(Number); return code >= a && code <= b; }
    return code === Number(part);
  });
}

function checkHttp(m) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(m.url); } catch { return reject(new Error('URL invalide')); }
    const lib = u.protocol === 'https:' ? https : http;
    const start = Date.now();
    let headers = { 'User-Agent': 'CraftpickStatus/1.0', Accept: '*/*' };
    if (m.headers) { try { Object.assign(headers, JSON.parse(m.headers)); } catch {} }
    if (m.body) headers['Content-Type'] ||= 'application/json';
    const req = lib.request(u, {
      method: m.method || 'GET',
      headers,
      timeout: (m.timeout || 30) * 1000,
      rejectUnauthorized: !m.ignoreTls,
    }, (res) => {
      let cert = null;
      if (res.socket && typeof res.socket.getPeerCertificate === 'function') {
        const c = res.socket.getPeerCertificate();
        if (c && c.valid_to) cert = { validTo: new Date(c.valid_to).toISOString(), issuer: c.issuer && (c.issuer.O || c.issuer.CN), daysLeft: Math.floor((new Date(c.valid_to) - Date.now()) / 86400000) };
      }
      const needBody = m.type === 'keyword' || m.type === 'json';
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (needBody && body.length < 2e6) body += chunk; });
      res.on('end', () => {
        const ping = Date.now() - start;
        if (!statusMatches(res.statusCode, m.expectedStatus)) return reject(new Error(`Code HTTP ${res.statusCode} inattendu`));
        if (m.type === 'keyword') {
          const found = m.caseSensitive ? body.includes(m.keyword) : body.toLowerCase().includes(String(m.keyword).toLowerCase());
          if (found === !!m.invertKeyword) return reject(new Error(m.invertKeyword ? `Mot-clé « ${m.keyword} » trouvé` : `Mot-clé « ${m.keyword} » introuvable`));
        }
        if (m.type === 'json') {
          let val;
          try { val = String(m.jsonPath).split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), JSON.parse(body)); }
          catch { return reject(new Error('Réponse JSON invalide')); }
          if (String(val) !== String(m.jsonExpected)) return reject(new Error(`${m.jsonPath} = ${JSON.stringify(val)} (attendu ${m.jsonExpected})`));
        }
        resolve({ ping, msg: `${res.statusCode} ${res.statusMessage || 'OK'}`, cert });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Timeout après ${m.timeout || 30} s`)));
    req.on('error', reject);
    req.end(m.body || undefined);
  });
}

function checkTcp(m) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host: m.hostname, port: Number(m.port) });
    sock.setTimeout((m.timeout || 30) * 1000);
    sock.on('connect', () => { const ping = Date.now() - start; sock.destroy(); resolve({ ping, msg: `Port ${m.port} ouvert` }); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('Timeout')); });
    sock.on('error', (e) => reject(e));
  });
}

function checkPing(m) {
  return new Promise((resolve, reject) => {
    const win = process.platform === 'win32';
    const t = m.timeout || 10;
    const args = win ? ['-n', '1', '-w', String(t * 1000), m.hostname] : ['-c', '1', '-W', String(t), m.hostname];
    const start = Date.now();
    execFile('ping', args, { timeout: (t + 2) * 1000, windowsHide: true }, (err, stdout) => {
      const out = String(stdout || '');
      const match = out.match(/(?:time|temps)[=<]\s*([\d.,]+)\s*ms/i);
      // Sous Windows, ping peut renvoyer 0 même si "Impossible de joindre l'hôte"
      if (err || !match) return reject(new Error('Hôte injoignable'));
      resolve({ ping: Math.round(parseFloat(match[1].replace(',', '.'))) || Date.now() - start, msg: 'Réponse ICMP' });
    });
  });
}

async function checkDns(m) {
  const start = Date.now();
  const type = m.dnsType || 'A';
  if (m.dnsServer) {
    const r = new (require('dns').promises.Resolver)();
    r.setServers([m.dnsServer]);
    const res = await r.resolve(m.hostname, type);
    return { ping: Date.now() - start, msg: `${type} : ${JSON.stringify(res).slice(0, 150)}` };
  }
  const res = await dns.resolve(m.hostname, type);
  return { ping: Date.now() - start, msg: `${type} : ${JSON.stringify(res).slice(0, 150)}` };
}

function runCheck(m) {
  switch (m.type) {
    case 'tcp': return checkTcp(m);
    case 'ping': return checkPing(m);
    case 'dns': return checkDns(m);
    default: return checkHttp(m); // http, keyword, json
  }
}

function inMaintenance(m) {
  const now = Date.now();
  return db.data.incidents.some((i) => i.severity === 'maintenance' && i.status !== 'resolved'
    && (!i.monitorIds || !i.monitorIds.length || i.monitorIds.includes(m.id))
    && (!i.startsAt || new Date(i.startsAt).getTime() <= now)
    && (!i.endsAt || new Date(i.endsAt).getTime() >= now));
}

async function tick(id) {
  const m = db.data.monitors.find((x) => x.id === id);
  if (!m || !m.active) return;
  const st = state.get(id) || { status: null, retries: 0 };
  let beat;

  if (inMaintenance(m)) {
    beat = { t: Date.now(), s: 3, p: null, m: 'Maintenance en cours' };
  } else {
    try {
      const r = await runCheck(m);
      beat = { t: Date.now(), s: 1, p: r.ping, m: r.msg };
      if (r.cert) st.cert = r.cert;
      st.retries = 0;
    } catch (e) {
      st.retries++;
      const pending = st.retries <= (m.retries || 0) && st.status !== 0;
      beat = { t: Date.now(), s: pending ? 2 : 0, p: null, m: e.message || String(e) };
    }
  }

  // Vérifie que le monitor n'a pas été supprimé/édité pendant le check
  const cur = db.data.monitors.find((x) => x.id === id);
  if (!cur || cur !== m || !m.active) return;

  const prev = st.status;
  beat.important = (beat.s === 0 || beat.s === 1) && prev !== null && prev !== beat.s && !(prev === 3 && beat.s === 1) ? 1 : 0;
  if (prev === null) beat.important = 1;
  if (beat.s !== 2) st.status = beat.s;
  st.lastBeat = beat;
  state.set(id, st);
  db.addBeat(id, beat);
  emit({ monitorId: id, beat });

  if (beat.important && prev !== null && (beat.s === 0 || beat.s === 1)) {
    sendNotifications(m, beat);
  }
  // Alerte d'expiration de certificat (une fois par jour)
  if (st.cert && m.certExpiryAlert && st.cert.daysLeft <= (m.certExpiryDays || 14)) {
    const today = db.dayKey(Date.now());
    if (st.certAlerted !== today) {
      st.certAlerted = today;
      sendNotifications(m, { s: 0, m: `Le certificat TLS expire dans ${st.cert.daysLeft} jour(s) (${st.cert.validTo.slice(0, 10)})`, p: null });
    }
  }

  // En cas de panne, on peut accélérer les vérifications
  const interval = (beat.s === 0 || beat.s === 2) && m.retryInterval ? m.retryInterval : m.interval || 60;
  timers.set(id, setTimeout(() => tick(id), Math.max(5, interval) * 1000));
}

function sendNotifications(m, beat) {
  const list = db.data.notifications.filter((n) => n.active !== false && ((m.notificationIds || []).includes(n.id) || n.applyAll));
  for (const n of list) {
    notify.send(n, { monitor: m, status: beat.s, msg: beat.m, ping: beat.p })
      .catch((e) => console.error(`[notif] ${n.name} : ${e.message}`));
  }
}

function start(m) {
  stop(m.id);
  if (!m.active) return;
  const st = state.get(m.id) || { status: null, retries: 0 };
  // On reprend l'état précédent pour éviter des notifications au redémarrage
  if (st.status === null) {
    const last = (db.data.beats[m.id] || []).filter((b) => b.s !== 2).pop();
    if (last) st.status = last.s;
  }
  st.retries = 0;
  state.set(m.id, st);
  timers.set(m.id, setTimeout(() => tick(m.id), 500 + Math.random() * 1500));
}

function stop(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
}

function startAll(emitter) {
  emit = emitter;
  db.data.monitors.forEach(start);
}

function getState(id) { return state.get(id) || {}; }
function forget(id) { stop(id); state.delete(id); }

module.exports = { startAll, start, stop, forget, getState, runCheck };
