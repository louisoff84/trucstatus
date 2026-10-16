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
const { inRecurringWindow, maintenanceActive, describeRecurrence } = require('../lib/schedule');
const { checkDatabase } = require('../lib/database');
const { sendMail } = require('../lib/smtp');
const { checkPterodactyl } = require('../lib/pterodactyl');
const crypto = require('node:crypto');

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
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOW_ANY_WEBHOOK: '1' }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/health'); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  const r = await call('POST', '/api/setup', { password: 'motdepasse-test' });
  cookie = r.setCookie.split(';')[0];
});
after(async () => {
  servers.forEach((s) => s.close()); const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await exited; // le serveur sauvegarde sa base en s'arrêtant
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

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

// ───────── v1.3 ─────────
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('maintenance récurrente : créneaux, passage de minuit, description', () => {
  const at = (day, h, m) => { const d = new Date(2026, 9, 11 + day, h, m); return d; }; // 11/10/2026 = dimanche
  const nightly = { days: [0, 1, 2, 3, 4, 5, 6], start: '04:00', end: '04:15' };
  assert.ok(inRecurringWindow(nightly, at(1, 4, 5)));
  assert.ok(!inRecurringWindow(nightly, at(1, 4, 15)));
  const lateMon = { days: [1], start: '23:30', end: '00:30' };
  assert.ok(inRecurringWindow(lateMon, at(1, 23, 45)));   // lundi soir
  assert.ok(inRecurringWindow(lateMon, at(2, 0, 10)));    // mardi 00:10, suite du lundi
  assert.ok(!inRecurringWindow(lateMon, at(3, 0, 10)));   // mercredi : non
  assert.strictEqual(describeRecurrence(nightly), 'tous les jours, 04:00 – 04:15');
  assert.ok(!maintenanceActive({ severity: 'maintenance', status: 'scheduled', recurrence: nightly, endsAt: '2020-01-01' }, at(1, 4, 5).getTime()));
});

test('maintenance récurrente : le monitor passe en maintenance', async () => {
  const now = new Date();
  const start = new Date(now.getTime() - 60000), end = new Date(now.getTime() + 10 * 60000);
  const m = (await call('POST', '/api/monitors', { name: 'Redémarrage', type: 'push', interval: 60 })).body;
  assert.strictEqual((await call('POST', '/api/incidents', { title: 'x', severity: 'maintenance', status: 'scheduled', recurrence: { days: [], start: '04:00', end: '05:00' } })).status, 400);
  const inc = (await call('POST', '/api/incidents', { title: 'Redémarrage quotidien', severity: 'maintenance', status: 'scheduled', monitorIds: [m.id], recurrence: { days: [0, 1, 2, 3, 4, 5, 6], start: hhmm(start), end: hhmm(end) } })).body;
  await call('GET', m.pushPath);
  const mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 3);
  const pub = (await call('GET', '/api/status', undefined, false)).body.incidents.find((i) => i.id === inc.id);
  assert.strictEqual(pub.activeNow, true);
  assert.match(pub.recurrenceText, /tous les jours/);
  await call('DELETE', '/api/incidents/' + inc.id);
});

test('dépendances : alerte masquée si le parent est en panne, pas de boucle', async () => {
  const parent = (await call('POST', '/api/monitors', { name: 'Nœud', type: 'push', interval: 60 })).body;
  const child = (await call('POST', '/api/monitors', { name: 'VM', type: 'push', interval: 60, parentId: parent.id })).body;
  assert.strictEqual(child.config.parentId, parent.id);
  // boucle interdite
  const r = await call('PUT', '/api/monitors/' + parent.id, { ...parent.config, parentId: child.id });
  assert.strictEqual(r.status, 400);
  await call('GET', parent.pushPath); await call('GET', child.pushPath);
  await call('GET', parent.pushPath + '?status=down');
  await call('GET', child.pushPath + '?status=down');
  await sleep(150);
  const beats = (await call('GET', `/api/monitors/${child.id}/beats?hours=1`)).body;
  assert.match(beats[beats.length - 1].m, /alerte masquée.*Nœud/);
});

test('message Discord en direct : création puis modification du même message', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: JSON.parse(b || '{}') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.method === 'POST' ? { id: '987654321' } : {}));
    });
  });
  servers.push(srv);
  const port = await listen(srv);
  const url = `http://127.0.0.1:${port}/api/webhooks/1/abc`;
  assert.strictEqual((await call('PUT', '/api/settings', { title: 'Craftpick Status', discordLive: { enabled: false, webhookUrl: url, page: '' } })).status, 200);
  const r1 = (await call('POST', '/api/discord-live/publish', {})).body;
  assert.strictEqual(r1.ok, true); assert.strictEqual(r1.created, true);
  const r2 = (await call('POST', '/api/discord-live/publish', {})).body;
  assert.strictEqual(r2.ok, true); assert.ok(!r2.created);
  assert.strictEqual(hits[0].method, 'POST'); assert.match(hits[0].url, /wait=true/);
  assert.strictEqual(hits[1].method, 'PATCH'); assert.match(hits[1].url, /\/messages\/987654321$/);
  assert.ok(hits[1].body.embeds[0].fields.length > 0);
});

