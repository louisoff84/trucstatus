// Tests : Minecraft (Java + Bedrock), Proxmox, statut dégradé, pages de status
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');

const { checkMinecraft, writeVarInt, readVarInt, packet, mcString, MAGIC } = require('../lib/minecraft');
const { checkProxmox } = require('../lib/proxmox');
const { applyDegraded } = require('../lib/monitor');

const servers = [];
let proc, base, cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-feat-'));

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// Faux serveur Minecraft Java : répond au Server List Ping
function fakeJava(status) {
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      // handshake + request : on répond dès qu'on a reçu les 2 paquets
      const l1 = readVarInt(buf, 0);
      if (!l1 || buf.length < l1.off + l1.value) return;
      const rest = buf.slice(l1.off + l1.value);
      const l2 = readVarInt(rest, 0);
      if (!l2 || rest.length < l2.off + l2.value) return;
      sock.write(packet(0x00, mcString(JSON.stringify(status))));
    });
    sock.on('error', () => {});
  });
  servers.push(srv);
  return srv;
}

// Faux serveur Bedrock (RakNet unconnected pong)
function fakeBedrock() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg[0] !== 0x01) return;
    const str = Buffer.from('MCPE;Craftpick Bedrock;712;1.21.20;7;50;123;Lobby;Survival;1;19132;19133;');
    const out = Buffer.alloc(35 + str.length);
    out[0] = 0x1c; msg.copy(out, 1, 1, 9); out.writeBigInt64BE(42n, 9); MAGIC.copy(out, 17); out.writeUInt16BE(str.length, 33); str.copy(out, 35);
    sock.send(out, rinfo.port, rinfo.address);
  });
  servers.push({ close: () => sock.close() });
  return new Promise((r) => sock.bind(0, '127.0.0.1', () => r(sock.address().port)));
}

// Faux Proxmox
function fakeProxmox() {
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'PVEAPIToken=root@pam!status=secret-ok') { res.writeHead(401); return res.end('{}'); }
    const send = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data })); };
    if (req.url === '/api2/json/nodes/pve/status') return send({ cpu: 0.42, memory: { used: 6e9, total: 8e9 }, rootfs: { used: 20e9, total: 100e9 }, uptime: 90061, pveversion: 'pve-manager/8.2' });
    if (req.url === '/api2/json/nodes/pve/qemu') return send([{ vmid: 100, name: 'mc-survie', status: 'running' }, { vmid: 101, name: 'mc-test', status: 'stopped' }]);
    if (req.url === '/api2/json/nodes/pve/lxc') return send([{ vmid: 200, name: 'proxy', status: 'running' }]);
    res.writeHead(404); res.end('{}');
  });
  servers.push(srv);
  return srv;
}

async function call(method, url, body, jar = true) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(jar && cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, setCookie: set };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const r = await call('POST', '/api/setup', { password: 'motdepasse-test' });
  cookie = r.setCookie.split(';')[0];
});
after(() => { proc.kill(); servers.forEach((s) => s.close()); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('VarInt : aller-retour', () => {
  for (const n of [0, 1, 127, 128, 255, 25565, 2097151, 767]) assert.strictEqual(readVarInt(writeVarInt(n), 0).value, n);
});

test('Minecraft Java : joueurs, version, MOTD', async () => {
  const port = await listen(fakeJava({ version: { name: 'Paper 1.21.1', protocol: 767 }, players: { online: 12, max: 100, sample: [{ name: 'Louis' }] }, description: { text: '§aCraftpick', extra: [{ text: ' — Survie' }] } }));
  const r = await checkMinecraft({ hostname: '127.0.0.1', port, timeout: 5 });
  assert.strictEqual(r.players, 12);
  assert.strictEqual(r.extra.max, 100);
  assert.strictEqual(r.extra.version, 'Paper 1.21.1');
  assert.strictEqual(r.extra.motd, 'Craftpick — Survie');
  assert.deepStrictEqual(r.extra.sample, ['Louis']);
});

test('Minecraft Java : serveur absent', async () => {
  const port = await freePort();
  await assert.rejects(checkMinecraft({ hostname: '127.0.0.1', port, timeout: 3 }), /refusée|fermée/);
});

test('Minecraft Bedrock : ping RakNet', async () => {
  const port = await fakeBedrock();
  const r = await checkMinecraft({ hostname: '127.0.0.1', port, mcEdition: 'bedrock', timeout: 5 });
  assert.strictEqual(r.players, 7);
  assert.strictEqual(r.extra.max, 50);
  assert.match(r.extra.version, /1\.21\.20/);
});

test('Proxmox : métriques, VM surveillées, seuils', async () => {
  const port = await listen(fakeProxmox());
  const m = { url: `http://127.0.0.1:${port}`, pveNode: 'pve', pveTokenId: 'root@pam!status', pveTokenSecret: 'secret-ok', timeout: 5 };
  const ok = await checkProxmox({ ...m, pveVmids: '100, 200' });
  assert.strictEqual(ok.extra.cpu, 42);
  assert.strictEqual(ok.extra.mem, 75);
  assert.strictEqual(ok.extra.disk, 20);
  assert.strictEqual(ok.extra.running, 2);
  assert.strictEqual(ok.extra.total, 3);
  assert.strictEqual(ok.degraded, null);
  const deg = await checkProxmox({ ...m, pveMem: 70 });
  assert.match(deg.degraded, /RAM 75 % > 70 %/);
  await assert.rejects(checkProxmox({ ...m, pveVmids: '101' }), /Arrêté : VM 101 « mc-test »/);
  await assert.rejects(checkProxmox({ ...m, pveTokenSecret: 'faux' }), /401/);
});

test('statut dégradé : seuil de latence', () => {
  const b = { s: 1, p: 2500, m: 'OK' };
  applyDegraded({ degradedMs: 1000 }, b);
  assert.strictEqual(b.s, 4);
  const b2 = { s: 1, p: 200, m: 'OK' };
  applyDegraded({ degradedMs: 1000 }, b2);
  assert.strictEqual(b2.s, 1);
});

test('statut dégradé via push, compté comme disponible, retour normal', async () => {
  const m = (await call('POST', '/api/monitors', { name: 'Lent', type: 'push', interval: 60, degradedMs: 1000 })).body;
  await call('GET', m.pushPath + '?ping=3000');
  let mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 4);
  assert.strictEqual(mm.uptime24, 100);
  await call('GET', m.pushPath + '?ping=100');
  mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 1);
  assert.match(mm.lastMsg, /normale/);
  const badge = await call('GET', '/api/badge/' + m.id);
  assert.match(badge.body, /up/);
});

