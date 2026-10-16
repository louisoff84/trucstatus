// Fenêtres de maintenance : ponctuelles (startsAt → endsAt) ou récurrentes (jours + créneau horaire, heure locale du serveur)
const DAY_NAMES = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const toMin = (hhmm) => { const [h, m] = String(hhmm || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };

function inRecurringWindow(rec, date) {
  const s = toMin(rec.start), e = toMin(rec.end);
  if (s == null || e == null || !Array.isArray(rec.days) || !rec.days.length) return false;
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  if (s < e) return rec.days.includes(day) && mins >= s && mins < e;
  // créneau qui passe minuit (ex. 23:30 → 00:30)
  const prev = (day + 6) % 7;
  return (rec.days.includes(day) && mins >= s) || (rec.days.includes(prev) && mins < e);
}

// La maintenance est-elle en cours à cet instant ?
function maintenanceActive(i, now = Date.now()) {
  if (i.severity !== 'maintenance' || i.status === 'resolved') return false;
  const start = i.startsAt ? new Date(i.startsAt).getTime() : null;
  const end = i.endsAt ? new Date(i.endsAt).getTime() : null;
  if (i.recurrence) {
    // startsAt / endsAt bornent alors la période de validité de la récurrence
    if (start && now < start) return false;
    if (end && now > end) return false;
    return inRecurringWindow(i.recurrence, new Date(now));
  }
  return (!start || start <= now) && (!end || end >= now);
}

function describeRecurrence(rec) {
  if (!rec) return '';
  const days = [...rec.days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  const key = days.join();
  const label = days.length === 7 ? 'tous les jours'
    : key === '1,2,3,4,5' ? 'du lundi au vendredi'
    : key === '6,0' ? 'le week-end'
    : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${label}, ${rec.start} – ${rec.end}`;
}

function sanitizeRecurrence(r) {
  if (!r || !Array.isArray(r.days)) return null;
  const days = [...new Set(r.days.map(Number).filter((d) => d >= 0 && d <= 6))];
  const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
  if (!days.length) throw new Error('Choisis au moins un jour pour la maintenance récurrente');
  if (!ok(r.start) || !ok(r.end) || r.start === r.end) throw new Error('Créneau horaire invalide (format HH:MM, début ≠ fin)');
  return { days, start: r.start, end: r.end };
}

module.exports = { maintenanceActive, inRecurringWindow, describeRecurrence, sanitizeRecurrence };
