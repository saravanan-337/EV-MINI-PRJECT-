// CellScope seed: ONE self-contained file. Creates tables and loads 200 vehicles / 4,000 sessions.
// Run with: npm run seed   (or: node seed.js). Dry check without a database: node seed.js --dry
// Deterministic generator: 200 vehicles x 20 charging sessions = 4,000 sessions.
const rng = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const gs = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(6.2832 * r());

const STATIONS = [
  ["CS-101", "Bandra Kurla Complex"], ["CS-102", "Powai"], ["CS-103", "Thane"],
  ["CS-104", "Andheri East"], ["CS-105", "Navi Mumbai - Vashi"], ["CS-106", "Lower Parel"],
  ["CS-107", "Borivali"], ["CS-108", "Pune - Hinjewadi"], ["CS-109", "Nashik Road"], ["CS-110", "Lonavala Expressway"],
];

// [model, battery kWh]
const MODELS = [
  ["Tata Nexon EV", 40.5], ["Tata Tigor EV", 26], ["Tata Punch EV", 35], ["MG ZS EV", 50.3],
  ["MG Comet EV", 17.3], ["Hyundai Kona Electric", 39.2], ["Mahindra XUV400", 39.4],
  ["BYD Atto 3", 60.5], ["Citroen eC3", 29.2], ["Mahindra BE 6", 59],
];

// [label, baseTemp, kW, SoH slope per session, full-charge prob]
const ARCHETYPES = [
  ["Healthy battery", 35, 11, -0.12, 0.1],
  ["Excellent habits", 33, 7, -0.07, 0],
  ["Fast charging, runs hot", 42, 40, -0.35, 0.3],
  ["Declining health", 41, 25, -0.9, 0.5],
  ["Heavy daily use", 38, 22, -0.25, 0.25],
];

const DEMO = {
  MH01AB1234: ["Tata Nexon EV", 40.5, 36, 12, -0.15, 0.1, "Healthy battery"],
  MH02CD5678: ["MG ZS EV", 50.3, 42, 40, -0.35, 0.3, "Fast charging, runs hot"],
  MH03EF9012: ["Hyundai Kona Electric", 39.2, 41, 25, -0.9, 0.5, "Declining health"],
  MH04GH3456: ["Tata Tigor EV", 26, 33, 7, -0.08, 0, "Excellent habits"],
};

const STATES = ["MH", "MH", "MH", "MH", "KA", "DL", "GJ", "TN"];
const L = "ABCDEFGHJKLMNPRSTUVWXYZ";

function generate(total = 200) {
  const vehicles = [];
  const used = new Set(Object.keys(DEMO));
  let k = 0;
  for (const [no, [model, kwh, base, kw, slope, full, note]] of Object.entries(DEMO))
    vehicles.push({ no, model, kwh, base, kw, slope, full, note, demo: true, seed: 42 + k++, soh0: 100 });

  const pick = r => r();
  let n = 0;
  while (vehicles.length < total) {
    const r = rng(5000 + n++);
    const state = STATES[Math.floor(pick(r) * STATES.length)];
    const no = state + String(1 + Math.floor(pick(r) * 49)).padStart(2, "0") +
      L[Math.floor(pick(r) * L.length)] + L[Math.floor(pick(r) * L.length)] +
      String(1000 + Math.floor(pick(r) * 9000));
    if (used.has(no)) continue;
    used.add(no);
    const [model, kwh] = MODELS[Math.floor(pick(r) * MODELS.length)];
    const [note, base, kw, slope, full] = ARCHETYPES[Math.floor(pick(r) * ARCHETYPES.length)];
    vehicles.push({
      no, model, kwh, note, demo: false, seed: 9000 + n,
      base: +(base + gs(r) * 1.5).toFixed(1), kw: Math.max(3, +(kw + gs(r) * 3).toFixed(1)),
      slope: +(slope * (0.8 + pick(r) * 0.4)).toFixed(3), full,
      soh0: Math.min(100, +(100 - pick(r) * 10).toFixed(1)),
    });
  }

  for (const v of vehicles) {
    const r = rng(v.seed);
    v.sessions = [];
    for (let i = 0; i < 20; i++) {
      const s = STATIONS[Math.floor(r() * STATIONS.length)];
      const peak = +(v.base + gs(r) * 2 + v.kw / 20).toFixed(1);
      v.sessions.push({
        station: s[0],
        start: new Date(Date.UTC(2026, 5, 1 + 2 * i, 6 + Math.floor(r() * 16), Math.floor(r() * 60))),
        dur: 25 + Math.floor(r() * 65),
        peak,
        avg: +(peak - 0.5 - r() * 1.5).toFixed(1),
        kw: +Math.max(2, v.kw + gs(r) * v.kw * 0.2).toFixed(1),
        soc: r() < v.full ? 100 : 70 + Math.floor(r() * 25),
        soh: +(v.soh0 + v.slope * (i + 1) + gs(r) * 0.1).toFixed(1),
      });
    }
    const l5 = v.sessions.slice(-5).reduce((a, x) => a + x.peak, 0) / 5;
    v.pred = +(l5 + 0.5 + gs(r) * 0.4).toFixed(1);
  }
  return vehicles;
}


