// Import d'une sauvegarde Uptime Kuma (Paramètres → Sauvegarde → Exporter, format JSON)
const parseJSON = (v) => { if (v && typeof v === 'object') return v; try { return JSON.parse(v || '{}'); } catch { return {}; } };

// Convertit une notification Kuma → notification Craftpick (null si type non géré)
function mapNotification(n) {
  const c = parseJSON(n.config);
  const t = c.type || n.type;
  const base = { name: n.name || c.name || 'Notification Kuma', active: n.active !== 0 && n.active !== false, applyAll: !!(n.isDefault || c.isDefault) };
  switch (t) {
    case 'discord': return { ...base, type: 'discord', config: { webhookUrl: c.discordWebhookUrl, username: c.discordUsername || '' } };
    case 'slack': return { ...base, type: 'slack', config: { webhookUrl: c.slackwebhookURL } };
    case 'telegram': return { ...base, type: 'telegram', config: { botToken: c.telegramBotToken, chatId: c.telegramChatID } };
    case 'webhook': return { ...base, type: 'webhook', config: { url: c.webhookURL } };
    case 'ntfy': return { ...base, type: 'ntfy', config: { server: c.ntfyserverurl || 'https://ntfy.sh', topic: c.ntfytopic } };
    case 'gotify': return { ...base, type: 'gotify', config: { server: c.gotifyserverurl, token: c.gotifyapplicationToken } };
    case 'pushover': return { ...base, type: 'pushover', config: { token: c.pushoverapptoken, userKey: c.pushoveruserkey } };
    case 'smtp': return { ...base, type: 'email', config: { smtpHost: c.smtpHost, smtpPort: String(c.smtpPort || ''), smtpSecure: !!c.smtpSecure, smtpUser: c.smtpUsername, smtpPass: c.smtpPassword, mailFrom: c.smtpFrom, mailTo: c.smtpTo } };
    default: return null;
  }
}

// Hôte / port depuis une chaîne de connexion (mysql://user:pass@hote:3306/db, redis://…)
function parseConn(s) {
  try { const u = new URL(s); return { hostname: u.hostname, port: u.port ? Number(u.port) : null, user: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }; }
  catch { return {}; }
}

// Convertit un monitor Kuma → configuration brute Craftpick ; renvoie { monitor } ou { skip: raison }
function mapMonitor(k) {
  const common = {
    name: k.name || 'Monitor Kuma',
    interval: k.interval || 60,
    retryInterval: k.retryInterval || k.interval || 60,
    retries: k.maxretries ?? 1,
    timeout: k.timeout ? Math.round(k.timeout) : 30,
    ignoreTls: !!k.ignoreTls,
    certExpiryAlert: !!k.expiryNotification,
    description: k.description || '',
    active: k.active !== 0 && k.active !== false,
    isPublic: true,
    _kumaId: k.id, _kumaParent: k.parent || null,
    _kumaNotifs: Object.keys(parseJSON(k.notificationIDList)).filter((x) => parseJSON(k.notificationIDList)[x]).map(Number),
  };
  const codes = Array.isArray(k.accepted_statuscodes) ? k.accepted_statuscodes : parseJSON(k.accepted_statuscodes_json || '[]');
  const http = {
    url: k.url, method: (k.method || 'GET').toUpperCase(), headers: k.headers || '', body: k.body || '',
    expectedStatus: Array.isArray(codes) && codes.length ? codes.join(',') : '200-299',
    basicAuthUser: k.basic_auth_user || '', basicAuthPass: k.basic_auth_pass || '',
  };
  if (k.upsideDown) return { skip: `« ${common.name} » : le mode inversé (upside down) n’existe pas ici` };
  switch (k.type) {
    case 'http': return { monitor: { ...common, ...http, type: 'http' } };
    case 'keyword': return { monitor: { ...common, ...http, type: 'keyword', keyword: k.keyword, invertKeyword: !!k.invertKeyword } };
    case 'json-query': return { monitor: { ...common, ...http, type: 'json', jsonPath: String(k.jsonPath || '').replace(/^\$\.?/, ''), jsonExpected: k.expectedValue ?? '' } };
    case 'port': return { monitor: { ...common, type: 'tcp', hostname: k.hostname, port: k.port } };
    case 'ping': return { monitor: { ...common, type: 'ping', hostname: k.hostname } };
    case 'dns': return { monitor: { ...common, type: 'dns', hostname: k.hostname, dnsType: k.dns_resolve_type || 'A', dnsServer: k.dns_resolve_server || '' } };
    case 'push': return { monitor: { ...common, type: 'push', pushToken: /^[A-Za-z0-9]{16,64}$/.test(k.pushToken || '') ? k.pushToken : undefined } };
    case 'gamedig':
      if (/^minecraft/i.test(k.game || '') || !k.game) return { monitor: { ...common, type: 'minecraft', hostname: k.hostname, port: k.port, mcEdition: /bedrock|be$/i.test(k.game || '') ? 'bedrock' : 'java' } };
      return { skip: `« ${common.name} » : jeu GameDig « ${k.game} » non géré (Minecraft seulement)` };
    case 'mysql': case 'postgres': case 'redis': {
      const c = parseConn(k.databaseConnectionString || '');
      if (!c.hostname) return { skip: `« ${common.name} » : chaîne de connexion illisible` };
      return { monitor: { ...common, type: 'database', dbKind: k.type, hostname: c.hostname, port: c.port, dbUser: k.type === 'redis' ? c.user : '', dbPassword: k.type === 'redis' ? c.password : '' } };
    }
    case 'group': return { skip: null, group: true };
    default: return { skip: `« ${common.name} » : type Kuma « ${k.type} » non géré` };
  }
}

function convert(backup) {
  if (!backup || !Array.isArray(backup.monitorList)) throw new Error('Fichier invalide : ce n’est pas une sauvegarde Uptime Kuma (monitorList manquant)');
  const notifications = [], skipped = [];
  for (const n of backup.notificationList || []) {
    const mapped = mapNotification(n);
    if (mapped) notifications.push({ ...mapped, _kumaId: n.id });
    else skipped.push(`Notification « ${n.name} » : type non géré`);
  }
  // Les groupes Kuma deviennent le champ « groupe » de leurs enfants
  const groups = Object.fromEntries(backup.monitorList.filter((k) => k.type === 'group').map((k) => [k.id, k.name]));
  const monitors = [];
  for (const k of backup.monitorList) {
    const r = mapMonitor(k);
    if (r.group) continue;
    if (r.skip) { skipped.push(r.skip); continue; }
    if (k.parent && groups[k.parent]) { r.monitor.group = groups[k.parent]; r.monitor._kumaParent = null; }
    monitors.push(r.monitor);
  }
  return { monitors, notifications, skipped };
}

module.exports = { convert, mapMonitor, mapNotification };
