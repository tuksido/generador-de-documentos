import express from "express";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { fileURLToPath } from 'url';
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Railway sets PORT but NOT NODE_ENV. Detect production by PORT presence.
// Locally: PORT is not set  → isProd=false → dev mode (Vite middleware)
// Railway: PORT=8080 is set → isProd=true  → serve static dist/
const isProd = !!process.env.PORT || process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "docugen-secret-key-2024";

process.on('uncaughtException', err => console.error('[FATAL UNCAUGHT]', err));
process.on('unhandledRejection', err => console.error('[FATAL REJECTION]', err));

console.log(`[BOOT] isProd=${isProd} PORT=${PORT}`);


const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use((req, res, next) => {
  console.log(`>> [REQ] ${req.method} ${req.url}`);
  const start = Date.now();
  res.on('finish', () => console.log(`<< [RES] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`));
  next();
});

// Database
let db: any;
try {
  db = new Database(path.resolve(process.cwd(), "invoices.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, reset_token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'payment_account', invoice_number TEXT, date TEXT, client_name TEXT, total REAL, data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, is_default INTEGER DEFAULT 0, logo TEXT, signature TEXT, provider_name TEXT, provider_nit TEXT, provider_address TEXT, provider_phone TEXT, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, nit TEXT, address TEXT, phone TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, name), FOREIGN KEY(user_id) REFERENCES users(id));
  `);

  // Migration: Ensure all columns exist (SQLite doesn't mind if we try and fail gracefully)
  const migrations = [
    { table: 'invoices', column: 'user_id', type: 'INTEGER' },
    { table: 'invoices', column: 'type', type: 'TEXT DEFAULT "payment_account"' },
    { table: 'invoices', column: 'invoice_number', type: 'TEXT' },
    { table: 'invoices', column: 'date', type: 'TEXT' },
    { table: 'invoices', column: 'client_name', type: 'TEXT' },
    { table: 'invoices', column: 'total', type: 'REAL' },
    { table: 'invoices', column: 'data', type: 'TEXT' },
    { table: 'settings', column: 'user_id', type: 'INTEGER' },
    { table: 'settings', column: 'is_default', type: 'INTEGER DEFAULT 0' },
    { table: 'settings', column: 'logo', type: 'TEXT' },
    { table: 'settings', column: 'signature', type: 'TEXT' },
    { table: 'clients', column: 'user_id', type: 'INTEGER' },
    { table: 'users', column: 'reset_token', type: 'TEXT' },
  ];

  migrations.forEach(m => {
    try {
      db.prepare(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.type}`).run();
    } catch (e) {
      // Ignore "duplicate column name" errors
    }
  });

  console.log('[DB] Ready');
} catch (err) { console.error('[DB] Error:', err); }

// Auth
const auth = (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  jwt.verify(token, JWT_SECRET, (err: any, payload: any) => {
    if (err) return res.status(403).json({ error: "Forbidden" });

    // Verify user still exists in DB (prevents foreign key errors on ephemeral DB start)
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(payload.id);
    if (!user) {
      res.clearCookie("token");
      return res.status(401).json({ error: "Sesión inválida - por favor inicia sesión de nuevo" });
    }

    req.user = payload;
    next();
  });
};

const signup = async (req: any, res: any) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  try {
    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, hash);
    const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET);
    res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ user: { id: info.lastInsertRowid, email } });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
};

// Async error wrapper
const asyncHandler = (fn: any) => (req: any, res: any, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Routes
app.get("/v1/health", (req, res) => res.json({ ok: true }));
app.post("/signup_prod", asyncHandler(signup));
app.post("/v1/auth/signup", asyncHandler(signup));

app.post("/v1/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: { id: user.id, email: user.email } });
}));

app.post("/v1/auth/logout", (req, res) => { res.clearCookie("token"); res.json({ ok: true }); });

app.get("/v1/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ user: null });
  jwt.verify(token, JWT_SECRET, (err: any, payload: any) => {
    if (err) return res.json({ user: null });
    const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(payload.id);
    if (!user) {
      res.clearCookie("token");
      return res.json({ user: null });
    }
    res.json({ user: payload });
  });
});

app.post("/v1/auth/forgot-password", (req, res) => {
  const { email } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "User not found" });
  const resetToken = Math.random().toString(36).substring(7);
  db.prepare("UPDATE users SET reset_token = ? WHERE id = ?").run(resetToken, user.id);
  res.json({ message: "Reset link sent", debug_token: resetToken });
});

