// server.ts
import express from "express";
import path from "path";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import cors from "cors";
import fs from "fs";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var isProd = !!process.env.PORT || process.env.NODE_ENV === "production";
var PORT = Number(process.env.PORT) || 3e3;
var JWT_SECRET = process.env.JWT_SECRET || "docugen-secret-key-2024";
var DATABASE_URL = process.env.DATABASE_URL;
if (isProd && !DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set in production!");
  process.exit(1);
}
var pool = new Pool({
  connectionString: DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/invoices",
  ssl: isProd ? { rejectUnauthorized: false } : false
});
var initDb = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE,
        password TEXT,
        reset_token TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        type TEXT DEFAULT 'payment_account',
        invoice_number TEXT,
        date TEXT,
        client_name TEXT,
        total NUMERIC,
        data TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_user FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        is_default INTEGER DEFAULT 0,
        logo TEXT,
        signature TEXT,
        provider_name TEXT,
        provider_nit TEXT,
        provider_address TEXT,
        provider_phone TEXT,
        footer_text TEXT,
        CONSTRAINT fk_user_settings FOREIGN KEY(user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        name TEXT,
        nit TEXT,
        address TEXT,
        phone TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, name),
        CONSTRAINT fk_user_clients FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);
    console.log("[DB] Tables initialized");
  } catch (err) {
    console.error("[DB] Init error:", err);
  } finally {
    client.release();
  }
};
initDb().then(async () => {
  try {
    await pool.query("ALTER TABLE settings ADD COLUMN IF NOT EXISTS footer_text TEXT");
    console.log("[DB] Migration: footer_text column ensured");
  } catch (e) {
  }
});
var app = express();
app.set("trust proxy", true);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`>> [REQ] ${req.method} ${req.url}`);
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`<< [RES] ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  next();
});
var asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
var authenticateToken = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Unauthorized", details: "No session found" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const userRes = await pool.query("SELECT id FROM users WHERE id = $1", [payload.id]);
    if (userRes.rowCount === 0) {
      res.clearCookie("token");
      return res.status(401).json({ error: "Unauthorized", details: "Session invalid (User not found)" });
    }
    req.user = payload;
    next();
  } catch (err) {
    return res.status(403).json({ error: "Forbidden", details: err.message });
  }
});
app.post("/api/auth/signup", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const hashedPassword = await bcrypt.hash(password, 10);
  const result = await pool.query("INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id", [email, hashedPassword]);
  const token = jwt.sign({ id: result.rows[0].id, email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1e3 });
  res.json({ user: { id: result.rows[0].id, email } });
}));
app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user || !await bcrypt.compare(password, user.password)) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
  res.cookie("token", token, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1e3 });
  res.json({ user: { id: user.id, email: user.email } });
}));
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ status: "success" });
});
app.get("/api/auth/me", asyncHandler(async (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.json({ user: null });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const result = await pool.query("SELECT id FROM users WHERE id = $1", [payload.id]);
    if (result.rowCount === 0) {
      res.clearCookie("token");
      return res.json({ user: null });
    }
    res.json({ user: payload });
  } catch (err) {
    res.json({ user: null });
  }
}));
app.post("/api/auth/forgot-password", asyncHandler(async (req, res) => {
  const { email } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: "User not found" });
  const resetToken = Math.random().toString(36).substring(7);
  await pool.query("UPDATE users SET reset_token = $1 WHERE id = $2", [resetToken, user.id]);
  res.json({ message: "Reset link ready", debug_token: resetToken });
}));
app.post("/api/auth/reset-password", asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE reset_token = $1", [token]);
  const user = result.rows[0];
  if (!user) return res.status(400).json({ error: "Invalid token" });
  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await pool.query("UPDATE users SET password = $1, reset_token = NULL WHERE id = $2", [hashedPassword, user.id]);
  res.json({ message: "Password reset successful" });
}));
app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.get("/api/settings", authenticateToken, asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM settings WHERE user_id = $1 ORDER BY is_default DESC, id ASC", [req.user.id]);
  res.json(result.rows);
}));
app.post("/api/settings", authenticateToken, asyncHandler(async (req, res) => {
  const { id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, footer_text, is_default } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (is_default) {
      await client.query("UPDATE settings SET is_default = 0 WHERE user_id = $1", [req.user.id]);
    }
    if (id) {
      await client.query(
        `UPDATE settings SET logo=$1, signature=$2, provider_name=$3, provider_nit=$4, provider_address=$5, provider_phone=$6, footer_text=$7, is_default=$8 WHERE id=$9 AND user_id=$10`,
        [logo, signature, provider_name, provider_nit, provider_address, provider_phone, footer_text || "", is_default ? 1 : 0, id, req.user.id]
      );
      await client.query("COMMIT");
      res.json({ id });
    } else {
      const result = await client.query(
        `INSERT INTO settings (user_id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, footer_text, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [req.user.id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, footer_text || "", is_default ? 1 : 0]
      );
      await client.query("COMMIT");
      res.json({ id: result.rows[0].id });
    }
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}));
app.delete("/api/settings/:id", authenticateToken, asyncHandler(async (req, res) => {
  await pool.query("DELETE FROM settings WHERE id = $1 AND user_id = $2", [req.params.id, req.user.id]);
  res.json({ status: "success" });
}));
app.get("/api/clients", authenticateToken, asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM clients WHERE user_id = $1 ORDER BY name ASC", [req.user.id]);
  res.json(result.rows);
}));
app.post("/api/clients", authenticateToken, asyncHandler(async (req, res) => {
  const { id, name, nit, address, phone } = req.body;
  if (id) {
    await pool.query(
      "UPDATE clients SET name = $1, nit = $2, address = $3, phone = $4 WHERE id = $5 AND user_id = $6",
      [name, nit, address, phone, id, req.user.id]
    );
    res.json({ id });
  } else {
    const result = await pool.query(
      "INSERT INTO clients (user_id, name, nit, address, phone) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, name) DO UPDATE SET nit = EXCLUDED.nit, address = EXCLUDED.address, phone = EXCLUDED.phone RETURNING id",
      [req.user.id, name, nit, address, phone]
    );
    res.json({ id: result.rows[0].id });
  }
}));
app.post("/api/invoices", authenticateToken, asyncHandler(async (req, res) => {
  const { id, type, invoiceNumber, date, acquiringCompany, grandTotal, data } = req.body;
  if (id) {
    await pool.query(
      `UPDATE invoices SET type = $1, invoice_number = $2, date = $3, client_name = $4, total = $5, data = $6 WHERE id = $7 AND user_id = $8`,
      [type || "payment_account", invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id]
    );
    res.json({ id });
  } else {
    const result = await pool.query(
      `INSERT INTO invoices (user_id, type, invoice_number, date, client_name, total, data) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, type || "payment_account", invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data)]
    );
    res.json({ id: result.rows[0].id });
  }
}));
app.get("/api/invoices/next-number/:type", authenticateToken, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT invoice_number FROM invoices WHERE type = $1 AND user_id = $2 ORDER BY CAST(REGEXP_REPLACE(invoice_number, '\\D', '', 'g') AS INTEGER) DESC LIMIT 1`,
    [req.params.type, req.user.id]
  );
  const lastNumber = result.rowCount ? parseInt(result.rows[0].invoice_number.replace(/\D/g, "")) : 0;
  res.json({ nextNumber: String(isNaN(lastNumber) ? 1 : lastNumber + 1).padStart(4, "0") });
}));
app.get("/api/invoices", authenticateToken, asyncHandler(async (req, res) => {
  const result = await pool.query("SELECT * FROM invoices WHERE user_id = $1 ORDER BY created_at DESC", [req.user.id]);
  res.json(result.rows.map((r) => ({ ...r, data: JSON.parse(r.data) })));
}));
if (isProd) {
  const dist = path.resolve(process.cwd(), "dist");
  console.log(`[STATIC] dist at ${dist}, exists: ${fs.existsSync(dist)}`);
  app.use(express.static(dist));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
    const idx = path.join(dist, "index.html");
    if (fs.existsSync(idx)) res.sendFile(idx);
    else res.status(503).send("Build missing");
  });
} else {
  import("vite").then(({ createServer }) => {
    createServer({ server: { middlewareMode: true }, appType: "spa" }).then((vite) => {
      app.use(vite.middlewares);
      console.log(`[BOOT] Vite middleware loaded`);
    }).catch((e) => console.error("[BOOT] Vite error", e));
  });
}
app.use((err, req, res, next) => {
  console.error("[ERROR]", err);
  res.status(500).json({ error: "Server Error", message: err.message });
});
var server = app.listen(PORT, "0.0.0.0", () => {
  const addr = server.address();
  console.log(`[READY] Server tightly bound to ${typeof addr === "string" ? addr : `${addr?.address}:${addr?.port} (Family: ${addr?.family})`}`);
});
