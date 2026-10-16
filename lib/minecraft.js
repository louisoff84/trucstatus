// Vérification de serveurs Minecraft : Java (Server List Ping) et Bedrock (ping RakNet)
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;

function writeVarInt(n) {
  const out = [];
  n >>>= 0;
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function readVarInt(buf, off) {
  let num = 0, shift = 0, b;
  do {
    if (off >= buf.length) return null; // données incomplètes
    b = buf[off++];
    num |= (b & 0x7f) << shift;
    shift += 7;
    if (shift > 35) throw new Error('VarInt invalide');
  } while (b & 0x80);
  return { value: num, off };
}
function mcString(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([writeVarInt(b.length), b]); }
function packet(id, ...parts) { const body = Buffer.concat([writeVarInt(id), ...parts]); return Buffer.concat([writeVarInt(body.length), body]); }

// Texte brut d'un composant de chat Minecraft (MOTD)
function chatText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(chatText).join('');
  return (c.text || c.translate || '') + (c.extra ? c.extra.map(chatText).join('') : '');
}
const stripCodes = (s) => String(s).replace(/§./g, '').replace(/\s+/g, ' ').trim();

async function resolveJava(host, port) {
  if (port) return { host, port };
  try {
    const srv = await dns.resolveSrv('_minecraft._tcp.' + host);
    if (srv && srv[0]) return { host: srv[0].name, port: srv[0].port };
  } catch {}
  return { host, port: 25565 };
}

async function checkJava(m) {
  const { host, port } = await resolveJava(m.hostname, m.port);
  return new Promise((resolve, reject) => {
    const timeout = (m.timeout || 30) * 1000;
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    let sentAt = 0;
    let done = false;
    const finish = (err, res) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(res); };
    sock.setTimeout(timeout, () => finish(new Error('Timeout')));
    sock.on('error', (e) => finish(new Error(e.code === 'ECONNREFUSED' ? 'Connexion refusée' : e.message)));
    sock.on('close', () => finish(new Error('Connexion fermée par le serveur')));
    sock.on('connect', () => {
      const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
      // Handshake (protocole 767, état suivant = status) puis Status Request
      sock.write(packet(0x00, writeVarInt(767), mcString(m.hostname), portBuf, writeVarInt(1)));
      sock.write(packet(0x00));
      sentAt = Date.now();
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 1e6) return finish(new Error('Réponse trop volumineuse'));
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.off + len.value) return;
        const id = readVarInt(buf, len.off);
        if (id.value !== 0x00) return finish(new Error('Réponse inattendue du serveur'));
        const sl = readVarInt(buf, id.off);
        const json = JSON.parse(buf.slice(sl.off, sl.off + sl.value).toString('utf8'));
        const ping = Math.max(1, Date.now() - sentAt);
        const online = json.players ? Number(json.players.online) || 0 : 0;
        const max = json.players ? Number(json.players.max) || 0 : 0;
        const version = stripCodes(json.version ? json.version.name : '');
        const motd = stripCodes(chatText(json.description));
        finish(null, {
          ping, players: online,
          msg: `${online}/${max} joueurs · ${version}`,
          extra: { kind: 'minecraft', online, max, version, motd: motd.slice(0, 200), sample: ((json.players && json.players.sample) || []).slice(0, 12).map((p) => stripCodes(p.name)) },
        });
      } catch (e) { finish(new Error('Réponse illisible : ' + e.message)); }
    });
  });
}

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
async function checkBedrock(m) {
  const port = m.port || 19132;
  const { address, family } = await dns.lookup(m.hostname);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    let done = false;
    const finish = (err, res) => { if (done) return; done = true; clearTimeout(timer); try { sock.close(); } catch {} err ? reject(err) : resolve(res); };
    const timer = setTimeout(() => finish(new Error('Timeout (aucune réponse UDP)')), (m.timeout || 30) * 1000);
    const start = Date.now();
    const pkt = Buffer.alloc(33);
    pkt[0] = 0x01;
    pkt.writeBigInt64BE(BigInt(start), 1);
    MAGIC.copy(pkt, 9);
    pkt.writeBigInt64BE(2n, 25);
    sock.on('error', (e) => finish(e));
    sock.on('message', (msg) => {
      if (msg[0] !== 0x1c || msg.length < 35) return;
      const len = msg.readUInt16BE(33);
      const parts = msg.slice(35, 35 + len).toString('utf8').split(';');
      // MCPE;MOTD;protocole;version;joueurs;max;id;MOTD2;mode;...
      const online = Number(parts[4]) || 0, max = Number(parts[5]) || 0;
      const version = parts[3] || '';
      finish(null, {
        ping: Math.max(1, Date.now() - start), players: online,
        msg: `${online}/${max} joueurs · Bedrock ${version}`,
        extra: { kind: 'minecraft', online, max, version: 'Bedrock ' + version, motd: stripCodes([parts[1], parts[7]].filter(Boolean).join(' — ')).slice(0, 200), sample: [] },
      });
    });
    sock.send(pkt, port, address, (e) => { if (e) finish(e); });
  });
}

function checkMinecraft(m) {
  return m.mcEdition === 'bedrock' ? checkBedrock(m) : checkJava(m);
}

module.exports = { checkMinecraft, writeVarInt, readVarInt, mcString, packet, MAGIC };