test('rapport hebdomadaire : aperçu et envoi', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(JSON.parse(b)); res.end('{}'); }); });
  servers.push(srv);
  const port = await listen(srv);
  const n = (await call('POST', '/api/notifications', { name: 'Hook', type: 'webhook', config: { url: `http://127.0.0.1:${port}/` } })).body;
  const prev = (await call('GET', '/api/report/preview')).body;
  assert.match(prev.text, /Disponibilité moyenne/);
  assert.match(prev.text, /Nœud — /);
  assert.ok(prev.monitors.find((x) => x.name === 'Nœud').outages >= 1);
  assert.strictEqual((await call('POST', '/api/report/send', {})).status, 400);
  await call('PUT', '/api/settings', { title: 'Craftpick Status', weeklyReport: { enabled: true, day: 1, hour: 9, notificationIds: [n.id] } });
  const r = (await call('POST', '/api/report/send', {})).body;
  assert.strictEqual(r.sent, 1);
  assert.strictEqual(got[0].type, 'report');
  assert.match(got[0].title, /Rapport hebdomadaire/);
});

test('widget : /embed intégrable en iframe, le reste non', async () => {
  const e = await fetch(base + '/embed?theme=dark');
  assert.strictEqual(e.status, 200);
  assert.strictEqual(e.headers.get('x-frame-options'), null);
  const h = await fetch(base + '/');
  assert.strictEqual(h.headers.get('x-frame-options'), 'SAMEORIGIN');
});

// ───────── v1.4 ─────────
function tcpFake(onConn) { const srv = net.createServer(onConn); servers.push(srv); return listen(srv); }

test('MySQL / MariaDB : version lue dans le handshake, refus d’hôte = joignable', async () => {
  const port = await tcpFake((sock) => {
    const payload = Buffer.concat([Buffer.from([10]), Buffer.from('10.11.6-MariaDB\0'), Buffer.alloc(20)]);
    const head = Buffer.alloc(4); head.writeUIntLE(payload.length, 0, 3); head[3] = 0;
    sock.write(Buffer.concat([head, payload])); sock.on('error', () => {});
  });
  const r = await checkDatabase({ dbKind: 'mysql', hostname: '127.0.0.1', port, timeout: 5 });
  assert.match(r.msg, /MariaDB 10\.11\.6/);
  const port2 = await tcpFake((sock) => {
    const msg = Buffer.from("Host '1.2.3.4' is not allowed to connect");
    const payload = Buffer.concat([Buffer.from([0xff, 0x6a, 0x04]), msg]);
    const head = Buffer.alloc(4); head.writeUIntLE(payload.length, 0, 3);
    sock.write(Buffer.concat([head, payload])); sock.on('error', () => {});
  });
  const r2 = await checkDatabase({ dbKind: 'mysql', hostname: '127.0.0.1', port: port2, timeout: 5 });
  assert.match(r2.msg, /joignable.*not allowed/);
});

