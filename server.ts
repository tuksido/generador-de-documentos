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

// 1. Configuration - Use NODE_ENV for reliable production detection
const isProd = getEnv('NODE_ENV') === "production";
// In dev, Express uses port 3001 (Vite uses 5173 and proxies to 3001)
// In production, Railway provides PORT env var
const PORT = isProd
  ? (Number(getEnv('PORT')) || 3000)
  : 3001;
const JWT_SECRET = getEnv('JWT_SECRET') || "docugen-secret-key-2024";

console.log(`[BOOT] Mode: ${isProd ? 'Production' : 'Development'} | Port: ${PORT}`);

const app = express();

// 2. Core Middleware
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// CORS
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
      console.log(`${req.method} ${req.url} ${res.statusCode} - ${Date.now() - start}ms`);
    }
  });
  next();
});

// 3. Database
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
  ['invoices', 'settings', 'clients'].forEach(t => { try { db.prepare(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER`).run(); } catch (e) { } });
  try { db.prepare("ALTER TABLE users ADD COLUMN reset_token TEXT").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE settings ADD COLUMN is_default INTEGER DEFAULT 0").run(); } catch (e) { }
  console.log(`[DB] Ready at ${dbPath}`);
} catch (err) {
  console.error('[DB] Error:', err);
}

// 4. Auth
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
    res.status(400).json({ error: error.message || "Signup failed" });
  }
};

// 5. Routes
app.get("/v1/health", (req, res) => res.json({ status: "ok", mode: isProd ? "prod" : "dev", db: !!db }));

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

app.post("/v1/auth/forgot-password", (req, res) => {
  const { email } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "User not found" });
  const resetToken = Math.random().toString(36).substring(7);
  db.prepare("UPDATE users SET reset_token = ? WHERE id = ?").run(resetToken, user.id);
  res.json({ message: "Reset link sent to email", debug_token: resetToken });
});

app.post("/v1/auth/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
  if (!user) return res.status(400).json({ error: "Invalid or expired token" });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password = ?, reset_token = NULL WHERE id = ?").run(hashedPassword, user.id);
  res.json({ message: "Password reset successful" });
});

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

app.delete("/v1/settings/:id", authenticateToken, (req: any, res) => {
  db.prepare("DELETE FROM settings WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ status: "success" });
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
    db.prepare("UPDATE invoices SET type=?, invoice_number=?, date=?, client_name=?, total=?, data=? WHERE id=? AND user_id=?")
      .run(type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT INTO invoices(user_id, type, invoice_number, date, client_name, total, data) VALUES(?,?,?,?,?,?,?)")
      .run(req.user.id, type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data));
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

// 6. Shutdown any API requests that don't match
app.all("/v1/*", (req, res) => {
  res.status(404).json({ error: "API endpoint not found", path: req.url });
});

// 7. Static Files (Production) or Vite (Development)
async function setupFrontend() {
  if (isProd) {
    // In production: serve the pre-built React app
    const distPath = path.resolve(process.cwd(), 'dist');
    console.log(`[BOOT] Serving static from: ${distPath} (exists: ${fs.existsSync(distPath)})`);
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexFile = path.resolve(distPath, 'index.html');
      if (fs.existsSync(indexFile)) res.sendFile(indexFile);
      else res.status(404).send("Build not found. Ensure 'npm run build' ran successfully.");
    });
  } else {
    // In development: load Vite dynamically
    try {
      const { createServer: cvs } = await import('vite');
      const vite = await cvs({ server: { middlewareMode: true }, appType: "spa" });
      app.use(vite.middlewares);
      console.log(`[BOOT] Vite middleware loaded`);
    } catch (e) {
      console.error('[BOOT] Vite error:', e);
    }
  }
}

setupFrontend().then(() => {
  // Global Error Handler
  app.use((err: any, req: any, res: any, next: any) => {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: "Server Error", message: err.message });
  });
});

// 8. Start listening
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[READY] Listening on port ${PORT}`);
});
