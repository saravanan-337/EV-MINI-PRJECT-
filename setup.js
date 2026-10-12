// Creates the tables, loads data/DATA_SET__FINAL___1_.csv, and adds the demo accounts.
//   npm run setup                  normal run (safe to repeat; skips the CSV if it is already loaded)
//   npm run setup -- --reimport    delete the loaded charging sessions and load the CSV again
//   npm run setup -- --reset       DROP every CellScope table (including users) and start fresh
require('dotenv').config();
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { parse } = require('csv-parse/sync');
const { Pool } = require('pg');

const CSV = path.join(__dirname, 'data', 'DATA_SET__FINAL___1_.csv');
const args = process.argv.slice(2);
const RESET = args.includes('--reset'), REIMPORT = args.includes('--reimport');

const num = s => { if (s == null || String(s).trim() === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
// Accepts only "dd-mm-yyyy hh:mm". Anything else (for example the "40:48.0" values the CSV has) becomes null.
function dt(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const [d, mo, y, h, mi] = m.slice(1).map(Number);
  const x = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return x.getUTCFullYear() === y && x.getUTCMonth() === mo - 1 && x.getUTCDate() === d && h < 24 && mi < 60 ? x : null;
}
const normVehicle = s => String(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();

async function insertChunks(db, table, cols, rows, size, suffix = '') {
  for (let i = 0; i < rows.length; i += size) {
    const part = rows.slice(i, i + size), params = [];
    const values = part.map((r, k) => '(' + r.map((v, j) => { params.push(v); return '$' + (k * cols.length + j + 1); }).join(',') + ')').join(',');
    await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${suffix}`, params);
  }
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing. Copy .env.example to .env and fill it in.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  if (RESET) {
    await pool.query('DROP TABLE IF EXISTS login_events, charging_sessions, stations, users, vehicles CASCADE');
    console.log('Dropped all CellScope tables.');
  } else {
    // The first version of this project had a different layout. Don't silently mix the two.
    const old = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name='charging_sessions'`);
    const has = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='charging_sessions' AND column_name='twin_id'`);
    if (old.rowCount && !has.rowCount) {
      throw new Error('Your database has the older CellScope tables. Run "npm run setup -- --reset" once to rebuild them (this deletes any accounts created so far).');
    }
  }

  await pool.query(fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8'));

  const existing = (await pool.query('SELECT count(*)::int AS n FROM charging_sessions')).rows[0].n;
  if (existing > 0 && !REIMPORT) {
    console.log(`Dataset already loaded (${existing} sessions). Use "npm run setup -- --reimport" to load it again.`);
  } else {
    if (!fs.existsSync(CSV)) throw new Error('Cannot find ' + CSV);
    console.log('Reading CSV...');
    const recs = parse(fs.readFileSync(CSV, 'utf8'), { columns: true, skip_empty_lines: true, bom: true, trim: true });

    const vehicles = new Map(), sessions = [], stats = { badStart: 0, noEnd: 0, noTemp: 0, badId: 0 };
    for (const r of recs) {
      const m = /^SESSION_(\d+)$/.exec(r.SESSION_ID);
      const start = dt(r.START_TIME);
      if (!m || !start) { m ? stats.badStart++ : stats.badId++; continue; }
      const vn = normVehicle(r.VEHICLE_ID);
      if (!vehicles.has(vn)) vehicles.set(vn, [vn, r.VEHICLE_ID, r.MODEL, num(r.BATTERY_CAPACITY)]);
      const end = dt(r.END_TIME), pred = dt(r.PREDICTION_TIME);
      const volt = num(r.VOLTAGE), cur = num(r.CURRENT);
      const dur = end ? Math.round((end - start) / 60000) : null;
      if (!end) stats.noEnd++;
      if (num(r.MAX_TEMP) == null) stats.noTemp++;
      sessions.push([
        Number(m[1]), vn, r.CHARGING_STATION_ID, r.CHARGING_STATION_LOCATION, start, end, dur,
        num(r.BATTERY_TEMP), num(r.AVG_TEMP), num(r.MAX_TEMP), volt, cur,
        volt != null && cur != null ? Math.round(volt * cur / 100) / 10 : null,
        num(r.SOC), num(r.SOH), r.COOLANT_TYPE || null, num(r.COOLANT_FLOW_RATE), num(r.COOLANT_TEMP),
        r.PREDICTION_ID || null, pred, r.TWIN_ID || null
      ]);
    }
    console.log(`Parsed ${recs.length} rows: ${sessions.length} usable, ${vehicles.size} vehicles.`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (existing > 0) await client.query('DELETE FROM charging_sessions');
      await insertChunks(client, 'vehicles', ['vehicle_no', 'vehicle_id_original', 'model', 'battery_kwh'], [...vehicles.values()], 2000,
        'ON CONFLICT (vehicle_no) DO UPDATE SET vehicle_id_original=EXCLUDED.vehicle_id_original, model=EXCLUDED.model, battery_kwh=EXCLUDED.battery_kwh');
      await insertChunks(client, 'charging_sessions',
        ['id', 'vehicle_no', 'station_id', 'location', 'start_time', 'end_time', 'duration_min',
         'battery_temp_c', 'avg_temp_c', 'max_temp_c', 'voltage_v', 'current_a', 'power_kw', 'soc', 'soh',
         'coolant_type', 'coolant_flow_rate', 'coolant_temp_c', 'prediction_id', 'prediction_time', 'twin_id'],
        sessions, 1000);

      // Four example vehicles for the chips on the home page
      await client.query('UPDATE vehicles SET tag = NULL');
      const ok = 'battery_temp_c IS NOT NULL AND avg_temp_c IS NOT NULL AND max_temp_c IS NOT NULL AND power_kw IS NOT NULL AND soc IS NOT NULL';
      await client.query(`
        UPDATE vehicles v SET tag = t.tag FROM (
          (SELECT vehicle_no, 'Healthiest battery' AS tag FROM charging_sessions WHERE ${ok} ORDER BY soh DESC, id LIMIT 1)
          UNION ALL
          (SELECT vehicle_no, 'Lowest battery health' FROM charging_sessions WHERE ${ok} ORDER BY soh ASC, id LIMIT 1)
          UNION ALL
          (SELECT vehicle_no, 'Hottest charge' FROM charging_sessions WHERE ${ok} ORDER BY max_temp_c DESC, id LIMIT 1)
          UNION ALL
          (SELECT vehicle_no, 'Fastest charge' FROM charging_sessions WHERE ${ok} ORDER BY power_kw DESC, id LIMIT 1)
        ) t WHERE v.vehicle_no = t.vehicle_no`);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    console.log(`Loaded ${sessions.length} charging sessions.`);
    console.log(`Notes: ${stats.noEnd} sessions have no usable end time (the CSV has damaged values there), ${stats.noTemp} have no temperature readings.`);
    if (stats.badStart || stats.badId) console.log(`Skipped ${stats.badStart + stats.badId} rows with an unreadable start time or session id.`);
  }

  // Accounts behind the "Demo driver" / "Demo operator" buttons (their password cannot be used to sign in)
  for (const role of ['driver', 'operator']) {
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    await pool.query(
      `INSERT INTO users(username, email, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      ['Demo ' + role[0].toUpperCase() + role.slice(1), `demo.${role}@gmail.com`, hash, role]
    ).catch(() => {});
  }
  console.log('Database ready.');
  await pool.end();
})().catch(e => { console.error('Setup failed:', e.message); process.exit(1); });
