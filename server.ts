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

const getEnv = (name: string) => (process.env as any)[name];

// 1. Configuration
const PORT = Number(getEnv('PORT')) || 3000;
const JWT_SECRET = getEnv('JWT_SECRET') || "docugen-secret-key-2024";
const isProd = getEnv('NODE_ENV') === "production" || !!getEnv('RAILWAY_ENVIRONMENT');

console.log(`[BOOT] Mode: ${isProd ? 'Production' : 'Development'} | Port: ${PORT}`);
console.log(`[BOOT] CWD: ${process.cwd()}`);

const app = express();

// 2. Core Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// CORS & Security Headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Request Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.url.includes('health')) {
      console.log(`${new Date().toISOString()} | ${req.method} ${req.url} ${res.statusCode} - ${Date.now() - start}ms`);
    }
  });
  next();
});

// 3. Database Initialization
let db: any;
try {
  const dbPath = path.resolve(process.cwd(), "invoices.db");
  db = new Database(dbPath);
  db.exec(`
      CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, reset_token TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT DEFAULT 'payment_account', invoice_number TEXT, date TEXT, client_name TEXT, total REAL, data TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, is_default INTEGER DEFAULT 0, logo TEXT, signature TEXT, provider_name TEXT, provider_nit TEXT, provider_address TEXT, provider_phone TEXT, FOREIGN KEY(user_id) REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, nit TEXT, address TEXT, phone TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, name), FOREIGN KEY(user_id) REFERENCES users(id));
    `);
  const tables = ['invoices', 'settings', 'clients'];
  tables.forEach(t => { try { db.prepare(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER`).run(); } catch (e) { } });
  try { db.prepare("ALTER TABLE users ADD COLUMN reset_token TEXT").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE settings ADD COLUMN is_default INTEGER DEFAULT 0").run(); } catch (e) { }
  console.log(`[DB] Database connected and ready at ${dbPath}`);
} catch (err) {
  console.error('[DB] Critical Connection Error:', err);
}

// 4. Auth Utilities
const authenticateToken = (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.status(403).json({ error: "Forbidden" });
    req.user = user;
    next();
  });
};

const signupHandler = async (req: any, res: any) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const info = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, hashedPassword);
    const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET);
    res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ user: { id: info.lastInsertRowid, email } });
  } catch (error: any) {
    console.error('[AUTH] Signup error:', error);
    res.status(400).json({ error: error.message || "Signup failed" });
  }
};

// 5. API Routes
app.get("/v1/health", (req, res) => res.json({ status: "ok", mode: isProd ? "prod" : "dev", db: !!db }));

// Signup aliases for maximum 404/405 protection
app.post("/signup_prod", signupHandler);
app.post("/v1/auth/signup", signupHandler);

app.post("/v1/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: { id: user.id, email: user.email } });
});

app.post("/v1/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

app.get("/v1/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ user: null });
  jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
    if (err) return res.json({ user: null });
    res.json({ user });
  });
});

// App Data
app.get("/v1/settings", authenticateToken, (req: any, res) => {
  res.json(db.prepare("SELECT * FROM settings WHERE user_id = ? ORDER BY is_default DESC, id ASC").all(req.user.id));
});

app.post("/v1/settings", authenticateToken, (req: any, res) => {
  const { id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default } = req.body;
  if (is_default) db.prepare("UPDATE settings SET is_default = 0 WHERE user_id = ?").run(req.user.id);
  if (id) {
    db.prepare("UPDATE settings SET logo=?, signature=?, provider_name=?, provider_nit=?, provider_address=?, provider_phone=?, is_default=? WHERE id=? AND user_id=?")
      .run(logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT INTO settings(user_id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default) VALUES(?,?,?,?,?,?,?,?)")
      .run(req.user.id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  }
});

app.get("/v1/clients", authenticateToken, (req: any, res) => {
  res.json(db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id));
});

app.post("/v1/clients", authenticateToken, (req: any, res) => {
  const { id, name, nit, address, phone } = req.body;
  if (id) {
    db.prepare("UPDATE clients SET name=?, nit=?, address=?, phone=? WHERE id=? AND user_id=?").run(name, nit, address, phone, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT OR REPLACE INTO clients (user_id, name, nit, address, phone) VALUES (?, ?, ?, ?, ?)").run(req.user.id, name, nit, address, phone);
    res.json({ id: info.lastInsertRowid });
  }
});

app.post("/v1/invoices", authenticateToken, (req: any, res) => {
  const { id, type, invoiceNumber, date, acquiringCompany, grandTotal, data } = req.body;
  if (id) {
    db.prepare("UPDATE invoices SET type=?, invoice_number=?, date=?, client_name=?, total=?, data=? WHERE id=? AND user_id=?").run(type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT INTO invoices(user_id, type, invoice_number, date, client_name, total, data) VALUES(?,?,?,?,?,?,?)").run(req.user.id, type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data));
    res.json({ id: info.lastInsertRowid });
  }
});

app.get("/v1/invoices", authenticateToken, (req: any, res) => {
  const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json(invoices.map((inv: any) => ({ ...inv, data: JSON.parse(inv.data) })));
});

app.get("/v1/invoices/next-number/:type", authenticateToken, (req: any, res) => {
  const result = db.prepare("SELECT invoice_number FROM invoices WHERE type = ? AND user_id = ? ORDER BY CAST(invoice_number AS INTEGER) DESC LIMIT 1").get(req.params.type, req.user.id);
  const next = (result ? parseInt(result.invoice_number.replace(/\D/g, '')) || 0 : 0) + 1;
  res.json({ nextNumber: String(next).padStart(4, '0') });
});

// 6. Static Files & Universal Handler
const startup = async () => {
  if (isProd) {
    const distPath = path.resolve(process.cwd(), 'dist');
    console.log(`[BOOT] Serving static files from ${distPath}`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      if (req.url.startsWith('/v1/')) return res.status(404).json({ error: "API route not found" });
      const indexFile = path.resolve(distPath, 'index.html');
      if (fs.existsSync(indexFile)) res.sendFile(indexFile);
      else res.status(404).send("Application root not found (Build issue)");
    });
  } else {
    try {
      const { createServer: cvs } = await import('vite');
      const vite = await cvs({ server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
      console.log(`[BOOT] Vite development middleware active`);
    } catch (e) {
      console.error('[BOOT] Failed to load Vite:', e);
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[READY] Server operational on port ${PORT}`);
  });
};

startup();
