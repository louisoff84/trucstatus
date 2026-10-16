// Vérification d'un nœud Proxmox VE via l'API (jeton en lecture seule)
const http = require('http');
const https = require('https');

function getJSON(m, path) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(path, m.url.replace(/\/+$/, '') + '/'); } catch { return reject(new Error('URL Proxmox invalide')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      headers: { Authorization: `PVEAPIToken=${m.pveTokenId}=${m.pveTokenSecret}`, Accept: 'application/json' },
      timeout: (m.timeout || 30) * 1000,
      rejectUnauthorized: !m.ignoreTls,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 5e6) body += c; });
      res.on('end', () => {
        if (res.statusCode === 401) return reject(new Error('Jeton API refusé (401)'));
        if (res.statusCode === 403) return reject(new Error('Permissions insuffisantes pour le jeton (403)'));
        if (res.statusCode >= 400) return reject(new Error(`API Proxmox : HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body).data); } catch { reject(new Error('Réponse Proxmox illisible')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Connexion refusée' : e.message)));
    req.end();
  });
}

const pct = (used, total) => (total ? Math.round((used / total) * 1000) / 10 : 0);

async function checkProxmox(m) {
  const start = Date.now();
  const node = encodeURIComponent(m.pveNode);
  const status = await getJSON(m, `api2/json/nodes/${node}/status`);
  const ping = Date.now() - start;
  if (!status) throw new Error(`Nœud « ${m.pveNode} » introuvable`);
  const [qemu, lxc] = await Promise.all([
    getJSON(m, `api2/json/nodes/${node}/qemu`).catch(() => []),
    getJSON(m, `api2/json/nodes/${node}/lxc`).catch(() => []),
  ]);
  const guests = [...(qemu || []).map((g) => ({ ...g, kind: 'VM' })), ...(lxc || []).map((g) => ({ ...g, kind: 'CT' }))];
  const cpu = Math.round((Number(status.cpu) || 0) * 1000) / 10;
  const mem = pct(status.memory && status.memory.used, status.memory && status.memory.total);
  const disk = pct(status.rootfs && status.rootfs.used, status.rootfs && status.rootfs.total);
  const running = guests.filter((g) => g.status === 'running').length;
  const extra = {
    kind: 'proxmox', cpu, mem, disk, uptime: Number(status.uptime) || 0,
    running, total: guests.length, pveVersion: status.pveversion || '',
    guests: guests.sort((a, b) => a.vmid - b.vmid).slice(0, 50).map((g) => ({ vmid: g.vmid, name: g.name, kind: g.kind, status: g.status })),
  };

  // VM/CT surveillées : panne si l'une d'elles n'est pas démarrée
  const watched = String(m.pveVmids || '').split(/[\s,;]+/).map(Number).filter(Boolean);
  const stopped = watched.map((id) => {
    const g = guests.find((x) => Number(x.vmid) === id);
    if (!g) return `${id} (introuvable)`;
    return g.status === 'running' ? null : `${g.kind} ${id}${g.name ? ' « ' + g.name + ' »' : ''} (${g.status})`;
  }).filter(Boolean);
  if (stopped.length) { const e = new Error(`Arrêté : ${stopped.join(', ')}`); e.extra = extra; throw e; }

  const over = [];
  if (m.pveCpu && cpu > m.pveCpu) over.push(`CPU ${cpu} % > ${m.pveCpu} %`);
  if (m.pveMem && mem > m.pveMem) over.push(`RAM ${mem} % > ${m.pveMem} %`);
  if (m.pveDisk && disk > m.pveDisk) over.push(`Disque ${disk} % > ${m.pveDisk} %`);
  return {
    ping, extra,
    msg: `CPU ${cpu} % · RAM ${mem} % · Disque ${disk} % · ${running}/${guests.length} VM/CT actives`,
    degraded: over.length ? `Seuil dépassé : ${over.join(', ')}` : null,
  };
}

module.exports = { checkProxmox };
