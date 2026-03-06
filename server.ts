import express from "express";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import fs from "fs";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Railway sets PORT but NOT NODE_ENV. Detect production by PORT presence.
const isProd = !!process.env.PORT || process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "docugen-secret-key-2024";

const db = new Database(path.resolve(process.cwd(), "invoices.db"));

// Initialize database
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    reset_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT DEFAULT 'payment_account',
    invoice_number TEXT,
    date TEXT,
    client_name TEXT,
    total REAL,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    is_default INTEGER DEFAULT 0,
    logo TEXT,
    signature TEXT,
    provider_name TEXT,
    provider_nit TEXT,
    provider_address TEXT,
    provider_phone TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    nit TEXT,
    address TEXT,
    phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, name),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

// Migration helper
const addColumnIfNotExists = (table: string, column: string, type: string) => {
  try {
    const info = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!info.find(c => c.name === column)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
      console.log(`[DB] Added column ${column} to ${table}`);
    }
  } catch (e) {
    // Ignore "duplicate column name"
  }
};

// Run migrations
addColumnIfNotExists('users', 'reset_token', 'TEXT');
addColumnIfNotExists('invoices', 'user_id', 'INTEGER');
addColumnIfNotExists('settings', 'user_id', 'INTEGER');
addColumnIfNotExists('settings', 'is_default', 'INTEGER DEFAULT 0');
addColumnIfNotExists('settings', 'logo', 'TEXT');
addColumnIfNotExists('settings', 'signature', 'TEXT');
addColumnIfNotExists('settings', 'provider_name', 'TEXT');
addColumnIfNotExists('settings', 'provider_nit', 'TEXT');
addColumnIfNotExists('settings', 'provider_address', 'TEXT');
addColumnIfNotExists('settings', 'provider_phone', 'TEXT');
addColumnIfNotExists('clients', 'user_id', 'INTEGER');

try {
  db.prepare("UPDATE settings SET is_default = 0 WHERE is_default IS NULL").run();
  db.prepare("UPDATE invoices SET type = 'payment_account' WHERE type IS NULL").run();

  // Data migration: Assign orphan records to the first user (ID 1)
  const firstUser = db.prepare("SELECT id FROM users ORDER BY id ASC LIMIT 1").get() as { id: number } | undefined;
  if (firstUser) {
    db.prepare("UPDATE settings SET user_id = ? WHERE user_id IS NULL").run(firstUser.id);
    db.prepare("UPDATE clients SET user_id = ? WHERE user_id IS NULL").run(firstUser.id);
    db.prepare("UPDATE invoices SET user_id = ? WHERE user_id IS NULL").run(firstUser.id);
  }

  // Migration: Populate total from data.grandTotal if column is missing/empty
  const rowsToFix = db.prepare("SELECT id, data FROM invoices WHERE total IS NULL OR total = 0").all() as any[];
  if (rowsToFix.length > 0) {
    const updateStmt = db.prepare("UPDATE invoices SET total = ? WHERE id = ?");
    const transaction = db.transaction((rows) => {
      for (const row of rows) {
        try {
          const data = JSON.parse(row.data);
          const grandTotal = Number(data.grandTotal || 0);
          if (grandTotal > 0) {
            updateStmt.run(grandTotal, row.id);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    });
    transaction(rowsToFix);
    console.log(`[DB] Migrated totals for ${rowsToFix.length} invoices`);
  }
} catch (e) { console.error("[DB] Migration error:", e); }

console.log('[DB] Ready');

const app = express();
app.set('trust proxy', true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`>> [REQ] ${req.method} ${req.url}`);
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`<< [RES] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Async error wrapper
const asyncHandler = (fn: any) => (req: any, res: any, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Auth Middleware
const authenticateToken = (req: any, res: any, next: any) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Unauthorized", details: "No session found" });

  jwt.verify(token, JWT_SECRET, (err: any, payload: any) => {
    if (err) return res.status(403).json({ error: "Forbidden", details: err.message });

    // Verify user still exists (Railway ephemeral DB check)
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(payload.id);
    if (!user) {
      res.clearCookie("token");
      return res.status(401).json({ error: "Unauthorized", details: "Session invalid (DB reset)" });
    }

    req.user = payload;
    next();
  });
};

// Auth Endpoints
app.post("/api/auth/signup", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const hashedPassword = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, hashedPassword);
  const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: { id: info.lastInsertRowid, email } });
}));

// Fallback for production signup script if needed
app.post("/signup_prod", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  const info = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)").run(email, hashedPassword);
  const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: { id: info.lastInsertRowid, email } });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
  res.json({ user: { id: user.id, email: user.email } });
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ status: "success" });
});

app.get("/api/auth/me", (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ user: null });
  jwt.verify(token, JWT_SECRET, (err: any, payload: any) => {
    if (err) return res.json({ user: null });
    const user = db.prepare("SELECT id FROM users WHERE id = ?").get(payload.id);
    if (!user) {
      res.clearCookie("token");
      return res.json({ user: null });
    }
    res.json({ user: payload });
  });
});

app.post("/api/auth/forgot-password", (req, res) => {
  const { email } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "User not found" });
  const resetToken = Math.random().toString(36).substring(7);
  db.prepare("UPDATE users SET reset_token = ? WHERE id = ?").run(resetToken, user.id);
  res.json({ message: "Reset link ready", debug_token: resetToken });
});

app.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const user: any = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
  if (!user) return res.status(400).json({ error: "Invalid token" });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password = ?, reset_token = NULL WHERE id = ?").run(hashedPassword, user.id);
  res.json({ message: "Password reset successful" });
}));

// API routes
app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get("/v1/health", (req, res) => res.json({ status: "ok" }));

app.get("/api/settings", authenticateToken, (req: any, res) => {
  res.json(db.prepare("SELECT * FROM settings WHERE user_id = ? ORDER BY is_default DESC, id ASC").all(req.user.id));
});

app.post("/api/settings", authenticateToken, (req: any, res) => {
  const { id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default } = req.body;
  if (is_default) db.prepare("UPDATE settings SET is_default = 0 WHERE user_id = ?").run(req.user.id);
  if (id) {
    db.prepare(`UPDATE settings SET logo=?, signature=?, provider_name=?, provider_nit=?, provider_address=?, provider_phone=?, is_default=? WHERE id=? AND user_id=?`)
      .run(logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare(`INSERT INTO settings (user_id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0);
    res.json({ id: info.lastInsertRowid });
  }
});

