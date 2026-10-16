// Monitor Pterodactyl : état et ressources d'un serveur via l'API client du panel (clé ptlc_…)
const http = require('http');
const https = require('https');

function getJSON(m, path) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, m.url.replace(/\/+$/, '') + '/'); } catch { return reject(new Error('URL du panel invalide')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { Authorization: `Bearer ${m.pteroApiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: (m.timeout || 30) * 1000,
      rejectUnauthorized: !m.ignoreTls,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 2e6) body += c; });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error(`Clé API Pterodactyl refusée (${res.statusCode})`));
        if (res.statusCode === 404) return reject(new Error('Serveur introuvable sur le panel (vérifie l’identifiant)'));
        if (res.statusCode === 409) return reject(new Error('Serveur suspendu ou en cours d’installation'));
        if (res.statusCode >= 400) return reject(new Error(`Panel : HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error('Réponse du panel illisible')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Connexion refusée' : e.message)));
    req.end();
  });
}

const STATE_FR = { running: 'en marche', offline: 'arrêté', starting: 'en démarrage', stopping: 'en arrêt' };
const mb = (bytes) => Math.round((bytes || 0) / 1048576);

async function checkPterodactyl(m) {
  const id = encodeURIComponent(m.pteroServerId);
  const start = Date.now();
  const [resData, info] = await Promise.all([
    getJSON(m, `api/client/servers/${id}/resources`),
    getJSON(m, `api/client/servers/${id}`).catch(() => null),
  ]);
  const ping = Date.now() - start;
  const a = (resData && resData.attributes) || {};
  const r = a.resources || {};
  const limits = (info && info.attributes && info.attributes.limits) || {};
  const state = a.current_state || 'offline';
  const extra = {
    kind: 'pterodactyl', state, name: info && info.attributes ? info.attributes.name : '',
    cpu: Math.round((r.cpu_absolute || 0) * 10) / 10, cpuLimit: limits.cpu || 0,
    memMb: mb(r.memory_bytes), memLimitMb: limits.memory || 0,
    diskMb: mb(r.disk_bytes), diskLimitMb: limits.disk || 0,
    uptime: Math.round((r.uptime || 0) / 1000),
  };
  if (a.is_suspended) { const e = new Error('Serveur suspendu sur le panel'); e.extra = extra; throw e; }
  if (state === 'offline' || state === 'stopping') { const e = new Error(`Serveur ${STATE_FR[state]} sur le panel`); e.extra = extra; throw e; }
  const memTxt = extra.memLimitMb ? `${extra.memMb}/${extra.memLimitMb} Mo` : `${extra.memMb} Mo`;
  const over = [];
  const memPct = extra.memLimitMb ? (extra.memMb / extra.memLimitMb) * 100 : 0;
  if (m.pteroMem && memPct > m.pteroMem) over.push(`RAM ${Math.round(memPct)} % > ${m.pteroMem} %`);
  if (m.pteroCpu && extra.cpuLimit && (extra.cpu / extra.cpuLimit) * 100 > m.pteroCpu) over.push(`CPU ${extra.cpu} % (limite ${extra.cpuLimit} %)`);
  return {
    ping, extra,
    msg: `${STATE_FR[state] || state} · CPU ${extra.cpu} % · RAM ${memTxt}`,
    degraded: state === 'starting' ? 'Serveur en cours de démarrage' : over.length ? `Seuil dépassé : ${over.join(', ')}` : null,
  };
}

module.exports = { checkPterodactyl };