test('PostgreSQL : réponse à la SSLRequest', async () => {
  const port = await tcpFake((sock) => { sock.on('data', () => sock.write('N')); sock.on('error', () => {}); });
  const r = await checkDatabase({ dbKind: 'postgres', hostname: '127.0.0.1', port, timeout: 5 });
  assert.match(r.msg, /PostgreSQL joignable/);
});

test('Redis : AUTH, PING, version ; mauvais mot de passe', async () => {
  const port = await tcpFake((sock) => {
    sock.on('data', (d) => {
      const c = d.toString();
      if (c.startsWith('AUTH')) sock.write(c.includes('bon-mdp') ? '+OK\r\n' : '-WRONGPASS invalid password\r\n');
      else if (c.startsWith('PING')) sock.write('+PONG\r\n');
      else if (c.startsWith('INFO')) { const body = '# Server\r\nredis_version:7.2.4\r\n'; sock.write(`$${body.length}\r\n${body}\r\n`); }
    });
    sock.on('error', () => {});
  });
  const r = await checkDatabase({ dbKind: 'redis', hostname: '127.0.0.1', port, dbPassword: 'bon-mdp', timeout: 5 });
  assert.match(r.msg, /Redis 7\.2\.4/);
  await assert.rejects(checkDatabase({ dbKind: 'redis', hostname: '127.0.0.1', port, dbPassword: 'faux', timeout: 5 }), /WRONGPASS/);
});

// Faux serveur SMTP (sans TLS)
function fakeSmtp(store) {
  return tcpFake((sock) => {
    let data = false, buf = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString();
      if (data) {
        if (buf.endsWith('\r\n.\r\n')) { store.push(buf); buf = ''; data = false; sock.write('250 OK queued\r\n'); }
        return;
      }
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        store.cmds = (store.cmds || []).concat(line);
        if (/^EHLO/i.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) sock.write(Buffer.from(line.slice(11), 'base64').toString().endsWith('\0secret') ? '235 OK\r\n' : '535 bad auth\r\n');
        else if (/^MAIL|^RCPT/i.test(line)) sock.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) sock.end('221 bye\r\n');
      }
    });
    sock.on('error', () => {});
  });
}

test('SMTP : envoi d’un email avec authentification', async () => {
  const store = [];
  const port = await fakeSmtp(store);
  await sendMail({ host: '127.0.0.1', port, user: 'alertes@craftpick.fr', pass: 'secret', from: 'Craftpick <alertes@craftpick.fr>', to: 'louis@craftpick.fr, admin@craftpick.fr', subject: '🔴 Survie hors ligne', text: 'Le serveur ne répond plus' });
  assert.strictEqual(store.length, 1);
  assert.ok(store.cmds.includes('RCPT TO:<admin@craftpick.fr>'));
  assert.match(store[0], /Subject: =\?UTF-8\?B\?/);
  const body = store[0].split('\r\n\r\n')[1].replace(/\r\n|\./g, '');
  assert.match(Buffer.from(body, 'base64').toString(), /ne répond plus/);
  await assert.rejects(sendMail({ host: '127.0.0.1', port, user: 'x', pass: 'faux', from: 'a@b.c', to: 'd@e.f', subject: 's', text: 't' }), /535/);
});

test('notification email via l’API de test', async () => {
  const store = [];
  const port = await fakeSmtp(store);
  const r = (await call('POST', '/api/notifications/test', { name: 'Mail', type: 'email', config: { smtpHost: '127.0.0.1', smtpPort: String(port), smtpUser: 'u', smtpPass: 'secret', mailFrom: 'a@craftpick.fr', mailTo: 'louis@craftpick.fr' } })).body;
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(store.length, 1);
});

