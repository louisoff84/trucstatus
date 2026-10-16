// Stockage JSON persistant avec écriture atomique et différée
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'db.json');

const RAW_RETENTION_MS = 7 * 24 * 3600 * 1000; // battements bruts : 7 jours
const RAW_MAX = 20000;                            // max par monitor
const DAILY_RETENTION = 90;                       // agrégats journaliers : 90 jours

const defaults = () => ({
  settings: {
    title: 'Craftpick Status',
    description: 'État en temps réel de nos services',
    adminHash: null,
    salt: null,
  },
  monitors: [],
  beats: {},   // monitorId -> [{t, s, p, m}]
  daily: {},   // monitorId -> { 'YYYY-MM-DD': {up, n, p, pn} }
  incidents: [],
  notifications: [],
  pages: [],   // pages de status supplémentaires (/s/<slug>)
  nextId: 1,
});

let data = defaults();
let saveTimer = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    try {
      data = Object.assign(defaults(), JSON.parse(fs.readFileSync(FILE, 'utf8')));
    } catch (e) {
      console.error('[db] Fichier corrompu, copie en .bak et réinitialisation :', e.message);
      fs.copyFileSync(FILE, FILE + '.bak');
      data = defaults();
    }
  }
  return data;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, FILE);
}

function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 2000);
}

function nextId() {
  const id = data.nextId++;
  save();
  return id;
}

function dayKey(t) {
  const d = new Date(t);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// s : 1 = up, 0 = down, 2 = pending, 3 = maintenance
function addBeat(monitorId, beat) {
  const list = (data.beats[monitorId] ||= []);
  list.push(beat);
  const cutoff = Date.now() - RAW_RETENTION_MS;
  let drop = 0;
  while (drop < list.length && (list[drop].t < cutoff || list.length - drop > RAW_MAX)) drop++;
  if (drop) list.splice(0, drop);

  if (beat.s !== 2) { // pending ne compte pas dans l'uptime
    const daily = (data.daily[monitorId] ||= {});
    const k = dayKey(beat.t);
    const d = (daily[k] ||= { up: 0, n: 0, p: 0, pn: 0 });
    d.n++;
    if (beat.s === 1 || beat.s === 3 || beat.s === 4) d.up++; // dégradé = disponible, mais signalé
    if (beat.s === 4) d.dg = (d.dg || 0) + 1;
    if ((beat.s === 1 || beat.s === 4) && typeof beat.p === 'number') { d.p += beat.p; d.pn++; }
    const keys = Object.keys(daily).sort();
    while (keys.length > DAILY_RETENTION) delete daily[keys.shift()];
  }
  save();
}

function removeMonitorData(id) {
  delete data.beats[id];
  delete data.daily[id];
  save();
}

module.exports = { load, save, saveNow, nextId, addBeat, removeMonitorData, dayKey, get data() { return data; } };
