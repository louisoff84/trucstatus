// Client SMTP minimal (sans dépendance) : TLS implicite (465) ou STARTTLS (587), AUTH PLAIN/LOGIN
const net = require('net');
const tls = require('tls');
const os = require('os');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

function sendMail({ host, port, secure, user, pass, from, to, subject, text, html, timeout = 20000, rejectUnauthorized = true }) {
  const recipients = String(to || '').split(/[,;\s]+/).filter(Boolean);
  if (!host || !from || !recipients.length) return Promise.reject(new Error('Configuration SMTP incomplète (serveur, expéditeur, destinataire)'));
  port = Number(port) || (secure ? 465 : 587);
  return new Promise((resolve, reject) => {
    let sock = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
    let buf = '';
    let waiter = null;
    let done = false;
    const fail = (e) => { if (done) return; done = true; try { sock.destroy(); } catch {} reject(e); };
    const timer = setTimeout(() => fail(new Error('SMTP : délai dépassé')), timeout);

    const attach = (s) => {
      s.setEncoding('utf8');
      s.on('data', (d) => {
        buf += d;
        // une réponse complète se termine par une ligne « 250 texte » (sans tiret)
        const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
        if (m && waiter) { const w = waiter; waiter = null; const r = buf; buf = ''; w({ code: Number(m[1]), text: r }); }
      });
      s.on('error', (e) => fail(new Error('SMTP : ' + e.message)));
    };
    attach(sock);
    const read = () => new Promise((r) => (waiter = r));
    const cmd = async (line, expect) => {
      if (line != null) sock.write(line + '\r\n');
      const r = await read();
      if (expect && !expect.includes(r.code)) throw new Error(`SMTP ${r.code} : ${r.text.trim().split('\r\n').pop().slice(4, 200)}`);
      return r;
    };

    (async () => {
      await cmd(null, [220]);
      const name = os.hostname().replace(/[^\w.-]/g, '') || 'localhost';
      let ehlo = await cmd(`EHLO ${name}`, [250]);
      if (!secure && /STARTTLS/i.test(ehlo.text)) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data');
        sock = tls.connect({ socket: sock, servername: host, rejectUnauthorized });
        attach(sock);
        await new Promise((r, j) => { sock.once('secureConnect', r); sock.once('error', j); });
        ehlo = await cmd(`EHLO ${name}`, [250]);
      }
      if (user) {
        if (/AUTH[^\r\n]*PLAIN/i.test(ehlo.text)) await cmd('AUTH PLAIN ' + b64(`\0${user}\0${pass || ''}`), [235]);
        else { await cmd('AUTH LOGIN', [334]); await cmd(b64(user), [334]); await cmd(b64(pass || ''), [235]); }
      }
      const fromAddr = (String(from).match(/<([^>]+)>/) || [])[1] || from;
      await cmd(`MAIL FROM:<${fromAddr}>`, [250]);
      for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd('DATA', [354]);
      const boundary = 'cs' + Date.now().toString(36);
      const headers = [
        `From: ${from}`, `To: ${recipients.join(', ')}`, `Subject: ${encodeHeader(subject || '')}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${name}>`, 'MIME-Version: 1.0',
      ];
      let body;
      if (html) {
        headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
        body = `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(text || ''))}`
          + `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html))}--${boundary}--\r\n`;
      } else {
        headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
        body = wrap76(b64(text || ''));
      }
      await cmd(headers.join('\r\n') + '\r\n\r\n' + body + '.', [250]);
      try { sock.write('QUIT\r\n'); } catch {}
      done = true; clearTimeout(timer); sock.end();
      resolve({ ok: true });
    })().catch((e) => { clearTimeout(timer); fail(e); });
  });
}

module.exports = { sendMail };
