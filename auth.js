// Login system: accounts + login history stored in PostgreSQL. No extra npm packages needed.
const crypto = require("crypto");

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const COOKIE = "cs_session";
const TTL_MS = 8 * 60 * 60 * 1000; // stay logged in for 8 hours
const MAX_FAILS = 5;               // failed logins allowed per email in 15 minutes

const AUTH_SQL = `
CREATE TABLE IF NOT EXISTS app_user (
  user_id       serial PRIMARY KEY,
  full_name     text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE TABLE IF NOT EXISTS login_log (
  log_id         bigserial PRIMARY KEY,
  user_id        int REFERENCES app_user(user_id) ON DELETE SET NULL,
  email_tried    text NOT NULL,
  success        boolean NOT NULL,
  failure_reason text,
  ip_address     text,
  user_agent     text,
  logged_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_log_email_time ON login_log (email_tried, logged_at);
CREATE OR REPLACE VIEW v_login_history AS
SELECT l.log_id, l.logged_at, u.full_name, l.email_tried AS email, u.role,
       l.success, l.failure_reason, l.ip_address, l.user_agent
FROM login_log l LEFT JOIN app_user u USING (user_id)
ORDER BY l.logged_at DESC;
`;

// ---- password hashing (scrypt, built into Node) ----
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, (e, k) => (e ? rej(e) : res(k))));
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scrypt(pw, salt)).toString("hex")}`;
}
async function verifyPassword(pw, stored) {
  const [alg, s, h] = String(stored).split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const k = await scrypt(pw, Buffer.from(s, "hex")), e = Buffer.from(h, "hex");
  return k.length === e.length && crypto.timingSafeEqual(k, e);
}
let DUMMY; // used so unknown emails take as long as real ones

// ---- signed session cookie ----
const sign = p => crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
const makeToken = id => { const p = `${id}.${Date.now() + TTL_MS}`; return `${p}.${sign(p)}`; };
function readToken(t) {
  if (!t) return null;
  const i = t.lastIndexOf("."); if (i < 0) return null;
  const p = t.slice(0, i), s = Buffer.from(t.slice(i + 1)), e = Buffer.from(sign(p));
  if (s.length !== e.length || !crypto.timingSafeEqual(s, e)) return null;
  const [id, exp] = p.split(".");
  return +exp > Date.now() ? +id : null;
}
const cookies = req => Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split(/=(.*)/s).slice(0, 2)).filter(x => x[0]));
const setCookie = (res, v, maxAge) =>
  res.setHeader("Set-Cookie", `${COOKIE}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clientIp = req => String(req.ip || "").replace("::ffff:", "");

function setupAuth(app, pool) {
  const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: "Server error" }); });
  const log = (uid, email, ok, reason, req) => pool.query(
    "INSERT INTO login_log (user_id,email_tried,success,failure_reason,ip_address,user_agent) VALUES ($1,$2,$3,$4,$5,$6)",
    [uid, email.slice(0, 200), ok, reason, clientIp(req), (req.get("user-agent") || "").slice(0, 300)]);

  // Attach req.user from the session cookie on every request
  app.use(wrap(async (req, _res, next) => {
    const id = readToken(cookies(req)[COOKIE]);
    req.user = null;
    if (id) req.user = (await pool.query("SELECT user_id, full_name, email, role FROM app_user WHERE user_id=$1", [id])).rows[0] || null;
    next();
  }));

  app.post("/api/auth/register", wrap(async (req, res) => {
    const name = String(req.body.name || "").trim(), email = String(req.body.email || "").trim().toLowerCase(), pw = String(req.body.password || "");
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Please enter your name." });
    if (!EMAIL_RE.test(email) || email.length > 200) return res.status(400).json({ error: "Please enter a valid email address." });
    if (pw.length < 8 || pw.length > 200) return res.status(400).json({ error: "Password must be at least 8 characters." });
    const hash = await hashPassword(pw);
    let u;
    try {
      u = (await pool.query("INSERT INTO app_user (full_name,email,password_hash,last_login_at) VALUES ($1,$2,$3,now()) RETURNING user_id", [name, email, hash])).rows[0];
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "An account with this email already exists. Try logging in." });
      throw e;
    }
    await log(u.user_id, email, true, null, req);
    setCookie(res, makeToken(u.user_id), TTL_MS / 1000);
    res.json({ ok: true });
  }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase(), pw = String(req.body.password || "");
    if (!email || !pw) return res.status(400).json({ error: "Enter your email and password." });
    const fails = (await pool.query(
      "SELECT count(*)::int AS n FROM login_log WHERE email_tried=$1 AND success=false AND failure_reason<>'locked' AND logged_at > now() - interval '15 minutes'", [email])).rows[0].n;
    if (fails >= MAX_FAILS) {
      await log(null, email, false, "locked", req);
      return res.status(429).json({ error: "Too many failed attempts. Try again in 15 minutes." });
    }
    const u = (await pool.query("SELECT * FROM app_user WHERE email=$1", [email])).rows[0];
    DUMMY = DUMMY || await hashPassword("dummy-password");
    const ok = await verifyPassword(pw, u ? u.password_hash : DUMMY);
    if (!u || !ok) {
      await log(u ? u.user_id : null, email, false, u ? "wrong_password" : "unknown_email", req);
      return res.status(401).json({ error: "Incorrect email or password." });
    }
    await pool.query("UPDATE app_user SET last_login_at=now() WHERE user_id=$1", [u.user_id]);
    await log(u.user_id, email, true, null, req);
    setCookie(res, makeToken(u.user_id), TTL_MS / 1000);
    res.json({ ok: true });
  }));

  app.post("/api/auth/logout", (_req, res) => { setCookie(res, "", 0); res.json({ ok: true }); });
  app.get("/api/auth/me", (req, res) => res.json(req.user ? { name: req.user.full_name, email: req.user.email, role: req.user.role } : null));

  // Everything else under /api needs a logged-in user
  app.use("/api", (req, res, next) =>
    req.path.startsWith("/auth/") || req.user ? next() : res.status(401).json({ error: "Please log in." }));
}

const requireAdmin = (req, res, next) =>
  req.user && req.user.role === "admin" ? next() : res.status(403).json({ error: "Operator access only." });

async function initAuth(pool) {
  await pool.query(AUTH_SQL);
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase(), pw = process.env.ADMIN_PASSWORD || "";
  if (email && pw) {
    const ex = await pool.query("SELECT 1 FROM app_user WHERE email=$1", [email]);
    if (ex.rowCount) await pool.query("UPDATE app_user SET role='admin' WHERE email=$1", [email]);
    else await pool.query("INSERT INTO app_user (full_name,email,password_hash,role) VALUES ('Administrator',$1,$2,'admin')", [email, await hashPassword(pw)]);
  }
}

module.exports = { setupAuth, requireAdmin, initAuth, hashPassword, verifyPassword, makeToken, readToken };
