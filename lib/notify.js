// Envoi des notifications : Discord, Slack, Telegram, webhook générique, ntfy
const http = require('http');
const https = require('https');
const { sendMail } = require('./smtp');

function mail(c, subject, text) {
  return sendMail({ host: c.smtpHost, port: c.smtpPort, secure: !!c.smtpSecure, user: c.smtpUser, pass: c.smtpPass, from: c.mailFrom, to: c.mailTo, subject, text });
}

function postJSON(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      timeout: 10000,
    }, (res) => {
      let txt = '';
      res.on('data', (c) => (txt += c));
      res.on('end', () => (res.statusCode < 300 ? resolve(txt) : reject(new Error(`HTTP ${res.statusCode} : ${txt.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function send(notif, { monitor, status, msg, ping }) {
  const up = status === 1 || status === 4;
  const degraded = status === 4;
  const emoji = degraded ? '🟠' : up ? '✅' : '🔴';
  const label = degraded ? 'DÉGRADÉ' : up ? 'EN LIGNE' : 'HORS LIGNE';
  const target = monitor.url || (monitor.hostname ? monitor.hostname + (monitor.port ? ':' + monitor.port : '') : '');
  const text = `${emoji} [${monitor.name}] ${label}\n${msg || ''}${ping != null && up ? `\nTemps de réponse : ${ping} ms` : ''}${target ? `\n${target}` : ''}`;
  const c = notif.config || {};

  switch (notif.type) {
    case 'discord':
      return postJSON(c.webhookUrl, {
        username: c.username || 'Craftpick Status',
        embeds: [{
          title: `${emoji} ${monitor.name} est ${label}`,
          description: msg || '',
          color: degraded ? 0xf39c12 : up ? 0x2ecc71 : 0xe74c3c,
          fields: [
            ...(target ? [{ name: 'Cible', value: target }] : []),
            ...(ping != null && up ? [{ name: 'Ping', value: `${ping} ms`, inline: true }] : []),
          ],
          timestamp: new Date().toISOString(),
        }],
      });
    case 'slack':
      return postJSON(c.webhookUrl, { text });
    case 'telegram':
      return postJSON(`https://api.telegram.org/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text });
    case 'ntfy':
      return postJSON(`${(c.server || 'https://ntfy.sh').replace(/\/$/, '')}/${c.topic}`, text, {
        Title: `${monitor.name} ${label}`, Priority: up ? '3' : '5', Tags: degraded ? 'warning' : up ? 'white_check_mark' : 'rotating_light',
      });
    case 'gotify':
      return postJSON(`${String(c.server || '').replace(/\/$/, '')}/message?token=${encodeURIComponent(c.token || '')}`, {
        title: `${monitor.name} ${label}`, message: text, priority: up ? 4 : 8,
      });
    case 'pushover':
      return postJSON('https://api.pushover.net/1/messages.json', {
        token: c.token, user: c.userKey, title: `${monitor.name} ${label}`, message: text, priority: up ? 0 : 1,
      });
    case 'email':
      return mail(c, `${emoji} ${monitor.name} — ${label}`, text + '\n\n— Craftpick Status');
    case 'webhook':
    default:
      return postJSON(c.url, {
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, target },
        status: degraded ? 'degraded' : up ? 'up' : 'down', message: msg, ping, time: new Date().toISOString(),
      });
  }
}

// Message libre (rapport hebdomadaire…) sur n'importe quel canal
async function sendText(notif, { title, text, color = 0x3b82f6 }) {
  const c = notif.config || {};
  switch (notif.type) {
    case 'discord':
      return postJSON(c.webhookUrl, { username: c.username || 'Craftpick Status', embeds: [{ title, description: text.slice(0, 4000), color, timestamp: new Date().toISOString() }] });
    case 'slack':
      return postJSON(c.webhookUrl, { text: `*${title}*\n${text}` });
    case 'telegram':
      return postJSON(`https://api.telegram.org/bot${c.botToken}/sendMessage`, { chat_id: c.chatId, text: `${title}\n\n${text}`.slice(0, 4000) });
    case 'ntfy':
      return postJSON(`${(c.server || 'https://ntfy.sh').replace(/\/$/, '')}/${c.topic}`, text.replace(/\*\*/g, ''), { Title: title, Tags: 'bar_chart' });
    case 'gotify':
      return postJSON(`${String(c.server || '').replace(/\/$/, '')}/message?token=${encodeURIComponent(c.token || '')}`, { title, message: text.replace(/\*\*/g, ''), priority: 3 });
    case 'pushover':
      return postJSON('https://api.pushover.net/1/messages.json', { token: c.token, user: c.userKey, title, message: text.replace(/\*\*/g, '').slice(0, 1000) });
    case 'email':
      return mail(c, title, text.replace(/\*\*/g, '') + '\n\n— Craftpick Status');
    case 'webhook':
    default:
      return postJSON(c.url, { type: 'report', title, text, time: new Date().toISOString() });
  }
}

module.exports = { send, sendText, postJSON };