test('page détaillée d’un service : public oui, privé non', async () => {
  const pub = (await call('POST', '/api/monitors', { name: 'Détail', type: 'push', interval: 60 })).body;
  const priv = (await call('POST', '/api/monitors', { name: 'Caché', type: 'push', interval: 60, isPublic: false })).body;
  await call('GET', pub.pushPath + '?ping=42');
  const r = await call('GET', `/api/service/${pub.id}?hours=24`, undefined, false);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.monitor.name, 'Détail');
  assert.ok(r.body.series.length >= 1);
  assert.strictEqual(r.body.monitor.config, undefined); // jamais la config en public
  assert.strictEqual((await call('GET', `/api/service/${priv.id}`, undefined, false)).status, 404);
  assert.strictEqual((await fetch(`${base}/service/${pub.id}`)).status, 200);
});

test('personnalisation : accent, bannière, CSS', async () => {
  assert.strictEqual((await call('PUT', '/api/settings', { title: 'Craftpick Status', accentColor: 'rouge' })).status, 400);
  await call('PUT', '/api/settings', { title: 'Craftpick Status', accentColor: '#ff8800', banner: { text: 'Event ce soir 21h', level: 'event', link: 'javascript:alert(1)' }, customCss: 'h1{color:red}</style><script>x</script>' });
  const s = (await call('GET', '/api/status', undefined, false)).body;
  assert.strictEqual(s.accentColor, '#ff8800');
  assert.strictEqual(s.banner.text, 'Event ce soir 21h');
  assert.strictEqual(s.banner.link, ''); // lien non http(s) refusé
  assert.ok(!/<\/style/i.test(s.customCss));
});

test('sauvegardes : création, liste, téléchargement, noms protégés', async () => {
  const r = (await call('POST', '/api/backups', {})).body;
  assert.match(r.name, /^db-\d{4}-\d{2}-\d{2}\.json$/);
  const list = (await call('GET', '/api/backups')).body;
  assert.ok(list.some((b) => b.name === r.name));
  const dl = await call('GET', '/api/backups/' + r.name);
  assert.strictEqual(dl.status, 200);
  assert.ok(Array.isArray(dl.body.monitors));
  assert.strictEqual((await call('GET', '/api/backups/..%2Fdb.json')).status, 404);
  assert.strictEqual((await call('GET', '/api/backups', undefined, false)).status, 401);
});

// ───────── v1.5 ─────────
async function as(cookieStr, method, url, body) {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), Cookie: cookieStr }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j; try { j = await res.json(); } catch { j = null; }
  return { status: res.status, body: j, setCookie: res.headers.get('set-cookie') };
}
async function loginAs(username, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}

test('utilisateurs : rôles lecteur / éditeur / admin', async () => {
  assert.strictEqual((await call('POST', '/api/users', { username: 'modo', password: 'court', role: 'editor' })).status, 400);
  const ed = (await call('POST', '/api/users', { username: 'modo', password: 'motdepasse-modo', role: 'editor' })).body;
  await call('POST', '/api/users', { username: 'lecteur', password: 'motdepasse-lect', role: 'viewer' });
  assert.strictEqual((await call('POST', '/api/users', { username: 'MODO', password: 'motdepasse-x', role: 'viewer' })).status, 400); // doublon
  assert.strictEqual((await loginAs('modo', 'mauvais')).status, 401);
  const e = await loginAs('modo', 'motdepasse-modo');
  const v = await loginAs('lecteur', 'motdepasse-lect');
  assert.strictEqual(e.status, 200);
  // lecteur : lecture seule
  assert.strictEqual((await as(v.cookie, 'GET', '/api/monitors')).status, 200);
  assert.strictEqual((await as(v.cookie, 'POST', '/api/monitors', { name: 'x', type: 'push' })).status, 403);
  // éditeur : monitors oui, paramètres non, notifications sans secrets
  const created = await as(e.cookie, 'POST', '/api/monitors', { name: 'Par le modo', type: 'push', interval: 60 });
  assert.strictEqual(created.status, 200);
  assert.strictEqual((await as(e.cookie, 'GET', '/api/settings')).status, 403);
  assert.strictEqual((await as(e.cookie, 'POST', '/api/users', { username: 'pirate', password: 'motdepasse-p' })).status, 403);
  const notifs = (await as(e.cookie, 'GET', '/api/notifications')).body;
  assert.ok(notifs.every((n) => n.config === undefined));
  assert.strictEqual((await as(e.cookie, 'GET', '/api/me')).body.user.role, 'editor');
  // on ne peut pas retirer le dernier admin
  const users = (await call('GET', '/api/users')).body;
  const admin = users.users.find((u) => u.role === 'admin');
  assert.strictEqual((await call('PUT', '/api/users/' + admin.id, { role: 'viewer' })).status, 400);
  assert.strictEqual((await call('DELETE', '/api/users/' + admin.id)).status, 400);
  // supprimer un utilisateur coupe ses sessions
  await call('DELETE', '/api/users/' + ed.id);
  assert.strictEqual((await as(e.cookie, 'GET', '/api/monitors')).status, 401);
});