const SCHEMA = `
-- CellScope schema (PostgreSQL)
CREATE TABLE IF NOT EXISTS vehicle (
  vehicle_no  text PRIMARY KEY CHECK (vehicle_no ~ '^[A-Z]{2}[0-9]{2}[A-Z]{1,3}[0-9]{4}$'),
  model       text NOT NULL,
  battery_kwh numeric(6,1) NOT NULL CHECK (battery_kwh > 0),
  note        text,
  is_demo     boolean NOT NULL DEFAULT false
);
ALTER TABLE vehicle ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS charging_station (
  station_id text PRIMARY KEY,
  location   text NOT NULL
);

CREATE TABLE IF NOT EXISTS charging_session (
  session_id   serial PRIMARY KEY,
  vehicle_no   text NOT NULL REFERENCES vehicle(vehicle_no) ON DELETE CASCADE,
  station_id   text NOT NULL REFERENCES charging_station(station_id),
  start_time   timestamptz NOT NULL,
  duration_min int NOT NULL CHECK (duration_min > 0),
  peak_temp    numeric(4,1) NOT NULL,
  avg_temp     numeric(4,1) NOT NULL,
  avg_kw       numeric(5,1) NOT NULL CHECK (avg_kw >= 0),
  end_soc      int NOT NULL CHECK (end_soc BETWEEN 0 AND 100),
  est_soh      numeric(4,1) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_vehicle_time ON charging_session (vehicle_no, start_time);

CREATE TABLE IF NOT EXISTS prediction (
  vehicle_no           text PRIMARY KEY REFERENCES vehicle(vehicle_no) ON DELETE CASCADE,
  predicted_peak_temp  numeric(4,1) NOT NULL,
  based_on_session_id  int REFERENCES charging_session(session_id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW v_thermal_alerts AS
SELECT s.*, CASE WHEN peak_temp > 45 THEN 'too_hot' ELSE 'too_cold' END AS alert_type
FROM charging_session s
WHERE peak_temp > 45 OR peak_temp < 15;
`;

const vehicles = generate(200);
const RE = /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$/;

if (process.argv.includes("--dry")) {
  const bad = vehicles.filter(v => !RE.test(v.no));
  const sess = vehicles.reduce((a, v) => a + v.sessions.length, 0);
  console.log({ vehicles: vehicles.length, unique: new Set(vehicles.map(v => v.no)).size, sessions: sess, badNumbers: bad.length });
  console.log("Sample numbers:", vehicles.slice(0, 8).map(v => v.no).join(", "));
  process.exit(0);
}

require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(SCHEMA);
    await c.query("TRUNCATE prediction, charging_session, charging_station, vehicle RESTART IDENTITY CASCADE");
    for (const [id, loc] of STATIONS) await c.query("INSERT INTO charging_station VALUES ($1,$2)", [id, loc]);

    for (const v of vehicles) {
      await c.query("INSERT INTO vehicle (vehicle_no, model, battery_kwh, note, is_demo) VALUES ($1,$2,$3,$4,$5)",
        [v.no, v.model, v.kwh, v.note, v.demo]);
      const vals = [], args = [];
      v.sessions.forEach((s, i) => {
        const o = i * 9;
        vals.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`);
        args.push(v.no, s.station, s.start, s.dur, s.peak, s.avg, s.kw, s.soc, s.soh);
      });
      const res = await c.query(
        `INSERT INTO charging_session (vehicle_no,station_id,start_time,duration_min,peak_temp,avg_temp,avg_kw,end_soc,est_soh)
         VALUES ${vals.join(",")} RETURNING session_id`, args);
      const lastId = Math.max(...res.rows.map(r => r.session_id));
      await c.query("INSERT INTO prediction (vehicle_no,predicted_peak_temp,based_on_session_id) VALUES ($1,$2,$3)",
        [v.no, v.pred, lastId]);
    }
    await c.query("COMMIT");
    console.log(`Seeded ${vehicles.length} vehicles and ${vehicles.length * 20} sessions.`);
    console.log("Try these vehicle numbers:", vehicles.slice(0, 8).map(v => v.no).join(", "));
  } catch (e) { await c.query("ROLLBACK"); console.error(e); process.exitCode = 1; }
  finally { c.release(); await pool.end(); }
})();
