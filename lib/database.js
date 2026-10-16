// Vérification de bases de données sans dépendance : MySQL/MariaDB, PostgreSQL, Redis
const net = require('net');

const DEFAULT_PORT = { mysql: 3306, postgres: 5432, redis: 6379 };

// Ouvre une connexion TCP et appelle onData(buffer cumulé, sock, finish) à chaque réception
function exchange(m, onConnect, onData) {
  return new Promise((resolve, reject) => {
    const port = Number(m.port) || DEFAULT_PORT[m.dbKind] || 3306;
    const start = Date.now();
    const sock = net.connect({ host: m.hostname, port });
    let buf = Buffer.alloc(0), done = false;
    const finish = (err, res) => {
      if (done) return; done = true; sock.destroy();
      err ? reject(err) : resolve({ ping: Math.max(1, Date.now() - start), ...res });
    };
    sock.setTimeout((m.timeout || 30) * 1000, () => finish(new Error('Timeout')));
    sock.on('error', (e) => finish(new Error(e.code === 'ECONNREFUSED' ? 'Connexion refusée' : e.message)));
    sock.on('close', () => finish(new Error('Connexion fermée par le serveur')));
    sock.on('connect', () => onConnect(sock));
    sock.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length > 1e5) return finish(new Error('Réponse trop volumineuse'));
      try { onData(buf, sock, finish, () => { buf = Buffer.alloc(0); }); } catch (e) { finish(e); }
    });
  });
}

// MySQL / MariaDB : le serveur envoie un paquet de bienvenue (handshake v10) avec sa version
function checkMysql(m) {
  return exchange(m, () => {}, (buf, sock, finish) => {
    if (buf.length < 4) return;
    const len = buf.readUIntLE(0, 3);
    if (buf.length < 4 + len) return;
    const p = buf.slice(4, 4 + len);
    if (p[0] === 0xff) {
      // paquet d'erreur : le serveur fonctionne mais refuse cet hôte (ex. « Host … is not allowed »)
      const msg = p.slice(3).toString('utf8').replace(/^#\w{5}/, '');
      return finish(null, { msg: `Serveur MySQL joignable (refus : ${msg.slice(0, 120)})` });
    }
    if (p[0] !== 10) return finish(new Error('Réponse inattendue : ce n’est pas un serveur MySQL'));
    const end = p.indexOf(0, 1);
    const version = p.slice(1, end > 0 ? end : 40).toString('utf8');
    finish(null, { msg: `${/mariadb/i.test(version) ? 'MariaDB' : 'MySQL'} ${version.replace(/-MariaDB.*$/i, '')}`, extra: { kind: 'database', engine: 'mysql', version } });
  });
}

// PostgreSQL : on envoie une SSLRequest, le serveur répond « S » ou « N »
function checkPostgres(m) {
  return exchange(m, (sock) => {
    const b = Buffer.alloc(8); b.writeInt32BE(8, 0); b.writeInt32BE(80877103, 4);
    sock.write(b);
  }, (buf, sock, finish) => {
    const c = String.fromCharCode(buf[0]);
    if (c === 'S' || c === 'N') return finish(null, { msg: `PostgreSQL joignable (SSL ${c === 'S' ? 'disponible' : 'non activé'})`, extra: { kind: 'database', engine: 'postgres', ssl: c === 'S' } });
    if (c === 'E') return finish(null, { msg: 'PostgreSQL joignable (protocole ancien)' });
    finish(new Error('Réponse inattendue : ce n’est pas un serveur PostgreSQL'));
  });
}

// Redis : AUTH (optionnel) puis PING, puis INFO server pour la version
function checkRedis(m) {
  let step = 0; // 0 = AUTH envoyé, 1 = PING envoyé, 2 = INFO envoyé
  return exchange(m, (sock) => {
    if (m.dbPassword) sock.write(`AUTH ${m.dbUser ? m.dbUser + ' ' : ''}${m.dbPassword}\r\n`);
    else { sock.write('PING\r\n'); step = 1; }
  }, (buf, sock, finish, reset) => {
    const txt = buf.toString('utf8');
    if (step < 2 && !txt.endsWith('\r\n')) return;
    if (step < 2 && txt.startsWith('-')) {
      const e = txt.slice(1).trim();
      return finish(new Error(/NOAUTH/.test(e) ? 'Redis : mot de passe requis' : 'Redis : ' + e));
    }
    if (step === 0) { step = 1; reset(); sock.write('PING\r\n'); return; }
    if (step === 1) {
      if (!txt.startsWith('+PONG')) return finish(new Error('Réponse inattendue : ce n’est pas un serveur Redis'));
      step = 2; reset(); sock.write('INFO server\r\n'); return;
    }
    // réponse INFO : $<taille>\r\n<contenu>\r\n
    const head = txt.match(/^\$(\d+)\r\n/);
    if (head && Buffer.byteLength(txt) < head[0].length + Number(head[1]) + 2) return;
    const v = (txt.match(/redis_version:([^\r\n]+)/) || [])[1] || '';
    finish(null, { msg: `Redis ${v} — PONG`.replace('  ', ' '), extra: { kind: 'database', engine: 'redis', version: v } });
  });
}

function checkDatabase(m) {
  switch (m.dbKind) {
    case 'postgres': return checkPostgres(m);
    case 'redis': return checkRedis(m);
    default: return checkMysql(m);
  }
}

module.exports = { checkDatabase, DEFAULT_PORT };