test('monitor Proxmox : validation et secret jamais renvoyé', async () => {
  assert.strictEqual((await call('POST', '/api/monitors', { name: 'P', type: 'proxmox', url: 'https://1.2.3.4:8006', pveNode: 'pve', pveTokenId: 'mauvais', pveTokenSecret: 'x' })).status, 400);
  const r = await call('POST', '/api/monitors', { name: 'P', type: 'proxmox', url: 'https://127.0.0.1:1', pveNode: 'pve', pveTokenId: 'root@pam!status', pveTokenSecret: 'tres-secret', active: false });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.config.pveTokenSecret, '');
  assert.strictEqual(r.body.config.secretsSet.pveTokenSecret, true);
  // modification sans ressaisir le secret : il est conservé
  const r2 = await call('PUT', '/api/monitors/' + r.body.id, { ...r.body.config, name: 'P2', pveTokenSecret: '' });
  assert.strictEqual(r2.body.config.secretsSet.pveTokenSecret, true);
  const exp = await call('GET', '/api/export');
  assert.strictEqual(exp.body.monitors.find((x) => x.id === r.body.id).pveTokenSecret, 'tres-secret');
});

test('pages de status : sélection, protection par mot de passe', async () => {
  const pub = (await call('POST', '/api/monitors', { name: 'Site', type: 'push', interval: 60 })).body;
  const priv = (await call('POST', '/api/monitors', { name: 'Infra', type: 'push', interval: 60, isPublic: false })).body;
  assert.strictEqual((await call('POST', '/api/pages', { slug: 'Mauvais Slug!', title: 'x' })).status, 400);
  const page = (await call('POST', '/api/pages', { slug: 'infra', title: 'Infra', monitorIds: [priv.id], password: 'secret1' })).body;
  assert.strictEqual(page.protected, true);
  assert.strictEqual((await call('POST', '/api/pages', { slug: 'infra', title: 'Doublon' })).status, 400);

  // page principale : pas le monitor privé
  const main = (await call('GET', '/api/status', undefined, false)).body;
  assert.ok(main.monitors.some((m) => m.id === pub.id));
  assert.ok(!main.monitors.some((m) => m.id === priv.id));

  // page protégée : verrouillée sans cookie
  const locked = await call('GET', '/api/status?page=infra', undefined, false);
  assert.strictEqual(locked.status, 401);
  assert.strictEqual(locked.body.locked, true);
  assert.strictEqual((await call('POST', '/api/pages/infra/unlock', { password: 'faux' }, false)).status, 401);
  const ok = await call('POST', '/api/pages/infra/unlock', { password: 'secret1' }, false);
  assert.strictEqual(ok.status, 200);
  const pageCookie = ok.setCookie.split(';')[0];
  const res = await fetch(base + '/api/status?page=infra', { headers: { Cookie: pageCookie } });
  const data = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(data.title, 'Infra');
  assert.deepStrictEqual(data.monitors.map((m) => m.id), [priv.id]);

  // changer le mot de passe invalide l'ancien cookie
  await call('PUT', '/api/pages/' + page.id, { slug: 'infra', title: 'Infra', monitorIds: [priv.id], password: 'nouveau1' });
  assert.strictEqual((await fetch(base + '/api/status?page=infra', { headers: { Cookie: pageCookie } })).status, 401);

  // la route HTML /s/<slug> sert la page de status
  assert.strictEqual((await fetch(base + '/s/infra')).status, 200);
  assert.strictEqual((await call('GET', '/api/status?page=inconnue', undefined, false)).status, 404);
});
