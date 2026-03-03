import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { fileURLToPath } from 'url';

import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getEnv = (name: string) => {
  return (process.env as any)[name];
};

// Global Error Logging
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startServer() {
  const PORT = Number(getEnv('PORT')) || 3000;
  const JWT_SECRET = getEnv('JWT_SECRET') || "docugen-secret-key-2024";

  console.log('--- Server Startup Context ---');
  console.log('NODE_ENV:', getEnv('NODE_ENV'));
  console.log('PORT:', PORT);
  console.log('__dirname:', __dirname);

  const distPath = path.resolve(__dirname, 'dist');
  console.log('Static files path:', distPath);
  console.log('Dist exists:', fs.existsSync(distPath));

  let db: any;
  try {
    console.log('Connecting to database...');
    db = new Database("invoices.db");
    console.log('Database connected successfully.');
  } catch (err) {
    console.error('Failed to connect to database:', err);
    process.exit(1);
  }

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

  // Migration: Add user_id to tables if it doesn't exist
  try { db.prepare("ALTER TABLE invoices ADD COLUMN user_id INTEGER").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE settings ADD COLUMN user_id INTEGER").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE clients ADD COLUMN user_id INTEGER").run(); } catch (e) { }
  try { db.prepare("ALTER TABLE users ADD COLUMN reset_token TEXT").run(); } catch (e) { }

  // Migration: Add is_default to settings if it doesn't exist
  try {
    db.prepare("ALTER TABLE settings ADD COLUMN is_default INTEGER DEFAULT 0").run();
  } catch (e) {
    // Column already exists
  }

  const app = express();

  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());

  // Auth Middleware
  const authenticateToken = (req: any, res: any, next: any) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: "Unauthorized" });

    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.status(403).json({ error: "Forbidden" });
      req.user = user;
      next();
    });
  };

  // Auth Endpoints
  app.post("/api/auth/signup", async (req, res) => {
    const { email, password } = req.body;
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const stmt = db.prepare("INSERT INTO users (email, password) VALUES (?, ?)");
      const info = stmt.run(email, hashedPassword);
      const token = jwt.sign({ id: info.lastInsertRowid, email }, JWT_SECRET);
      res.cookie("token", token, { httpOnly: true, sameSite: 'lax' });
      res.json({ user: { id: info.lastInsertRowid, email } });
    } catch (error) {
      res.status(400).json({ error: "Email already exists" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET);
    res.cookie("token", token, { httpOnly: true, sameSite: 'lax' });
    res.json({ user: { id: user.id, email: user.email } });
  });

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie("token");
    res.json({ status: "success" });
  });

  app.get("/api/auth/me", (req, res) => {
    const token = req.cookies.token;
    if (!token) return res.json({ user: null });
    jwt.verify(token, JWT_SECRET, (err: any, user: any) => {
      if (err) return res.json({ user: null });
      res.json({ user });
    });
  });

  app.post("/api/auth/forgot-password", (req, res) => {
    const { email } = req.body;
    const user: any = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) return res.status(404).json({ error: "User not found" });

    // In a real app, send an email. Here we just return a mock token for demo.
    const resetToken = Math.random().toString(36).substring(7);
    db.prepare("UPDATE users SET reset_token = ? WHERE id = ?").run(resetToken, user.id);
    res.json({ message: "Reset link sent to email", debug_token: resetToken });
  });

  app.post("/api/auth/reset-password", async (req, res) => {
    const { token, newPassword } = req.body;
    const user: any = db.prepare("SELECT * FROM users WHERE reset_token = ?").get(token);
    if (!user) return res.status(400).json({ error: "Invalid or expired token" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare("UPDATE users SET password = ?, reset_token = NULL WHERE id = ?").run(hashedPassword, user.id);
    res.json({ message: "Password reset successful" });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  app.get("/api/ping", (req, res) => {
    res.json({
      pong: true,
      env: getEnv('NODE_ENV') || 'not set',
      port: PORT,
      db: db ? 'connected' : 'null'
    });
  });

  // Settings (Company Profiles) Endpoints
  app.get("/api/settings", authenticateToken, (req: any, res) => {
    try {
      const settings = db.prepare("SELECT * FROM settings WHERE user_id = ? ORDER BY is_default DESC, id ASC").all(req.user.id);
      res.json(settings);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  app.post("/api/settings", authenticateToken, (req: any, res) => {
    const { id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default } = req.body;
    try {
      if (is_default) {
        db.prepare("UPDATE settings SET is_default = 0 WHERE user_id = ?").run(req.user.id);
      }

      if (id) {
        const stmt = db.prepare(`
          UPDATE settings SET
  logo = ?, signature = ?, provider_name = ?, provider_nit = ?,
    provider_address = ?, provider_phone = ?, is_default = ?
      WHERE id = ? AND user_id = ?
        `);
        stmt.run(logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0, id, req.user.id);
        res.json({ id });
      } else {
        const stmt = db.prepare(`
          INSERT INTO settings(user_id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default)
  VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `);
        const info = stmt.run(req.user.id, logo, signature, provider_name, provider_nit, provider_address, provider_phone, is_default ? 1 : 0);
        res.json({ id: info.lastInsertRowid });
      }
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Failed to save settings" });
    }
  });

  app.delete("/api/settings/:id", authenticateToken, (req: any, res) => {
    try {
      db.prepare("DELETE FROM settings WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
      res.json({ status: "success" });
    } catch (error) {
      res.status(500).json({ error: "Failed to delete profile" });
    }
  });

  // Clients Endpoints
  app.get("/api/clients", authenticateToken, (req: any, res) => {
    try {
      const clients = db.prepare("SELECT * FROM clients WHERE user_id = ? ORDER BY name ASC").all(req.user.id);
      res.json(clients);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch clients" });
    }
  });

  app.post("/api/clients", authenticateToken, (req: any, res) => {
    const { id, name, nit, address, phone } = req.body;
    try {
      if (id) {
        db.prepare("UPDATE clients SET name = ?, nit = ?, address = ?, phone = ? WHERE id = ? AND user_id = ?")
          .run(name, nit, address, phone, id, req.user.id);
        res.json({ id });
      } else {
        const info = db.prepare("INSERT OR REPLACE INTO clients (user_id, name, nit, address, phone) VALUES (?, ?, ?, ?, ?)")
          .run(req.user.id, name, nit, address, phone);
        res.json({ id: info.lastInsertRowid });
      }
    } catch (error) {
      console.error("Error saving client:", error);
      res.status(500).json({ error: "Failed to save client" });
    }
  });

  app.post("/api/invoices", authenticateToken, (req: any, res) => {
    const { id, type, invoiceNumber, date, acquiringCompany, grandTotal, data } = req.body;
    try {
      if (id) {
        const stmt = db.prepare(`
          UPDATE invoices 
          SET type = ?, invoice_number = ?, date = ?, client_name = ?, total = ?, data = ?
    WHERE id = ? AND user_id = ?
      `);
        stmt.run(type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data), id, req.user.id);
        res.json({ id });
      } else {
        const stmt = db.prepare(`
          INSERT INTO invoices(user_id, type, invoice_number, date, client_name, total, data)
  VALUES(?, ?, ?, ?, ?, ?, ?)
    `);
        const info = stmt.run(req.user.id, type || 'payment_account', invoiceNumber, date, acquiringCompany, grandTotal, JSON.stringify(data));
        res.json({ id: info.lastInsertRowid });
      }
    } catch (error) {
      console.error("Error saving invoice:", error);
      res.status(500).json({ error: "Failed to save invoice" });
    }
  });

  app.get("/api/invoices/next-number/:type", authenticateToken, (req: any, res) => {
    const { type } = req.params;
    try {
      const result = db.prepare(`
        SELECT invoice_number 
        FROM invoices 
        WHERE type = ? AND user_id = ?
    ORDER BY CAST(invoice_number AS INTEGER) DESC 
        LIMIT 1
      `).get(type, req.user.id);

      const lastNumber = result ? parseInt(result.invoice_number.replace(/\D/g, '')) : 0;
      const nextNumber = (isNaN(lastNumber) ? 0 : lastNumber) + 1;
      res.json({ nextNumber: String(nextNumber).padStart(4, '0') });
    } catch (error) {
      console.error("Error fetching next number:", error);
      res.status(500).json({ error: "Failed to fetch next number" });
    }
  });

  app.get("/api/invoices", authenticateToken, (req: any, res) => {
    try {
      const invoices = db.prepare("SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
      res.json(invoices.map((inv: any) => ({
        ...inv,
        data: JSON.parse(inv.data)
      })));
    } catch (error) {
      console.error("Error fetching invoices:", error);
      res.status(500).json({ error: "Failed to fetch invoices" });
    }
  });

  // Vite middleware for development (only if EXPLICITLY development)
  const isProd = getEnv('NODE_ENV') === "production" || getEnv('NODE_ENV') === undefined;

  if (!isProd) {
    console.log('Starting Vite development server...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log('Starting in Production mode...');
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      const p = path.resolve(__dirname, 'dist', 'index.html');
      if (fs.existsSync(p)) {
        res.sendFile(p);
      } else {
        res.status(404).send('Static files not found. Ensure "npm run build" was executed.');
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
