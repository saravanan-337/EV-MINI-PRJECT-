require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const path = require("path");
const { setupAuth, requireAdmin, initAuth } = require("./auth");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.set("trust proxy", false);
app.use(express.json({ limit: "10kb" }));
setupAuth(app, pool);
// The dashboard needs a login; login.html is public
app.get(["/", "/index.html"], (req, res) =>
  req.user ? res.sendFile(path.join(__dirname, "public", "index.html")) : res.redirect("/login.html"));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

const VEHICLE_RE = /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$/;

const SESSIONS_SQL = `
  SELECT s.session_id AS id, s.vehicle_no, s.start_time AS start, s.duration_min AS dur,
         s.station_id AS st, st.location AS loc, s.peak_temp::float AS peak, s.avg_temp::float AS avg,
         s.avg_kw::float AS kw, s.end_soc AS soc, s.est_soh::float AS soh
  FROM charging_session s JOIN charging_station st USING (station_id)`;

async function build(vehicles) {
  const nos = vehicles.map(v => v.vehicle_no);
  const [ses, pred] = await Promise.all([
    pool.query(`${SESSIONS_SQL} WHERE s.vehicle_no = ANY($1) ORDER BY s.start_time, s.session_id`, [nos]),
    pool.query("SELECT vehicle_no, predicted_peak_temp::float AS t, based_on_session_id AS sid FROM prediction WHERE vehicle_no = ANY($1)", [nos]),
  ]);
  const out = {};
  for (const v of vehicles) {
    const p = pred.rows.find(x => x.vehicle_no === v.vehicle_no);
    out[v.vehicle_no] = {
      model: v.model, kwh: +v.battery_kwh,
      rows: ses.rows.filter(r => r.vehicle_no === v.vehicle_no),
      pred: p ? { t: p.t, sid: p.sid } : null,
    };
  }
  return out;
}

const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: "Database error" }); });

app.get("/api/vehicles", wrap(async (req, res) => {
  const all = req.query.all === "1";
  const { rows } = await pool.query(`SELECT vehicle_no, note FROM vehicle ${all ? "" : "WHERE is_demo"} ORDER BY vehicle_no`);
  res.json(rows);
}));

app.get("/api/vehicles/:no", wrap(async (req, res) => {
  const no = req.params.no.toUpperCase().replace(/\s/g, "");
  if (!VEHICLE_RE.test(no)) return res.status(400).json({ error: "Invalid vehicle number" });
  const v = await pool.query("SELECT * FROM vehicle WHERE vehicle_no = $1", [no]);
  if (!v.rows.length) return res.status(404).json({ error: "Vehicle not found" });
  const data = (await build(v.rows))[no];
  if (!data.rows.length) return res.status(404).json({ error: "No charging sessions recorded" });
  res.json(data);
}));

app.get("/api/fleet", requireAdmin, wrap(async (_req, res) => {
  const v = await pool.query("SELECT * FROM vehicle ORDER BY vehicle_no");
  res.json(await build(v.rows));
}));

const port = process.env.PORT || 3000;
initAuth(pool)
  .then(() => app.listen(port, () => console.log(`CellScope on http://localhost:${port}`)))
  .catch(e => { console.error("Could not set up login tables:", e.message); process.exit(1); });