app.delete("/api/settings/:id", authenticateToken, (req: any, res) => {
  db.prepare("DELETE FROM settings WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ status: "success" });
});

app.get("/api/clients", authenticateToken, (req: any, res) => {
  res.json(db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id));
});

app.post("/api/clients", authenticateToken, (req: any, res) => {
  const { id, name, nit, address, phone } = req.body;
  if (id) {
    db.prepare("UPDATE clients SET name = ?, nit = ?, address = ?, phone = ? WHERE id = ? AND user_id = ?")
      .run(name, nit, address, phone, id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare("INSERT OR REPLACE INTO clients (user_id, name, nit, address, phone) VALUES (?, ?, ?, ?, ?)")
      .run(req.user.id, name, nit, address, phone);
    res.json({ id: info.lastInsertRowid });
  }
});

app.post("/api/invoices", authenticateToken, (req: any, res) => {
  const { id, type, invoiceNumber, date, acquiringCompany, grandTotal, data } = req.body;
  if (id) {
    db.prepare(`UPDATE invoices SET type = ?, invoice_number = ?, date = ?, client_name = ?, total = ?, data = ? WHERE id = ? AND user_id = ?`)
      .run(type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id);
    res.json({ id });
  } else {
    const info = db.prepare(`INSERT INTO invoices (user_id, type, invoice_number, date, client_name, total, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data));
    res.json({ id: info.lastInsertRowid });
  }
});

app.get("/api/invoices/next-number/:type", authenticateToken, (req: any, res) => {
  const result = db.prepare(`SELECT invoice_number FROM invoices WHERE type = ? AND user_id = ? ORDER BY CAST(invoice_number AS INTEGER) DESC LIMIT 1`).get(req.params.type, req.user.id);
  const lastNumber = result ? parseInt(result.invoice_number.replace(/\D/g, '')) : 0;
  res.json({ nextNumber: String(isNaN(lastNumber) ? 1 : lastNumber + 1).padStart(4, '0') });
});

app.get("/api/invoices", authenticateToken, (req: any, res) => {
  const rows = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json(rows.map((r: any) => ({ ...r, data: JSON.parse(r.data) })));
});

// Dynamic Vite or Static Dist
if (isProd) {
  const dist = path.resolve(process.cwd(), 'dist');
  console.log(`[STATIC] dist at ${dist}, exists: ${fs.existsSync(dist)}`);
  app.use(express.static(dist));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    const idx = path.join(dist, 'index.html');
    if (fs.existsSync(idx)) res.sendFile(idx);
    else res.status(503).send('Build missing');
  });
} else {
  import('vite').then(({ createServer }) => {
    createServer({ server: { middlewareMode: true }, appType: 'spa' })
      .then(vite => {
        app.use(vite.middlewares);
        console.log(`[BOOT] Vite middleware loaded`);
      })
      .catch(e => console.error('[BOOT] Vite error', e));
  });
}

// Global Error Handler
app.use((err: any, req: any, res: any, next: any) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: "Server Error", message: err.message });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log(`[READY] Server tightly bound to ${typeof addr === 'string' ? addr : `${addr?.address}:${addr?.port} (Family: ${addr?.family})`}`);
});