app.post("/v1/auth/reset-password", asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
  if (!user) return res.status(400).json({ error: "Invalid token" });
  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password = ?, reset_token = NULL WHERE id = ?").run(hash, user.id);
  res.json({ ok: true });
}));

app.get("/v1/settings", auth, (req: any, res) => res.json(db.prepare("SELECT * FROM settings WHERE user_id = ? ORDER BY is_default DESC, id ASC").all(req.user.id)));

app.post("/v1/settings", auth, (req: any, res) => {
  const { id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default } = req.body;
  if (is_default) db.prepare("UPDATE settings SET is_default = 0 WHERE user_id = ?").run(req.user.id);
  if (id) {
    db.prepare("UPDATE settings SET logo=?,signature=?,provider_name=?,provider_nit=?,provider_address=?,provider_phone=?,is_default=? WHERE id=? AND user_id=?")
      .run(logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT INTO settings(user_id,logo,signature,provider_name,provider_nit,provider_address,provider_phone,is_default) VALUES(?,?,?,?,?,?,?,?)")
      .run(req.user.id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  }
});

app.delete("/v1/settings/:id", auth, (req: any, res) => {
  db.prepare("DELETE FROM settings WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get("/v1/clients", auth, (req: any, res) => res.json(db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id)));

app.post("/v1/clients", auth, (req: any, res) => {
  const { id, name, nit, address, phone } = req.body;
  if (id) {
    db.prepare("UPDATE clients SET name=?,nit=?,address=?,phone=? WHERE id=? AND user_id=?").run(name, nit, address, phone, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT OR REPLACE INTO clients (user_id,name,nit,address,phone) VALUES (?,?,?,?,?)").run(req.user.id, name, nit, address, phone);
    res.json({ id: info.lastInsertRowid });
  }
});

app.post("/v1/invoices", auth, (req: any, res) => {
  const { id, type, invoiceNumber, date, acquiringCompany, grandTotal, data } = req.body;
  if (id) {
    db.prepare("UPDATE invoices SET type=?,invoice_number=?,date=?,client_name=?,total=?,data=? WHERE id=? AND user_id=?")
      .run(type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT INTO invoices(user_id,type,invoice_number,date,client_name,total,data) VALUES(?,?,?,?,?,?,?)")
      .run(req.user.id, type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data));
    res.json({ id: info.lastInsertRowid });
  }
});

app.get("/v1/invoices", auth, (req: any, res) => {
  const rows = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json(rows.map((r: any) => ({ ...r, data: JSON.parse(r.data) })));
});

app.get("/v1/invoices/next-number/:type", auth, (req: any, res) => {
  const result = db.prepare("SELECT invoice_number FROM invoices WHERE type=? AND user_id=? ORDER BY CAST(invoice_number AS INTEGER) DESC LIMIT 1").get(req.params.type, req.user.id);
  const next = (result ? parseInt(result.invoice_number.replace(/\D/g, '')) || 0 : 0) + 1;
  res.json({ nextNumber: String(next).padStart(4, '0') });
});

// 8. Static Files (Production)
if (isProd) {
  const dist = path.resolve(process.cwd(), 'dist');
  console.log(`[STATIC] dist at ${dist}, exists: ${fs.existsSync(dist)}`);

  // Register static routes synchronously so they are ready the instant the port binds
  app.use(express.static(dist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/v1/')) return res.status(404).json({ error: 'Not found' });
    const idx = path.join(dist, 'index.html');
    if (fs.existsSync(idx)) {
      res.sendFile(idx);
    } else {
      res.status(503).send('Build missing');
    }
  });
}

// 9. Vite Dev Server (Development only)
if (!isProd) {
  import('vite').then(({ createServer }) => {
    createServer({ server: { middlewareMode: true }, appType: 'spa' })
      .then(vite => {
        app.use(vite.middlewares);
        console.log(`[BOOT] Vite middleware loaded`);
      })
      .catch(e => console.error('[BOOT] Vite error', e));
  });
}

// Global Error Handler needs to be registered LAST
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[ERROR]', err);
  res.status(500).json({
    error: "Server Error",
    message: err.message,
    code: err.code
  });
});

// 10. Start listening
const server = app.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log(`[READY] Server tightly bound to ${typeof addr === 'string' ? addr : `${addr?.address}:${addr?.port} (Family: ${addr?.family})`}`);
});

