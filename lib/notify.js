// Envoi des notifications : Discord, Slack, Telegram, webhook générique, ntfy
const http = require('http');
const https = require('https');

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
  const up = status === 1;
  const emoji = up ? '✅' : '🔴';
  const label = up ? 'EN LIGNE' : 'HORS LIGNE';
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
          color: up ? 0x2ecc71 : 0xe74c3c,
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
        Title: `${monitor.name} ${label}`, Priority: up ? '3' : '5', Tags: up ? 'white_check_mark' : 'rotating_light',
      });
    case 'gotify':
      return postJSON(`${String(c.server || '').replace(/\/$/, '')}/message?token=${encodeURIComponent(c.token || '')}`, {
        title: `${monitor.name} ${label}`, message: text, priority: up ? 4 : 8,
      });
    case 'pushover':
      return postJSON('https://api.pushover.net/1/messages.json', {
        token: c.token, user: c.userKey, title: `${monitor.name} ${label}`, message: text, priority: up ? 0 : 1,
      });
    case 'webhook':
    default:
      return postJSON(c.url, {
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, target },
        status: up ? 'up' : 'down', message: msg, ping, time: new Date().toISOString(),
      });
  }
}

module.exports = { send };