test('clés API : Bearer, rôle, révocation', async () => {
  const k = (await call('POST', '/api/apikeys', { name: 'Bot', role: 'editor' })).body;
  assert.match(k.key, /^cs_[0-9a-f]{48}$/);
  const list = (await call('GET', '/api/apikeys')).body;
  assert.ok(list.every((x) => x.hash === undefined && x.key === undefined));
  const h = { Authorization: 'Bearer ' + k.key, 'Content-Type': 'application/json' };
  const r = await fetch(base + '/api/incidents', { method: 'POST', headers: h, body: JSON.stringify({ title: 'Créé par le bot', severity: 'info', status: 'investigating' }) });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await fetch(base + '/api/settings', { headers: h })).status, 403);
  await call('DELETE', '/api/apikeys/' + k.id);
  assert.strictEqual((await fetch(base + '/api/monitors', { headers: h })).status, 401);
});

test('journal d’activité : actions et échecs de connexion', async () => {
  const log = (await call('GET', '/api/audit')).body;
  assert.ok(log.some((a) => a.action === 'Utilisateur créé' && a.target === 'modo'));
  assert.ok(log.some((a) => a.action === 'Monitor créé' && a.user === 'modo' && a.target === 'Par le modo'));
  assert.ok(log.some((a) => a.action === 'Incident publié' && /Bot/.test(a.user)));
  assert.ok(log.some((a) => a.action === 'Échec de connexion' && a.target === 'modo'));
  assert.ok(log.some((a) => a.action === 'Utilisateur supprimé' && a.target === 'modo'));
});

test('silence des alertes : aucune notification pendant le silence', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(JSON.parse(b)); res.end('{}'); }); });
  servers.push(srv);
  const port = await listen(srv);
  const n = (await call('POST', '/api/notifications', { name: 'Hook silence', type: 'webhook', config: { url: `http://127.0.0.1:${port}/` } })).body;
  const m = (await call('POST', '/api/monitors', { name: 'Bruyant', type: 'push', interval: 60, notificationIds: [n.id] })).body;
  await call('GET', m.pushPath);
  const sn = (await call('POST', `/api/monitors/${m.id}/snooze`, { minutes: 60 })).body;
  assert.ok(sn.config.snoozeUntil > Date.now());
  await call('GET', m.pushPath + '?status=down');
  await sleep(200);
  assert.strictEqual(got.filter((g) => g.monitor && g.monitor.name === 'Bruyant').length, 0);
  await call('POST', `/api/monitors/${m.id}/snooze`, { minutes: 0 });
  await call('GET', m.pushPath);
  await sleep(200);
  assert.strictEqual(got.filter((g) => g.monitor && g.monitor.name === 'Bruyant').length, 1); // retour en ligne notifié
});

test('export CSV de l’historique', async () => {
  const m = (await call('GET', '/api/monitors')).body.find((x) => x.name === 'Bruyant');
  const r = await fetch(base + `/api/monitors/${m.id}/export.csv?days=7`, { headers: { Cookie: cookie } });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const txt = await r.text();
  const lines = txt.replace(/^\ufeff/, '').split('\r\n');
  assert.strictEqual(lines[0], 'date;statut;ping_ms;joueurs;message');
  assert.ok(lines.some((l) => l.includes(';Hors ligne;')));
});

