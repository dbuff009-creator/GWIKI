const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");
const express = require("express");
const { createClient } = require("@libsql/client");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

// ── Uploads setup ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "") || ".bin";
    cb(null, crypto.randomBytes(12).toString("hex") + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(jpeg|png|gif|webp)$/;
    cb(null, allowed.test(file.mimetype));
  },
});

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createClient({
  url: process.env.TURSO_URL || "file:../data/app.db",
  authToken: process.env.TURSO_TOKEN,
});

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "oimp.gorb@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "al350350";
const ADMIN_NICK = process.env.ADMIN_NICK || "D3buff";
const GOOGLE_DOC_ID = process.env.GOOGLE_DOC_ID || "1ubaGZdPkVz9zSuMgEl8TK8vH9ftt85Zz4pnVa-Faj0c";
const DEV_BLOG_SECRET = process.env.DEV_BLOG_SECRET || "change-me-in-production";

const ROLES = ["owner", "admin", "moderator", "postmaker", "user"];
let pravilaCache = { html: "", fetchedAt: 0 };
const PRAVILA_CACHE_MS = 5 * 60 * 1000;

async function initDb() {
  await db.executeMultiple(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(thread_id) REFERENCES threads(id),
  FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS dev_blog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'api'
);
CREATE TABLE IF NOT EXISTS wiki_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(created_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wiki_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image_url TEXT NOT NULL DEFAULT '',
  author_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(category_id) REFERENCES wiki_categories(id),
  FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wiki_article_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(article_id) REFERENCES wiki_articles(id),
  FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS deleted_emails (
  email TEXT PRIMARY KEY,
  deleted_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_bans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE,
  banned_by INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  banned_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(banned_by) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS wiki_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('article','category')),
  target_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, target_type, target_id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS user_awards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  awarded_by INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(awarded_by) REFERENCES users(id)
);
`);

  await ensureColumn("threads", "tags", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("threads", "updated_at", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "bio", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("users", "avatar_url", "TEXT NOT NULL DEFAULT ''");
  await ensureColumn("users", "role", "TEXT NOT NULL DEFAULT 'user'");
  await ensureColumn("users", "consent_at", "INTEGER NOT NULL DEFAULT 0");
  await ensureColumn("users", "is_banned", "INTEGER NOT NULL DEFAULT 0");

  await seedMainAdmin();
  await migrateUserRoles();
}

async function migrateUserRoles() {
  await db.execute({ sql: "UPDATE users SET email = ? WHERE email = 'oimg.gorb@gmail.com'", args: [ADMIN_EMAIL] });
  await db.execute({ sql: "UPDATE users SET role = 'owner', is_admin = 1 WHERE email = ?", args: [ADMIN_EMAIL] });
  await db.execute({ sql: "UPDATE users SET role = 'admin' WHERE is_admin = 1 AND email != ?", args: [ADMIN_EMAIL] });
  await db.execute({ sql: "UPDATE users SET role = 'user' WHERE role IN ('commenter', 'viewer', 'editor')", args: [] });
}

function rolePermissions(role) {
  const r = ROLES.includes(role) ? role : "user";
  return {
    role: r,
    canManageUsers:    r === "owner" || r === "admin",
    canCreateThreads:  r === "owner" || r === "admin" || r === "moderator" || r === "postmaker",
    canComment:        true,
    canDeleteComments: r === "owner" || r === "admin" || r === "moderator",
    isPostmaker:       r === "postmaker",
  };
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "48kb" }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);
app.use(express.static(path.join(__dirname, "..")));
app.use("/wiki-app/uploads", express.static(UPLOADS_DIR));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/wiki/directory", async (_req, res) => {
  try {
    const users = (await db.execute({ sql: "SELECT id, nickname FROM users ORDER BY nickname LIMIT 300", args: [] })).rows;
    res.json({ users });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/pravila-content", async (_req, res) => {
  try {
    const now = Date.now();
    if (pravilaCache.html && now - pravilaCache.fetchedAt < PRAVILA_CACHE_MS) {
      return res.json({ html: pravilaCache.html, cached: true, updatedAt: pravilaCache.fetchedAt });
    }
    const url = `https://docs.google.com/document/d/${GOOGLE_DOC_ID}/export?format=html`;
    const html = await fetchHttpsText(url);
    const cleaned = stripDangerousHtml(html);
    pravilaCache = { html: cleaned, fetchedAt: now };
    res.json({ html: cleaned, cached: false, updatedAt: now });
  } catch (e) {
    console.error("pravila fetch:", e.message);
    if (pravilaCache.html) {
      return res.json({ html: pravilaCache.html, cached: true, stale: true, updatedAt: pravilaCache.fetchedAt });
    }
    res.status(502).json({ error: "pravila_unavailable", message: "Не удалось загрузить документ" });
  }
});

