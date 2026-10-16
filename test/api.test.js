// Tests d'intégration : lance le serveur sur un port libre avec un dossier de données temporaire
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const { statusMatches, fmtDuration } = require('../lib/monitor');

let proc, base, cookie = '';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-'));

function freePort() {
  return new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir }, stdio: 'pipe' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/health'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('Le serveur ne démarre pas');
});
after(async () => {
  const exited = new Promise((r) => proc.once('exit', r));
  proc.kill();
  await exited; // le serveur sauvegarde sa base en s'arrêtant
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

test('utilitaires', () => {
  assert.ok(statusMatches(204, '200-299'));
  assert.ok(statusMatches(301, '200-299,301'));
  assert.ok(!statusMatches(500, '200-299'));
  assert.strictEqual(fmtDuration(90 * 1000), '1 min 30 s');
});

test('santé et page publique', async () => {
  assert.strictEqual((await call('GET', '/api/health')).body.ok, true);
  const s = await call('GET', '/api/status');
  assert.strictEqual(s.body.setup, true);
  assert.strictEqual((await call('GET', '/')).status, 200);
  assert.strictEqual((await call('GET', '/../server.js')).status, 404);
});

test('admin protégé avant connexion', async () => {
  assert.strictEqual((await call('GET', '/api/monitors')).status, 401);
});

test('configuration, connexion, mauvais mot de passe', async () => {
  assert.strictEqual((await call('POST', '/api/setup', { password: 'court' })).status, 400);
  assert.strictEqual((await call('POST', '/api/setup', { password: 'motdepasse-test' })).status, 200);
  assert.strictEqual((await call('POST', '/api/setup', { password: 'autrechose123' })).status, 400);
  const saved = cookie; cookie = '';
  assert.strictEqual((await call('POST', '/api/login', { password: 'faux-mdp' })).status, 401);
  assert.strictEqual((await call('POST', '/api/login', { password: 'motdepasse-test' })).status, 200);
  assert.notStrictEqual(cookie, saved);
  assert.strictEqual((await call('GET', '/api/me')).body.authed, true);
});

test('protection CSRF : mutation sans JSON refusée', async () => {
  const r = await fetch(base + '/api/monitors', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.strictEqual(r.status, 415);
});

test('validation des monitors', async () => {
  assert.strictEqual((await call('POST', '/api/monitors', { name: 'x', type: 'http', url: 'ftp://nope' })).status, 400);
  assert.strictEqual((await call('POST', '/api/monitors', { name: 'x', type: 'tcp', hostname: 'a' })).status, 400);
});

test('monitor push : réception, panne signalée, retour', async () => {
  const m = (await call('POST', '/api/monitors', { name: 'Cron', type: 'push', interval: 60 })).body;
  assert.ok(m.pushPath.startsWith('/api/push/'));
  assert.strictEqual((await call('GET', '/api/push/inconnu')).status, 404);
  assert.strictEqual((await call('GET', m.pushPath + '?msg=hello&ping=12')).body.ok, true);
  let mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 1);
  assert.strictEqual(mm.ping, 12);
  await call('GET', m.pushPath + '?status=down&msg=boom');
  mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 0);
  await call('POST', m.pushPath, { status: 'up' });
  mm = (await call('GET', '/api/monitors')).body.find((x) => x.id === m.id);
  assert.strictEqual(mm.status, 1);
  assert.match(mm.lastMsg, /de retour après/);
  // la duplication génère un nouveau jeton
  const clone = (await call('POST', '/api/monitors', { ...mm.config, id: undefined, name: 'Cron 2' })).body;
  assert.notStrictEqual(clone.pushPath, m.pushPath);
});

test('monitor HTTP mot-clé sur le serveur lui-même', async () => {
  const r = await call('POST', '/api/monitors/test', { name: 't', type: 'keyword', url: base + '/', keyword: 'status' });
  assert.strictEqual(r.body.ok, true, r.body.msg);
  const r2 = await call('POST', '/api/monitors/test', { name: 't', type: 'keyword', url: base + '/', keyword: 'introuvable-xyz' });
  assert.strictEqual(r2.body.ok, false);
});

test('incidents et flux RSS', async () => {
  const i = (await call('POST', '/api/incidents', { title: 'Panne <test>', severity: 'danger', status: 'investigating', content: 'On regarde' })).body;
  await call('PUT', '/api/incidents/' + i.id, { ...i, status: 'resolved', updateText: 'Corrigé' });
  const pub = (await call('GET', '/api/status')).body;
  assert.strictEqual(pub.incidents[0].status, 'resolved');
  const rss = await call('GET', '/api/feed.xml');
  assert.match(rss.headers.get('content-type'), /rss/);
  assert.match(rss.body, /Panne &lt;test&gt;/);
});

test('déconnexion : la session est invalidée', async () => {
  await call('POST', '/api/logout');
  assert.strictEqual((await call('GET', '/api/monitors')).status, 401);
});