// ───────── v1.6 : intégrations ─────────
test('Pterodactyl : en marche, démarrage, arrêté, clé refusée', async () => {
  let state = 'running';
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ptlc_ok') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/api/client/servers/abcd1234/resources') return res.end(JSON.stringify({ attributes: { current_state: state, is_suspended: false, resources: { memory_bytes: 3 * 1048576 * 1024, cpu_absolute: 87.5, disk_bytes: 5e9, uptime: 3600000 } } }));
    if (req.url === '/api/client/servers/abcd1234') return res.end(JSON.stringify({ attributes: { name: 'Survie', limits: { memory: 4096, cpu: 200, disk: 20000 } } }));
    res.writeHead(404); res.end('{}');
  });
  servers.push(srv);
  const port = await listen(srv);
  const m = { url: `http://127.0.0.1:${port}`, pteroServerId: 'abcd1234', pteroApiKey: 'ptlc_ok', timeout: 5 };
  const ok = await checkPterodactyl(m);
  assert.strictEqual(ok.extra.memMb, 3072); assert.strictEqual(ok.extra.memLimitMb, 4096); assert.strictEqual(ok.extra.name, 'Survie');
  assert.strictEqual(ok.degraded, null);
  assert.match((await checkPterodactyl({ ...m, pteroMem: 70 })).degraded, /RAM 75 % > 70 %/);
  state = 'starting'; assert.match((await checkPterodactyl(m)).degraded, /démarrage/);
  state = 'offline'; await assert.rejects(checkPterodactyl(m), /arrêté/);
  await assert.rejects(checkPterodactyl({ ...m, pteroApiKey: 'faux' }), /refusée/);
});

test('Discord /status : signature Ed25519, ping, commande, autocomplétion', async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubHex = publicKey.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex');
  assert.strictEqual((await call('PUT', '/api/settings', { title: 'Craftpick Status', discordBot: { applicationId: '123', publicKey: pubHex, page: '' } })).status, 200);
  const send = async (obj, sign = true) => {
    const body = JSON.stringify(obj), ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.sign(null, Buffer.from(ts + body), privateKey).toString('hex');
    const r = await fetch(base + '/api/discord/interactions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sign ? sig : '0'.repeat(128), 'X-Signature-Timestamp': ts }, body });
    return { status: r.status, body: await r.json() };
  };
  assert.strictEqual((await send({ type: 1 }, false)).status, 401);
  assert.deepStrictEqual((await send({ type: 1 })).body, { type: 1 });
  const all = (await send({ type: 2, data: { name: 'status' } })).body;
  assert.strictEqual(all.type, 4);
  assert.ok(all.data.embeds[0].fields.length > 0);
  const one = (await send({ type: 2, data: { name: 'status', options: [{ name: 'service', value: 'détail' }] } })).body;
  assert.strictEqual(one.data.embeds[0].title, 'Détail');
  const ac = (await send({ type: 4, data: { name: 'status', options: [{ name: 'service', value: 'dét', focused: true }] } })).body;
  assert.strictEqual(ac.type, 8);
  assert.ok(ac.data.choices.some((c) => c.name === 'Détail'));
});

