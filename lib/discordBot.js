// Commande Discord /status via « Interactions Endpoint URL » (HTTP, sans bot connecté en permanence)
const crypto = require('crypto');
const https = require('https');
const { buildEmbed } = require('./discordLive');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // en-tête DER d'une clé publique Ed25519

// Vérifie la signature Ed25519 envoyée par Discord (obligatoire, sinon Discord refuse l'URL)
function verify(publicKeyHex, signatureHex, timestamp, rawBody) {
  try {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex || '')) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(String(timestamp) + rawBody), key, Buffer.from(signatureHex, 'hex'));
  } catch { return false; }
}

const EMOJI = { 1: '🟢', 4: '🟠', 0: '🔴', 3: '🔧', 2: '⚪', '-1': '⏸️' };
const LABEL = { 1: 'En ligne', 4: 'Dégradé', 0: 'Hors ligne', 3: 'Maintenance', 2: 'Vérification…', '-1': 'En pause' };
const pct = (v) => (v == null ? '—' : v >= 99.995 ? '100 %' : v.toFixed(2) + ' %');

// Réponse à une interaction ; status = état de la page (comme /api/status)
function handleInteraction(body, status) {
  if (body.type === 1) return { type: 1 }; // PING de vérification
  if (body.type === 2 && body.data && body.data.name === 'status') {
    const opt = (body.data.options || []).find((o) => o.name === 'service');
    if (opt && opt.value) {
      const q = String(opt.value).toLowerCase();
      const m = status.monitors.find((x) => x.name.toLowerCase() === q) || status.monitors.find((x) => x.name.toLowerCase().includes(q));
      if (!m) return { type: 4, data: { content: `Aucun service ne correspond à « ${String(opt.value).slice(0, 50)} ».`, flags: 64 } };
      const fields = [
        { name: 'Statut', value: `${EMOJI[m.status]} ${LABEL[m.status]}`, inline: true },
        { name: 'Ping', value: m.ping != null ? `${m.ping} ms` : '—', inline: true },
        { name: 'Disponibilité', value: `24 h : ${pct(m.uptime24)}\n30 j : ${pct(m.uptime30)}`, inline: true },
      ];
      if (m.mc) fields.push({ name: 'Joueurs', value: `👥 ${m.mc.online}/${m.mc.max}`, inline: true }, { name: 'Version', value: m.mc.version || '—', inline: true });
      return { type: 4, data: { embeds: [{ title: m.name, url: status.url ? status.url.replace(/\/$/, '') + '/service/' + m.id : undefined, description: m.description || undefined, color: m.status === 0 ? 0xe74c3c : m.status === 4 ? 0xf39c12 : 0x2ecc71, fields, timestamp: new Date().toISOString() }] } };
    }
    return { type: 4, data: { embeds: [buildEmbed(status)] } };
  }
  // autocomplétion du paramètre « service »
  if (body.type === 4 && body.data && body.data.name === 'status') {
    const focused = (body.data.options || []).find((o) => o.focused);
    const q = String((focused && focused.value) || '').toLowerCase();
    return { type: 8, data: { choices: status.monitors.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 25).map((m) => ({ name: m.name.slice(0, 100), value: m.name.slice(0, 100) })) } };
  }
  return { type: 4, data: { content: 'Commande inconnue.', flags: 64 } };
}

// Enregistre (ou met à jour) la commande /status pour l'application
function registerCommand(applicationId, botToken) {
  const body = JSON.stringify({
    name: 'status', description: 'État des serveurs et services',
    options: [{ type: 3, name: 'service', description: 'Un service en particulier (facultatif)', required: false, autocomplete: true }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(`https://discord.com/api/v10/applications/${encodeURIComponent(applicationId)}/commands`, {
      method: 'POST', headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000,
    }, (res) => {
      let t = ''; res.on('data', (c) => (t += c));
      res.on('end', () => (res.statusCode < 300 ? resolve(JSON.parse(t)) : reject(new Error(`Discord : HTTP ${res.statusCode} ${t.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('Timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { verify, handleInteraction, registerCommand };
