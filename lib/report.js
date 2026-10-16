// Rapport de disponibilité (hebdomadaire) : uptime, pannes, durée d'indisponibilité, ping moyen, pic de joueurs
const db = require('./db');
const { fmtDuration } = require('./monitor');

const EMOJI = { 1: '🟢', 4: '🟠', 0: '🔴', 3: '🔧', 2: '⚪', '-1': '⏸️' };

function monitorReport(m, days, now) {
  const since = now - days * 86400000;
  const beats = (db.data.beats[m.id] || []).filter((b) => b.t >= since);
  // Uptime et ping moyen sur les agrégats journaliers (plus fiables sur 7 jours)
  let up = 0, n = 0, p = 0, pn = 0;
  for (let i = 0; i < days; i++) {
    const d = (db.data.daily[m.id] || {})[db.dayKey(now - i * 86400000)];
    if (d) { up += d.up; n += d.n; p += d.p; pn += d.pn; }
  }
  // Pannes : séquences de battements "hors ligne"
  let outages = 0, downtime = 0, downStart = null, peak = null;
  for (const b of beats) {
    if (b.pl != null) peak = Math.max(peak ?? 0, b.pl);
    if (b.s === 2) continue;
    if (b.s === 0 && downStart === null) { downStart = b.t; outages++; }
    else if (b.s !== 0 && downStart !== null) { downtime += b.t - downStart; downStart = null; }
  }
  if (downStart !== null) downtime += now - downStart;
  return {
    id: m.id, name: m.name, group: m.group, type: m.type,
    uptime: n ? (up / n) * 100 : null,
    avgPing: pn ? Math.round(p / pn) : null,
    outages, downtime, peakPlayers: peak,
  };
}

function buildReport({ days = 7, now = Date.now(), title = 'Craftpick Status', monitorIds = null } = {}) {
  const list = db.data.monitors.filter((m) => m.active && (!monitorIds || monitorIds.includes(m.id))).map((m) => monitorReport(m, days, now));
  const withData = list.filter((r) => r.uptime != null);
  const avg = withData.length ? withData.reduce((a, r) => a + r.uptime, 0) / withData.length : null;
  const totalOutages = list.reduce((a, r) => a + r.outages, 0);
  const pct = (v) => (v == null ? '—' : v >= 99.995 ? '100 %' : v.toFixed(2) + ' %');
  const from = new Date(now - days * 86400000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const to = new Date(now).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

  const lines = list
    .sort((a, b) => (a.uptime ?? 101) - (b.uptime ?? 101))
    .map((r) => {
      const e = r.uptime == null ? '⚪' : r.uptime >= 99.9 ? '🟢' : r.uptime >= 99 ? '🟠' : '🔴';
      const parts = [`**${pct(r.uptime)}**`];
      if (r.outages) parts.push(`${r.outages} panne${r.outages > 1 ? 's' : ''} (${fmtDuration(r.downtime)})`);
      if (r.avgPing != null) parts.push(`${r.avgPing} ms`);
      if (r.peakPlayers != null) parts.push(`pic ${r.peakPlayers} joueur${r.peakPlayers > 1 ? 's' : ''}`);
      return `${e} ${r.name} — ${parts.join(' · ')}`;
    });

  const head = `Période : ${from} → ${to}\nDisponibilité moyenne : **${pct(avg)}** · ${totalOutages} panne${totalOutages > 1 ? 's' : ''} au total`;
  return {
    title: `📊 Rapport hebdomadaire — ${title}`,
    text: `${head}\n\n${lines.join('\n') || 'Aucun monitor actif.'}`,
    color: avg == null ? 0x6b7280 : avg >= 99.9 ? 0x2ecc71 : avg >= 99 ? 0xf39c12 : 0xe74c3c,
    monitors: list, average: avg, outages: totalOutages,
  };
}

module.exports = { buildReport, monitorReport, EMOJI };