test('Prometheus : métriques avec session ou clé API, refusé sinon', async () => {
  const r = await fetch(base + '/api/metrics', { headers: { Cookie: cookie } });
  const txt = await r.text();
  assert.match(r.headers.get('content-type'), /text\/plain/);
  assert.match(txt, /# TYPE craftpick_monitor_up gauge/);
  assert.match(txt, /craftpick_monitor_up\{id="\d+",name="Détail",type="push",group=""\} 1/);
  assert.match(txt, /craftpick_incidents_open \d+/);
  assert.strictEqual((await fetch(base + '/api/metrics')).status, 401);
  const k = (await call('POST', '/api/apikeys', { name: 'Prometheus', role: 'viewer' })).body;
  assert.strictEqual((await fetch(base + '/api/metrics', { headers: { Authorization: 'Bearer ' + k.key } })).status, 200);
});

test('Shields.io : statut, disponibilité, monitor privé refusé', async () => {
  const pub = (await call('GET', '/api/monitors')).body.find((x) => x.name === 'Détail');
  const st = (await call('GET', `/api/shields/${pub.id}`, undefined, false)).body;
  assert.strictEqual(st.schemaVersion, 1); assert.strictEqual(st.message, 'en ligne'); assert.strictEqual(st.color, 'brightgreen');
  const up = (await call('GET', `/api/shields/${pub.id}?metric=uptime&window=30d`, undefined, false)).body;
  assert.strictEqual(up.label, 'uptime 30d');
  const priv = (await call('GET', '/api/monitors')).body.find((x) => x.name === 'Caché');
  assert.strictEqual((await call('GET', `/api/shields/${priv.id}`, undefined, false)).status, 404);
});

test('import Uptime Kuma : monitors, groupes, notifications, éléments ignorés', async () => {
  const backup = {
    version: '1.23.13',
    notificationList: [
      { id: 1, name: 'Discord Kuma', active: 1, isDefault: 0, config: JSON.stringify({ type: 'discord', discordWebhookUrl: 'https://discord.com/api/webhooks/1/x' }) },
      { id: 2, name: 'Matrix', active: 1, config: JSON.stringify({ type: 'matrix' }) },
    ],
    monitorList: [
      { id: 10, name: 'Jeux', type: 'group' },
      { id: 11, name: 'Kuma Site', type: 'http', url: 'https://craftpick.fr', method: 'GET', interval: 60, maxretries: 2, accepted_statuscodes: ['200-299'], parent: 10, notificationIDList: { 1: true }, active: 1 },
      { id: 12, name: 'Kuma Mot-clé', type: 'keyword', url: 'https://craftpick.fr', keyword: 'Craftpick', interval: 120, active: 1 },
      { id: 13, name: 'Kuma Port', type: 'port', hostname: '10.0.0.5', port: 25577, interval: 30, active: 1 },
      { id: 14, name: 'Kuma MC', type: 'gamedig', game: 'minecraft', hostname: 'play.craftpick.fr', port: 25565, interval: 60, parent: 10, active: 1 },
      { id: 15, name: 'Kuma MySQL', type: 'mysql', databaseConnectionString: 'mysql://user:pass@10.0.0.9:3306/lp', interval: 60, active: 1 },
      { id: 16, name: 'Kuma Docker', type: 'docker', interval: 60, active: 1 },
      { id: 17, name: 'Kuma Inversé', type: 'http', url: 'https://x.fr', upsideDown: 1, interval: 60, active: 1 },
    ],
  };
  const r = (await call('POST', '/api/import/kuma', backup)).body;
  assert.strictEqual(r.monitors, 5);
  assert.strictEqual(r.notifications, 1);
  assert.strictEqual(r.skipped.length, 3); // matrix, docker, inversé
  const ms = (await call('GET', '/api/monitors')).body;
  const site = ms.find((m) => m.name === 'Kuma Site');
  assert.strictEqual(site.group, 'Jeux');
  assert.strictEqual(site.config.retries, 2);
  assert.strictEqual(site.config.notificationIds.length, 1);
  assert.strictEqual(ms.find((m) => m.name === 'Kuma MC').type, 'minecraft');
  const sql = ms.find((m) => m.name === 'Kuma MySQL');
  assert.strictEqual(sql.config.dbKind, 'mysql'); assert.strictEqual(sql.config.hostname, '10.0.0.9'); assert.strictEqual(sql.config.port, 3306);
  assert.strictEqual(ms.find((m) => m.name === 'Kuma Port').config.port, 25577);
  assert.strictEqual((await call('POST', '/api/import/kuma', { foo: 1 })).status, 400);
});
