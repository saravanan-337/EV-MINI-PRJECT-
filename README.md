# CellScope + PostgreSQL

1. Create a database: `createdb cellscope`
2. `cp .env.example .env` and set `DATABASE_URL`
3. `npm install`
4. `npm run seed`   (creates tables and loads 200 vehicles / 4,000 sessions)
5. `npm start`  → open http://localhost:3000

Browsers can't talk to Postgres directly, so `server.js` exposes:
- `GET /api/vehicles`      – list for the demo chips
- `GET /api/vehicles/:no`  – one vehicle with sessions + forecast
- `GET /api/fleet`         – everything, for the Operator view

## Dataset
200 vehicles x 20 sessions across 10 stations. The four original demo vehicles
(MH01AB1234, MH02CD5678, MH03EF9012, MH04GH3456) are kept as the demo chips.
All 200 numbers appear as suggestions when you click the search box. Re-running
`npm run seed` wipes and reloads the tables.