app.get("/api/dev-blog", async (_req, res) => {
  try {
    const rows = (await db.execute({ sql: "SELECT id, body, created_at, source FROM dev_blog ORDER BY created_at DESC LIMIT 80", args: [] })).rows;
    res.json({ posts: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/dev-blog", rateLimit({ windowMs: 60 * 1000, limit: 30 }), async (req, res) => {
  try {
    const secret = String(req.headers["x-dev-blog-secret"] || req.body?.secret || "");
    if (secret !== DEV_BLOG_SECRET) return res.status(401).json({ error: "invalid secret" });
    const body = safeText(req.body?.body, 8000);
    if (!body) return res.status(400).json({ error: "body required" });
    const source = safeText(req.body?.source, 40) || "discord";
    const now = Date.now();
    const result = await db.execute({ sql: "INSERT INTO dev_blog (body, created_at, source) VALUES (?, ?, ?)", args: [body, now, source] });
    res.json({ ok: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    if (req.body?.consent !== true) return res.status(400).json({ error: "consent_required" });
    if (req.body?.website || req.body?.phone) return res.status(400).json({ error: "invalid payload" });

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    const nickname = normalizeNick(req.body?.nickname);
    if (!email || !password || !nickname) return res.status(400).json({ error: "invalid payload" });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: "invalid password length" });

    const deleted = (await db.execute({ sql: "SELECT deleted_at FROM deleted_emails WHERE email = ?", args: [email] })).rows[0];
    if (deleted) {
      const daysLeft = Math.ceil((deleted.deleted_at + 14 * 24 * 3600 * 1000 - Date.now()) / (24 * 3600 * 1000));
      if (daysLeft > 0) {
        return res.status(409).json({ error: "email_blocked", message: `Этот email заблокирован ещё на ${daysLeft} дн.` });
      }
      await db.execute({ sql: "DELETE FROM deleted_emails WHERE email = ?", args: [email] });
    }

    const exists = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
    if (exists) return res.status(409).json({ error: "email already exists" });

    const hash = bcrypt.hashSync(password, 11);
    const now = Date.now();
    const result = await db.execute({
      sql: "INSERT INTO users (email, password_hash, nickname, is_admin, role, consent_at, created_at) VALUES (?, ?, ?, 0, 'user', ?, ?)",
      args: [email, hash, nickname, now, now],
    });
    const token = await createSession(result.lastInsertRowid);
    const user = await getUserById(result.lastInsertRowid);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "invalid payload" });

    const user = (await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] })).rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: "invalid credentials" });
    }
    if (user.is_banned) {
      const ban = (await db.execute({ sql: "SELECT reason FROM user_bans WHERE user_id = ?", args: [user.id] })).rows[0];
      return res.status(403).json({ error: "banned", message: "Аккаунт заблокирован" + (ban?.reason ? ": " + ban.reason : ".") });
    }
    const token = await createSession(user.id);
    res.json({ token, user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/logout", authOptional, async (req, res) => {
  try {
    const token = getBearerToken(req);
    if (token) await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [token] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.get("/api/users/:id/public", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
    const u = (await db.execute({ sql: "SELECT id, nickname, bio, avatar_url, created_at, role FROM users WHERE id = ?", args: [id] })).rows[0];
    if (!u) return res.status(404).json({ error: "not found" });
    const wikiArticles = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM wiki_articles WHERE author_id = ? AND status = 'approved'", args: [id] })).rows[0].n;
    const comments = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM wiki_article_comments WHERE author_id = ?", args: [id] })).rows[0].n;
    res.json({
      user: {
        id: u.id,
        nickname: u.nickname,
        bio: u.bio || "",
        avatarUrl: u.avatar_url || "",
        createdAt: u.created_at,
        roleLabel: publicRoleLabel(u.role),
        role: u.role,
        stats: { articles: wikiArticles, comments },
        canView: true,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/users/:id/articles", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
    const articles = (await db.execute({
      sql: `SELECT a.id, a.title, a.body, a.created_at, a.updated_at,
                   c.name AS category_name, c.slug AS category_slug
            FROM wiki_articles a
            JOIN wiki_categories c ON c.id = a.category_id
            WHERE a.author_id = ? AND a.status = 'approved'
            ORDER BY a.updated_at DESC
            LIMIT 50`,
      args: [id],
    })).rows;
    res.json({ articles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.patch("/api/profile", authRequired, async (req, res) => {
  try {
    const nickname = req.body?.nickname ? normalizeNick(req.body.nickname) : null;
    const password = req.body?.password ? String(req.body.password) : null;
    const bio = req.body?.bio !== undefined ? safeText(req.body.bio, 600) : null;
    const avatarUrl = req.body?.avatar_url !== undefined ? safeText(req.body.avatar_url, 500) : null;
    if (!nickname && !password && bio === null && avatarUrl === null) {
      return res.status(400).json({ error: "nothing to update" });
    }
    if (password && (password.length < 6 || password.length > 128)) {
      return res.status(400).json({ error: "invalid password length" });
    }
    if (nickname) await db.execute({ sql: "UPDATE users SET nickname = ? WHERE id = ?", args: [nickname, req.user.id] });
    if (password) await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [bcrypt.hashSync(password, 11), req.user.id] });
    if (bio !== null) await db.execute({ sql: "UPDATE users SET bio = ? WHERE id = ?", args: [bio, req.user.id] });
    if (avatarUrl !== null) await db.execute({ sql: "UPDATE users SET avatar_url = ? WHERE id = ?", args: [avatarUrl, req.user.id] });
    const user = await getUserById(req.user.id);
    res.json({ user: sanitizeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/wiki/threads", async (_req, res) => {
  try {
    const rows = (await db.execute({
      sql: `SELECT t.id, t.title, t.body, t.tags, t.created_at, t.updated_at, t.author_id,
                   u.nickname AS author_nickname
            FROM threads t
            JOIN users u ON u.id = t.author_id
            ORDER BY t.updated_at DESC`,
      args: [],
    })).rows;
    const threads = await Promise.all(rows.map(async (t) => ({
      ...t,
      tags: parseTags(t.tags),
      comments: await loadComments(t.id),
    })));
    res.json({ threads });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/threads", authRequired, requireCanCreateThreads, async (req, res) => {
  try {
    const title = safeText(req.body?.title, 150);
    const body = safeText(req.body?.body, 10000);
    const tags = normalizeTags(req.body?.tags);
    if (!title || !body) return res.status(400).json({ error: "title and body required" });
    const now = Date.now();
    const result = await db.execute({
      sql: "INSERT INTO threads (title, body, tags, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [title, body, tags.join(","), req.user.id, now, now],
    });
    const created = await loadThread(result.lastInsertRowid);
    res.json({ thread: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/threads/:id/comments", authRequired, requireCanComment, async (req, res) => {
  try {
    const threadId = Number(req.params.id);
    if (!Number.isInteger(threadId)) return res.status(400).json({ error: "invalid thread id" });
    const body = safeText(req.body?.body, 3000);
    if (!body) return res.status(400).json({ error: "comment body required" });
    const now = Date.now();
    const thread = (await db.execute({ sql: "SELECT id FROM threads WHERE id = ?", args: [threadId] })).rows[0];
    if (!thread) return res.status(404).json({ error: "thread not found" });
    await db.execute({ sql: "INSERT INTO comments (thread_id, body, author_id, created_at) VALUES (?, ?, ?, ?)", args: [threadId, body, req.user.id, now] });
    await db.execute({ sql: "UPDATE threads SET updated_at = ? WHERE id = ?", args: [now, threadId] });
    res.json({ comments: await loadComments(threadId) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/wiki/members", authRequired, requireManageUsers, async (_req, res) => {
  try {
    const rows = (await db.execute({ sql: "SELECT id, email, nickname, role, created_at FROM users ORDER BY email", args: [] })).rows;
    res.json({ members: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/members/role", authRequired, requireManageUsers, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const role = String(req.body?.role || "").toLowerCase();
    if (!email || !ROLES.includes(role)) return res.status(400).json({ error: "email and valid role required" });
    const target = (await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] })).rows[0];
    if (!target) return res.status(404).json({ error: "user not found" });
    const actor = await getUserById(req.user.id);
    if (role === "owner" && actor.role !== "owner") return res.status(403).json({ error: "only owner can assign owner" });
    if (role === "admin" && actor.role !== "owner") return res.status(403).json({ error: "only owner can assign admin" });
    if (target.role === "owner" && actor.role !== "owner") return res.status(403).json({ error: "only owner can change owner" });
    const isAdm = role === "admin" || role === "owner" ? 1 : 0;
    await db.execute({ sql: "UPDATE users SET is_admin = ?, role = ? WHERE id = ?", args: [isAdm, role, target.id] });
    const updated = await getUserById(target.id);
    res.json({ user: sanitizeUser(updated) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/admins", authRequired, requireManageUsers, async (_req, res) => {
  try {
    const admins = (await db.execute({ sql: "SELECT id, email, nickname, role, created_at FROM users WHERE role IN ('owner','admin') ORDER BY email", args: [] })).rows;
    res.json({ admins });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/admins", authRequired, requireManageUsers, async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: "email required" });
    const user = (await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [email] })).rows[0];
    if (!user) return res.status(404).json({ error: "user not found" });
    await db.execute({ sql: "UPDATE users SET is_admin = 1, role = 'admin' WHERE id = ?", args: [user.id] });
    const updated = await getUserById(user.id);
    res.json({ admin: sanitizeUser(updated) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Wiki Categories ──────────────────────────────────────────────────────────

app.get("/api/wiki/categories", async (_req, res) => {
  try {
    const cats = (await db.execute({
      sql: `SELECT c.id, c.slug, c.name, c.description, c.created_at, c.created_by,
                   COUNT(a.id) AS article_count
            FROM wiki_categories c
            LEFT JOIN wiki_articles a ON a.category_id = c.id AND a.status = 'approved'
            GROUP BY c.id ORDER BY c.name`,
      args: [],
    })).rows;
    res.json({ categories: cats });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/categories", authRequired, requireManageUsers, async (req, res) => {
  try {
    const name = safeText(req.body?.name, 80);
    const description = safeText(req.body?.description, 400);
    const slug = safeText(req.body?.slug, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (!name || !slug) return res.status(400).json({ error: "name and slug required" });
    const exists = (await db.execute({ sql: "SELECT id FROM wiki_categories WHERE slug = ?", args: [slug] })).rows[0];
    if (exists) return res.status(409).json({ error: "slug already exists" });
    const now = Date.now();
    const result = await db.execute({ sql: "INSERT INTO wiki_categories (slug, name, description, created_by, created_at) VALUES (?,?,?,?,?)", args: [slug, name, description, req.user.id, now] });
    const category = (await db.execute({ sql: "SELECT * FROM wiki_categories WHERE id = ?", args: [result.lastInsertRowid] })).rows[0];
    res.json({ category });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Wiki Articles ─────────────────────────────────────────────────────────────

app.get("/api/wiki/categories/:slug/articles", async (req, res) => {
  try {
    const cat = (await db.execute({ sql: "SELECT * FROM wiki_categories WHERE slug = ?", args: [req.params.slug] })).rows[0];
    if (!cat) return res.status(404).json({ error: "category not found" });
    const articles = (await db.execute({
      sql: `SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at, a.updated_at,
                   u.nickname AS author_nickname, u.id AS author_id
            FROM wiki_articles a JOIN users u ON u.id = a.author_id
            WHERE a.category_id = ? AND a.status = 'approved'
            ORDER BY a.updated_at DESC`,
      args: [cat.id],
    })).rows;
    res.json({ category: cat, articles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/wiki/articles/pending", authRequired, requireManageUsers, async (_req, res) => {
  try {
    const articles = (await db.execute({
      sql: `SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at,
                   u.nickname AS author_nickname, u.id AS author_id,
                   c.name AS category_name, c.slug AS category_slug
            FROM wiki_articles a
            JOIN users u ON u.id = a.author_id
            JOIN wiki_categories c ON c.id = a.category_id
            WHERE a.status = 'pending'
            ORDER BY a.created_at ASC`,
      args: [],
    })).rows;
    res.json({ articles });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/articles", authRequired, async (req, res) => {
  try {
    const p = rolePermissions(req.user.role);
    if (!p.canCreateThreads) return res.status(403).json({ error: "forbidden" });
    const categoryId = Number(req.body?.category_id);
    const title = safeText(req.body?.title, 150);
    const body = safeText(req.body?.body, 20000);
    const imageUrl = safeText(req.body?.image_url, 500);
    if (!categoryId || !title || !body) return res.status(400).json({ error: "category_id, title and body required" });
    const cat = (await db.execute({ sql: "SELECT id FROM wiki_categories WHERE id = ?", args: [categoryId] })).rows[0];
    if (!cat) return res.status(404).json({ error: "category not found" });
    if (imageUrl && !/^(https?:\/\/|\/wiki-app\/uploads\/)/.test(imageUrl)) {
      return res.status(400).json({ error: "only imgur.com or uploaded images allowed" });
    }
    const now = Date.now();
    const status = (p.canManageUsers || p.role === "moderator") ? "approved" : "pending";
    const result = await db.execute({
      sql: "INSERT INTO wiki_articles (category_id, title, body, image_url, author_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      args: [categoryId, title, body, imageUrl, req.user.id, status, now, now],
    });
    const article = (await db.execute({ sql: "SELECT * FROM wiki_articles WHERE id = ?", args: [result.lastInsertRowid] })).rows[0];
    res.json({ article, status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.patch("/api/wiki/articles/:id/status", authRequired, requireManageUsers, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const status = String(req.body?.status || "");
    if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "invalid status" });
    await db.execute({ sql: "UPDATE wiki_articles SET status = ? WHERE id = ?", args: [status, id] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.delete("/api/wiki/articles/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const art = (await db.execute({ sql: "SELECT * FROM wiki_articles WHERE id = ?", args: [id] })).rows[0];
    if (!art) return res.status(404).json({ error: "not found" });
    const p = rolePermissions(req.user.role);
    const isAuthor = art.author_id === req.user.id;
    if (!p.canManageUsers && !isAuthor) return res.status(403).json({ error: "forbidden" });
    await db.execute({ sql: "DELETE FROM wiki_article_comments WHERE article_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM wiki_articles WHERE id = ?", args: [id] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/wiki/articles/:id/comments", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const comments = (await db.execute({
      sql: `SELECT c.id, c.body, c.created_at, c.author_id, u.nickname AS author_nickname
            FROM wiki_article_comments c JOIN users u ON u.id = c.author_id
            WHERE c.article_id = ? ORDER BY c.created_at ASC`,
      args: [id],
    })).rows;
    res.json({ comments });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/wiki/articles/:id/comments", authRequired, async (req, res) => {
  try {
    const p = rolePermissions(req.user.role);
    if (!p.canComment) return res.status(403).json({ error: "forbidden" });
    const id = Number(req.params.id);
    const body = safeText(req.body?.body, 3000);
    if (!body) return res.status(400).json({ error: "body required" });
    const art = (await db.execute({ sql: "SELECT id FROM wiki_articles WHERE id = ? AND status = 'approved'", args: [id] })).rows[0];
    if (!art) return res.status(404).json({ error: "article not found" });
    const now = Date.now();
    await db.execute({ sql: "INSERT INTO wiki_article_comments (article_id, body, author_id, created_at) VALUES (?,?,?,?)", args: [id, body, req.user.id, now] });
    const comments = (await db.execute({
      sql: `SELECT c.id, c.body, c.created_at, c.author_id, u.nickname AS author_nickname
            FROM wiki_article_comments c JOIN users u ON u.id = c.author_id
            WHERE c.article_id = ? ORDER BY c.created_at ASC`,
      args: [id],
    })).rows;
    res.json({ comments });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.delete("/api/wiki/articles/:articleId/comments/:commentId", authRequired, async (req, res) => {
  try {
    const articleId = Number(req.params.articleId);
    const commentId = Number(req.params.commentId);
    if (!Number.isInteger(articleId) || !Number.isInteger(commentId)) {
      return res.status(400).json({ error: "invalid id" });
    }
    const comment = (await db.execute({ sql: "SELECT * FROM wiki_article_comments WHERE id = ? AND article_id = ?", args: [commentId, articleId] })).rows[0];
    if (!comment) return res.status(404).json({ error: "comment not found" });
    const p = rolePermissions(req.user.role);
    if (comment.author_id !== req.user.id && !p.canDeleteComments) {
      return res.status(403).json({ error: "forbidden" });
    }
    await db.execute({ sql: "DELETE FROM wiki_article_comments WHERE id = ?", args: [commentId] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── File upload ───────────────────────────────────────────────────────────────
app.post("/api/wiki/upload", authRequired, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file or invalid type (jpeg/png/gif/webp only)" });
  const url = "/wiki-app/uploads/" + req.file.filename;
  res.json({ url, filename: req.file.filename });
});

// ── Get single article ────────────────────────────────────────────────────────
app.get("/api/wiki/articles/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
    const art = (await db.execute({
      sql: `SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at, a.updated_at,
                   a.author_id, a.category_id,
                   u.nickname AS author_nickname,
                   c.slug AS category_slug, c.name AS category_name
            FROM wiki_articles a
            JOIN users u ON u.id = a.author_id
            JOIN wiki_categories c ON c.id = a.category_id
            WHERE a.id = ?`,
      args: [id],
    })).rows[0];
    if (!art) return res.status(404).json({ error: "not found" });
    res.json({ article: art, category_slug: art.category_slug });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Edit article ──────────────────────────────────────────────────────────────
app.patch("/api/wiki/articles/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const art = (await db.execute({ sql: "SELECT * FROM wiki_articles WHERE id = ?", args: [id] })).rows[0];
    if (!art) return res.status(404).json({ error: "not found" });

    const p = rolePermissions(req.user.role);
    const isAuthor = art.author_id === req.user.id;
    if (!p.canManageUsers && !isAuthor) return res.status(403).json({ error: "forbidden" });

    const title = req.body?.title ? safeText(req.body.title, 150) : null;
    const body  = req.body?.body  ? safeText(req.body.body, 20000) : null;
    const imageUrl = req.body?.image_url !== undefined ? safeText(req.body.image_url, 500) : null;

    if (imageUrl && imageUrl !== "" && !/^(https?:\/\/|\/wiki-app\/uploads\/)/.test(imageUrl)) {
      return res.status(400).json({ error: "invalid image_url" });
    }

    const now = Date.now();
    if (title) await db.execute({ sql: "UPDATE wiki_articles SET title = ?, updated_at = ? WHERE id = ?", args: [title, now, id] });
    if (body)  await db.execute({ sql: "UPDATE wiki_articles SET body = ?, updated_at = ? WHERE id = ?", args: [body, now, id] });
    if (imageUrl !== null) await db.execute({ sql: "UPDATE wiki_articles SET image_url = ?, updated_at = ? WHERE id = ?", args: [imageUrl, now, id] });

    const updated = (await db.execute({ sql: "SELECT * FROM wiki_articles WHERE id = ?", args: [id] })).rows[0];
    res.json({ article: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Delete category ───────────────────────────────────────────────────────────
app.delete("/api/wiki/categories/:id", authRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const cat = (await db.execute({ sql: "SELECT * FROM wiki_categories WHERE id = ?", args: [id] })).rows[0];
    if (!cat) return res.status(404).json({ error: "not found" });

    const p = rolePermissions(req.user.role);
    const isCreator = cat.created_by === req.user.id;
    if (!p.canManageUsers && !isCreator) return res.status(403).json({ error: "forbidden" });

    await db.execute({ sql: "DELETE FROM wiki_article_comments WHERE article_id IN (SELECT id FROM wiki_articles WHERE category_id = ?)", args: [id] });
    await db.execute({ sql: "DELETE FROM wiki_articles WHERE category_id = ?", args: [id] });
    await db.execute({ sql: "DELETE FROM wiki_categories WHERE id = ?", args: [id] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/wiki/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.status(400).json({ error: "query too short" });

    function makeExcerpt(text, query) {
      if (!text) return "";
      const idx = text.toLowerCase().indexOf(query.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        return text.slice(start, start + 150);
      }
      return text.slice(0, 150);
    }

    const articleRows = (await db.execute({
      sql: `SELECT a.id, a.title, a.body, c.slug AS category_slug
            FROM wiki_articles a
            JOIN wiki_categories c ON c.id = a.category_id
            WHERE a.status = 'approved'
              AND (LOWER(a.title) LIKE LOWER('%' || ? || '%')
                OR LOWER(a.body)  LIKE LOWER('%' || ? || '%'))
            LIMIT 20`,
      args: [q, q],
    })).rows;

    const categoryRows = (await db.execute({
      sql: `SELECT id, slug, name, description
            FROM wiki_categories
            WHERE LOWER(name) LIKE LOWER('%' || ? || '%')
               OR LOWER(description) LIKE LOWER('%' || ? || '%')
            LIMIT 20`,
      args: [q, q],
    })).rows;

    const articles = articleRows.map((a) => ({
      id: a.id,
      title: a.title,
      excerpt: makeExcerpt(a.body, q),
      category_slug: a.category_slug,
    }));

    const categories = categoryRows.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      excerpt: makeExcerpt(c.description, q),
    }));

    res.json({ articles, categories });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Likes ─────────────────────────────────────────────────────────────────────
app.post("/api/wiki/likes", authRequired, async (req, res) => {
  try {
    const { target_type, target_id } = req.body || {};
    if (!["article", "category"].includes(target_type)) {
      return res.status(400).json({ error: "invalid target_type" });
    }
    const tid = Number(target_id);
    if (!Number.isInteger(tid) || tid < 1) {
      return res.status(400).json({ error: "invalid target_id" });
    }

    const existing = (await db.execute({
      sql: "SELECT id FROM wiki_likes WHERE user_id = ? AND target_type = ? AND target_id = ?",
      args: [req.user.id, target_type, tid],
    })).rows[0];

    if (existing) {
      await db.execute({ sql: "DELETE FROM wiki_likes WHERE id = ?", args: [existing.id] });
    } else {
      await db.execute({
        sql: "INSERT INTO wiki_likes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)",
        args: [req.user.id, target_type, tid, Date.now()],
      });
    }

    const count = (await db.execute({
      sql: "SELECT COUNT(*) AS n FROM wiki_likes WHERE target_type = ? AND target_id = ?",
      args: [target_type, tid],
    })).rows[0].n;

    res.json({ liked: !existing, count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/wiki/likes", authOptional, async (req, res) => {
  try {
    const target_type = String(req.query.target_type || "");
    const tid = Number(req.query.target_id);
    if (!["article", "category"].includes(target_type)) {
      return res.status(400).json({ error: "invalid target_type" });
    }
    if (!Number.isInteger(tid) || tid < 1) {
      return res.status(400).json({ error: "invalid target_id" });
    }

    const count = (await db.execute({
      sql: "SELECT COUNT(*) AS n FROM wiki_likes WHERE target_type = ? AND target_id = ?",
      args: [target_type, tid],
    })).rows[0].n;

    const liked = req.user
      ? !!(await db.execute({
          sql: "SELECT id FROM wiki_likes WHERE user_id = ? AND target_type = ? AND target_id = ?",
          args: [req.user.id, target_type, tid],
        })).rows[0]
      : false;

    res.json({ count, liked });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Awards ────────────────────────────────────────────────────────────────────
app.get("/api/users/:id/awards", async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: "invalid id" });
    const awards = (await db.execute({
      sql: `SELECT a.id, a.title, a.description, a.icon, a.created_at,
                   u.nickname AS awarded_by_nickname
            FROM user_awards a
            JOIN users u ON u.id = a.awarded_by
            WHERE a.user_id = ?
            ORDER BY a.created_at DESC`,
      args: [userId],
    })).rows;
    res.json({ awards });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.post("/api/users/:id/awards", authRequired, async (req, res) => {
  try {
    const p = rolePermissions(req.user.role);
    if (!p.canManageUsers) return res.status(403).json({ error: "forbidden" });

    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: "invalid id" });
    const target = (await db.execute({ sql: "SELECT id FROM users WHERE id = ?", args: [userId] })).rows[0];
    if (!target) return res.status(404).json({ error: "user not found" });

    const title = safeText(req.body?.title, 60);
    if (!title) return res.status(400).json({ error: "title required" });
    const description = safeText(req.body?.description, 200);
    const icon = safeText(req.body?.icon, 4);
    const now = Date.now();

    const result = await db.execute({
      sql: "INSERT INTO user_awards (user_id, awarded_by, title, description, icon, created_at) VALUES (?,?,?,?,?,?)",
      args: [userId, req.user.id, title, description, icon, now],
    });

    const award = (await db.execute({
      sql: `SELECT a.id, a.title, a.description, a.icon, a.created_at,
                   u.nickname AS awarded_by_nickname
            FROM user_awards a JOIN users u ON u.id = a.awarded_by
            WHERE a.id = ?`,
      args: [result.lastInsertRowid],
    })).rows[0];

    res.json({ award });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.delete("/api/users/:id/awards/:awardId", authRequired, async (req, res) => {
  try {
    const p = rolePermissions(req.user.role);
    if (!p.canManageUsers) return res.status(403).json({ error: "forbidden" });

    const userId = Number(req.params.id);
    const awardId = Number(req.params.awardId);
    if (!Number.isInteger(userId) || !Number.isInteger(awardId)) {
      return res.status(400).json({ error: "invalid id" });
    }

    const award = (await db.execute({ sql: "SELECT id FROM user_awards WHERE id = ? AND user_id = ?", args: [awardId, userId] })).rows[0];
    if (!award) return res.status(404).json({ error: "award not found" });

    await db.execute({ sql: "DELETE FROM user_awards WHERE id = ?", args: [awardId] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Delete account ────────────────────────────────────────────────────────────
app.delete("/api/account", authRequired, async (req, res) => {
  try {
    const user = await getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: "not found" });
    if (user.role === "owner") return res.status(403).json({ error: "owner account cannot be deleted" });
    const email = user.email;
    const now = Date.now();
    await db.execute({ sql: "INSERT OR REPLACE INTO deleted_emails (email, deleted_at) VALUES (?, ?)", args: [email, now] });
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [user.id] });
    await db.execute({
      sql: "UPDATE users SET email = ?, nickname = ?, password_hash = ?, is_banned = 0, role = 'user', bio = '', avatar_url = '' WHERE id = ?",
      args: ["deleted_" + user.id + "@deleted", "[удалён]", "deleted", user.id],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Ban / Unban ───────────────────────────────────────────────────────────────
app.post("/api/users/:id/ban", authRequired, async (req, res) => {
  try {
    const p = rolePermissions(req.user.role);
    if (!p.canManageUsers && !p.canDeleteComments) return res.status(403).json({ error: "forbidden" });
    const targetId = Number(req.params.id);
    const target = (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [targetId] })).rows[0];
    if (!target) return res.status(404).json({ error: "not found" });
    if (target.role === "owner") return res.status(403).json({ error: "cannot ban owner" });
    if (!p.canManageUsers && ["admin", "owner"].includes(target.role)) {
      return res.status(403).json({ error: "insufficient permissions" });
    }
    const reason = safeText(req.body?.reason, 200);
    const now = Date.now();
    await db.execute({ sql: "UPDATE users SET is_banned = 1 WHERE id = ?", args: [targetId] });
    await db.execute({ sql: "INSERT OR REPLACE INTO user_bans (user_id, banned_by, reason, banned_at) VALUES (?,?,?,?)", args: [targetId, req.user.id, reason, now] });
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [targetId] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.delete("/api/users/:id/ban", authRequired, requireManageUsers, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    await db.execute({ sql: "UPDATE users SET is_banned = 0 WHERE id = ?", args: [targetId] });
    await db.execute({ sql: "DELETE FROM user_bans WHERE user_id = ?", args: [targetId] });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

app.get("/api/users/:id/ban", authRequired, requireManageUsers, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    const ban = (await db.execute({
      sql: `SELECT b.reason, b.banned_at, u.nickname AS banned_by_nickname
            FROM user_bans b JOIN users u ON u.id = b.banned_by
            WHERE b.user_id = ?`,
      args: [targetId],
    })).rows[0];
    res.json({ ban: ban || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "internal" });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedMainAdmin() {
  const existing = (await db.execute({ sql: "SELECT * FROM users WHERE email = ?", args: [ADMIN_EMAIL] })).rows[0];
  const now = Date.now();
  if (!existing) {
    await db.execute({
      sql: "INSERT INTO users (email, password_hash, nickname, is_admin, role, created_at) VALUES (?, ?, ?, 1, 'owner', ?)",
      args: [ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 11), ADMIN_NICK, now],
    });
    return;
  }
  await db.execute({ sql: "UPDATE users SET is_admin = 1, role = 'owner', nickname = ? WHERE id = ?", args: [ADMIN_NICK, existing.id] });
}

async function ensureColumn(table, column, definition) {
  const cols = (await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] })).rows;
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, args: [] });
  }
}

async function authOptional(req, _res, next) {
  const token = getBearerToken(req);
  if (!token) return next();
  try {
    const row = (await db.execute({
      sql: `SELECT s.token, s.expires_at, u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?`,
      args: [token],
    })).rows[0];
    if (!row || row.expires_at < Date.now()) {
      if (row) await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [token] });
      return next();
    }
    if (row.is_banned) {
      await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [token] });
      return next();
    }
    req.user = row;
    next();
  } catch (e) {
    console.error("authOptional error:", e.message);
    next();
  }
}

function authRequired(req, res, next) {
  authOptional(req, res, () => {
    if (!req.user) return res.status(401).json({ error: "unauthorized" });
    next();
  });
}

function requireCanCreateThreads(req, res, next) {
  const p = rolePermissions(req.user.role);
  if (!p.canCreateThreads) return res.status(403).json({ error: "editor role required" });
  next();
}

function requireCanComment(req, res, next) {
  const p = rolePermissions(req.user.role);
  if (!p.canComment) return res.status(403).json({ error: "comment not allowed for this role" });
  next();
}

function requireManageUsers(req, res, next) {
  const p = rolePermissions(req.user.role);
  if (!p.canManageUsers) return res.status(403).json({ error: "manager role required" });
  next();
}

function getBearerToken(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expires = now + 1000 * 60 * 60 * 24 * 30;
  await db.execute({ sql: "INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)", args: [token, userId, expires, now] });
  return token;
}

function normalizeEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

function normalizeNick(v) {
  return safeText(v, 40);
}

function safeText(v, maxLen) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLen);
}

function normalizeTags(v) {
  const src = Array.isArray(v) ? v : String(v || "").split(",");
  const cleaned = src
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean)
    .map((x) => x.replace(/[^a-zа-я0-9_\-]/gi, "").slice(0, 24))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, 8);
}

function parseTags(csv) {
  return String(csv || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function getUserById(id) {
  return (await db.execute({ sql: "SELECT * FROM users WHERE id = ?", args: [id] })).rows[0];
}

async function loadComments(threadId) {
  return (await db.execute({
    sql: `SELECT c.id, c.body, c.created_at, c.author_id, u.nickname AS author_nickname
          FROM comments c
          JOIN users u ON u.id = c.author_id
          WHERE c.thread_id = ?
          ORDER BY c.created_at ASC`,
    args: [threadId],
  })).rows;
}

async function loadThread(id) {
  const t = (await db.execute({
    sql: `SELECT t.id, t.title, t.body, t.tags, t.created_at, t.updated_at, t.author_id,
                 u.nickname AS author_nickname
          FROM threads t
          JOIN users u ON u.id = t.author_id
          WHERE t.id = ?`,
    args: [id],
  })).rows[0];
  if (!t) return null;
  return { ...t, tags: parseTags(t.tags), comments: await loadComments(t.id) };
}

function publicRoleLabel(role) {
  const m = {
    owner: "Владелец",
    admin: "Администратор",
    moderator: "Модератор",
    postmaker: "Постмейкер",
    user: "Участник",
  };
  return m[role] || role;
}

function sanitizeUser(u) {
  const p = rolePermissions(u.role);
  return {
    id: u.id,
    email: u.email,
    nickname: u.nickname,
    bio: u.bio || "",
    avatarUrl: u.avatar_url || "",
    role: u.role,
    roleLabel: publicRoleLabel(u.role),
    isAdmin: p.canManageUsers || u.role === "owner",
    canManageUsers: p.canManageUsers,
    canCreateThreads: p.canCreateThreads,
    canComment: p.canComment,
    canDeleteComments: p.canDeleteComments,
    isPostmaker: p.isPostmaker,
    createdAt: u.created_at,
  };
}

function stripDangerousHtml(html) {
  return String(html)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/\son\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*>/gi, "");
}

function fetchHttpsText(urlStr, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : require("http");
    const req = lib.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": "GwikiPravilaSync/1.0" },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          const nextUrl = new URL(res.headers.location, urlStr).href;
          res.resume();
          return fetchHttpsText(nextUrl, redirects - 1).then(resolve).catch(reject);
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          resolve(body);
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (e) {
    console.error("Failed to initialize DB:", e);
    process.exit(1);
  }
})();
