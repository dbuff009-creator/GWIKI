const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const Database = require("better-sqlite3");
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
const PORT = process.env.PORT || 3001;

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
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

ensureColumn("users", "bio", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "avatar_url", "TEXT NOT NULL DEFAULT ''");
ensureColumn("users", "role", "TEXT NOT NULL DEFAULT 'user'");
ensureColumn("users", "consent_at", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "is_banned", "INTEGER NOT NULL DEFAULT 0");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "oimp.gorb@gmail.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "al350350";
const ADMIN_NICK = process.env.ADMIN_NICK || "D3buff";

const ROLES = ["owner", "admin", "moderator", "postmaker", "user"];

seedMainAdmin();
migrateUserRoles();

function migrateUserRoles() {
  db.prepare("UPDATE users SET email = ? WHERE email = 'oimg.gorb@gmail.com'").run(ADMIN_EMAIL);
  db.prepare("UPDATE users SET role = 'owner', is_admin = 1 WHERE email = ?").run(ADMIN_EMAIL);
  db.prepare("UPDATE users SET role = 'admin' WHERE is_admin = 1 AND email != ?").run(ADMIN_EMAIL);
  db.prepare("UPDATE users SET role = 'user' WHERE role IN ('commenter', 'viewer', 'editor')").run();
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
app.use(express.static(__dirname));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/wiki/directory", (_req, res) => {
  const users = db.prepare("SELECT id, nickname FROM users ORDER BY nickname LIMIT 300").all();
  res.json({ users });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post("/api/register", authLimiter, (req, res) => {
  if (req.body?.consent !== true) return res.status(400).json({ error: "consent_required" });

  if (req.body?.website || req.body?.phone) {
    return res.status(400).json({ error: "invalid payload" });
  }

  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  const nickname = normalizeNick(req.body?.nickname);
  if (!email || !password || !nickname) return res.status(400).json({ error: "invalid payload" });
  if (password.length < 6 || password.length > 128) return res.status(400).json({ error: "invalid password length" });

  const deleted = db.prepare("SELECT deleted_at FROM deleted_emails WHERE email = ?").get(email);
  if (deleted) {
    const daysLeft = Math.ceil((deleted.deleted_at + 14 * 24 * 3600 * 1000 - Date.now()) / (24 * 3600 * 1000));
    if (daysLeft > 0) {
      return res.status(409).json({ error: `email_blocked`, message: `Этот email заблокирован ещё на ${daysLeft} дн.` });
    }
    db.prepare("DELETE FROM deleted_emails WHERE email = ?").run(email);
  }

  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "email already exists" });

  const hash = bcrypt.hashSync(password, 11);
  const now = Date.now();
  const info = db
    .prepare(
      "INSERT INTO users (email, password_hash, nickname, is_admin, role, consent_at, created_at) VALUES (?, ?, ?, 0, 'user', ?, ?)"
    )
    .run(email, hash, nickname, now, now);
  const token = createSession(info.lastInsertRowid);
  res.json({ token, user: sanitizeUser(getUserById(info.lastInsertRowid)) });
});

app.post("/api/login", authLimiter, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ error: "invalid payload" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "invalid credentials" });
  }
  if (user.is_banned) {
    const ban = db.prepare("SELECT reason FROM user_bans WHERE user_id = ?").get(user.id);
    return res.status(403).json({ error: "banned", message: "Аккаунт заблокирован" + (ban?.reason ? ": " + ban.reason : ".") });
  }
  const token = createSession(user.id);
  res.json({ token, user: sanitizeUser(user) });
});

app.post("/api/logout", authOptional, (req, res) => {
  const token = getBearerToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  res.json({ ok: true });
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: sanitizeUser(req.user) });
});

app.get("/api/users/:id/public", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
  const u = db.prepare("SELECT id, nickname, bio, avatar_url, created_at, role FROM users WHERE id = ?").get(id);
  if (!u) return res.status(404).json({ error: "not found" });
  const wikiArticles = db.prepare("SELECT COUNT(*) AS n FROM wiki_articles WHERE author_id = ? AND status = 'approved'").get(id).n;
  const comments = db.prepare("SELECT COUNT(*) AS n FROM wiki_article_comments WHERE author_id = ?").get(id).n;
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
});

app.get("/api/users/:id/articles", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
  const articles = db.prepare(`
    SELECT a.id, a.title, a.body, a.created_at, a.updated_at,
           c.name AS category_name, c.slug AS category_slug
    FROM wiki_articles a
    JOIN wiki_categories c ON c.id = a.category_id
    WHERE a.author_id = ? AND a.status = 'approved'
    ORDER BY a.updated_at DESC
    LIMIT 50
  `).all(id);
  res.json({ articles });
});

app.patch("/api/profile", authRequired, (req, res) => {
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
  if (nickname) db.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickname, req.user.id);
  if (password) db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(password, 11), req.user.id);
  if (bio !== null) db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(bio, req.user.id);
  if (avatarUrl !== null) db.prepare("UPDATE users SET avatar_url = ? WHERE id = ?").run(avatarUrl, req.user.id);
  res.json({ user: sanitizeUser(getUserById(req.user.id)) });
});

// ── Members / Roles ───────────────────────────────────────────────────────────
app.get("/api/wiki/members", authRequired, requireManageUsers, (_req, res) => {
  const rows = db.prepare("SELECT id, email, nickname, role, created_at FROM users ORDER BY email").all();
  res.json({ members: rows });
});

app.post("/api/wiki/members/role", authRequired, requireManageUsers, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const role = String(req.body?.role || "").toLowerCase();
  if (!email || !ROLES.includes(role)) return res.status(400).json({ error: "email and valid role required" });
  const target = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!target) return res.status(404).json({ error: "user not found" });
  const actor = getUserById(req.user.id);
  if (role === "owner" && actor.role !== "owner") {
    return res.status(403).json({ error: "only owner can assign owner" });
  }
  if (role === "admin" && actor.role !== "owner") {
    return res.status(403).json({ error: "only owner can assign admin" });
  }
  if (target.role === "owner" && actor.role !== "owner") {
    return res.status(403).json({ error: "only owner can change owner" });
  }
  const isAdm = role === "admin" || role === "owner" ? 1 : 0;
  db.prepare("UPDATE users SET is_admin = ?, role = ? WHERE id = ?").run(isAdm, role, target.id);
  res.json({ user: sanitizeUser(getUserById(target.id)) });
});

app.get("/api/admins", authRequired, requireManageUsers, (_req, res) => {
  const admins = db.prepare("SELECT id, email, nickname, role, created_at FROM users WHERE role IN ('owner','admin') ORDER BY email").all();
  res.json({ admins });
});

app.post("/api/admins", authRequired, requireManageUsers, (req, res) => {
  req.body = { ...req.body, role: "admin" };
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "email required" });
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(404).json({ error: "user not found" });
  db.prepare("UPDATE users SET is_admin = 1, role = 'admin' WHERE id = ?").run(user.id);
  res.json({ admin: sanitizeUser(getUserById(user.id)) });
});

// ── Wiki Categories ───────────────────────────────────────────────────────────
app.get("/api/wiki/categories", (_req, res) => {
  const cats = db.prepare(`
    SELECT c.id, c.slug, c.name, c.description, c.created_at, c.created_by,
           COUNT(a.id) AS article_count
    FROM wiki_categories c
    LEFT JOIN wiki_articles a ON a.category_id = c.id AND a.status = 'approved'
    GROUP BY c.id ORDER BY c.name
  `).all();
  res.json({ categories: cats });
});

app.post("/api/wiki/categories", authRequired, requireManageUsers, (req, res) => {
  const name = safeText(req.body?.name, 80);
  const description = safeText(req.body?.description, 400);
  const slug = safeText(req.body?.slug, 60).toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name || !slug) return res.status(400).json({ error: "name and slug required" });
  const exists = db.prepare("SELECT id FROM wiki_categories WHERE slug = ?").get(slug);
  if (exists) return res.status(409).json({ error: "slug already exists" });
  const now = Date.now();
  const info = db.prepare("INSERT INTO wiki_categories (slug, name, description, created_by, created_at) VALUES (?,?,?,?,?)").run(slug, name, description, req.user.id, now);
  res.json({ category: db.prepare("SELECT * FROM wiki_categories WHERE id = ?").get(info.lastInsertRowid) });
});

app.delete("/api/wiki/categories/:id", authRequired, (req, res) => {
  const id = Number(req.params.id);
  const cat = db.prepare("SELECT * FROM wiki_categories WHERE id = ?").get(id);
  if (!cat) return res.status(404).json({ error: "not found" });

  const p = rolePermissions(req.user.role);
  const isCreator = cat.created_by === req.user.id;
  if (!p.canManageUsers && !isCreator) return res.status(403).json({ error: "forbidden" });

  db.prepare("DELETE FROM wiki_article_comments WHERE article_id IN (SELECT id FROM wiki_articles WHERE category_id = ?)").run(id);
  db.prepare("DELETE FROM wiki_articles WHERE category_id = ?").run(id);
  db.prepare("DELETE FROM wiki_categories WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ── Wiki Articles ─────────────────────────────────────────────────────────────
app.get("/api/wiki/categories/:slug/articles", (req, res) => {
  const cat = db.prepare("SELECT * FROM wiki_categories WHERE slug = ?").get(req.params.slug);
  if (!cat) return res.status(404).json({ error: "category not found" });
  const articles = db.prepare(`
    SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at, a.updated_at,
           u.nickname AS author_nickname, u.id AS author_id
    FROM wiki_articles a JOIN users u ON u.id = a.author_id
    WHERE a.category_id = ? AND a.status = 'approved'
    ORDER BY a.updated_at DESC
  `).all(cat.id);
  res.json({ category: cat, articles });
});

app.get("/api/wiki/articles/pending", authRequired, requireManageUsers, (_req, res) => {
  const articles = db.prepare(`
    SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at,
           u.nickname AS author_nickname, u.id AS author_id,
           c.name AS category_name, c.slug AS category_slug
    FROM wiki_articles a
    JOIN users u ON u.id = a.author_id
    JOIN wiki_categories c ON c.id = a.category_id
    WHERE a.status = 'pending'
    ORDER BY a.created_at ASC
  `).all();
  res.json({ articles });
});

app.get("/api/wiki/articles/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "invalid id" });
  const art = db.prepare(`
    SELECT a.id, a.title, a.body, a.image_url, a.status, a.created_at, a.updated_at,
           a.author_id, a.category_id,
           u.nickname AS author_nickname,
           c.slug AS category_slug, c.name AS category_name
    FROM wiki_articles a
    JOIN users u ON u.id = a.author_id
    JOIN wiki_categories c ON c.id = a.category_id
    WHERE a.id = ?
  `).get(id);
  if (!art) return res.status(404).json({ error: "not found" });
  res.json({ article: art, category_slug: art.category_slug });
});

app.post("/api/wiki/articles", authRequired, (req, res) => {
  const p = rolePermissions(req.user.role);
  if (!p.canCreateThreads) return res.status(403).json({ error: "forbidden" });
  const categoryId = Number(req.body?.category_id);
  const title = safeText(req.body?.title, 150);
  const body = safeText(req.body?.body, 20000);
  const imageUrl = safeText(req.body?.image_url, 500);
  if (!categoryId || !title || !body) return res.status(400).json({ error: "category_id, title and body required" });
  const cat = db.prepare("SELECT id FROM wiki_categories WHERE id = ?").get(categoryId);
  if (!cat) return res.status(404).json({ error: "category not found" });
  if (imageUrl && !/^(https?:\/\/|\/uploads\/)/.test(imageUrl)) {
    return res.status(400).json({ error: "only imgur.com or uploaded images allowed" });
  }
  const now = Date.now();
  const status = (p.canManageUsers || p.role === "moderator") ? "approved" : "pending";
  const info = db.prepare("INSERT INTO wiki_articles (category_id, title, body, image_url, author_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(categoryId, title, body, imageUrl, req.user.id, status, now, now);
  res.json({ article: db.prepare("SELECT * FROM wiki_articles WHERE id = ?").get(info.lastInsertRowid), status });
});

app.patch("/api/wiki/articles/:id", authRequired, (req, res) => {
  const id = Number(req.params.id);
  const art = db.prepare("SELECT * FROM wiki_articles WHERE id = ?").get(id);
  if (!art) return res.status(404).json({ error: "not found" });

  const p = rolePermissions(req.user.role);
  const isAuthor = art.author_id === req.user.id;
  if (!p.canManageUsers && !isAuthor) return res.status(403).json({ error: "forbidden" });

  const title = req.body?.title ? safeText(req.body.title, 150) : null;
  const body  = req.body?.body  ? safeText(req.body.body, 20000) : null;
  const imageUrl = req.body?.image_url !== undefined ? safeText(req.body.image_url, 500) : null;

  if (imageUrl && imageUrl !== "" && !/^(https?:\/\/|\/uploads\/)/.test(imageUrl)) {
    return res.status(400).json({ error: "invalid image_url" });
  }

  const now = Date.now();
  if (title) db.prepare("UPDATE wiki_articles SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
  if (body)  db.prepare("UPDATE wiki_articles SET body = ?, updated_at = ? WHERE id = ?").run(body, now, id);
  if (imageUrl !== null) db.prepare("UPDATE wiki_articles SET image_url = ?, updated_at = ? WHERE id = ?").run(imageUrl, now, id);

  res.json({ article: db.prepare("SELECT * FROM wiki_articles WHERE id = ?").get(id) });
});

app.patch("/api/wiki/articles/:id/status", authRequired, requireManageUsers, (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "");
  if (!["approved", "rejected"].includes(status)) return res.status(400).json({ error: "invalid status" });
  db.prepare("UPDATE wiki_articles SET status = ? WHERE id = ?").run(status, id);
  res.json({ ok: true });
});

app.delete("/api/wiki/articles/:id", authRequired, (req, res) => {
  const id = Number(req.params.id);
  const art = db.prepare("SELECT * FROM wiki_articles WHERE id = ?").get(id);
  if (!art) return res.status(404).json({ error: "not found" });
  const p = rolePermissions(req.user.role);
  const isAuthor = art.author_id === req.user.id;
  if (!p.canManageUsers && !isAuthor) return res.status(403).json({ error: "forbidden" });
  db.prepare("DELETE FROM wiki_article_comments WHERE article_id = ?").run(id);
  db.prepare("DELETE FROM wiki_articles WHERE id = ?").run(id);
  res.json({ ok: true });
});

// ── Article Comments ──────────────────────────────────────────────────────────
app.get("/api/wiki/articles/:id/comments", (req, res) => {
  const id = Number(req.params.id);
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.author_id, u.nickname AS author_nickname
    FROM wiki_article_comments c JOIN users u ON u.id = c.author_id
    WHERE c.article_id = ? ORDER BY c.created_at ASC
  `).all(id);
  res.json({ comments });
});

app.post("/api/wiki/articles/:id/comments", authRequired, (req, res) => {
  const p = rolePermissions(req.user.role);
  if (!p.canComment) return res.status(403).json({ error: "forbidden" });
  const id = Number(req.params.id);
  const body = safeText(req.body?.body, 3000);
  if (!body) return res.status(400).json({ error: "body required" });
  const art = db.prepare("SELECT id FROM wiki_articles WHERE id = ? AND status = 'approved'").get(id);
  if (!art) return res.status(404).json({ error: "article not found" });
  const now = Date.now();
  db.prepare("INSERT INTO wiki_article_comments (article_id, body, author_id, created_at) VALUES (?,?,?,?)").run(id, body, req.user.id, now);
  const comments = db.prepare(`
    SELECT c.id, c.body, c.created_at, c.author_id, u.nickname AS author_nickname
    FROM wiki_article_comments c JOIN users u ON u.id = c.author_id
    WHERE c.article_id = ? ORDER BY c.created_at ASC
  `).all(id);
  res.json({ comments });
});

app.delete("/api/wiki/articles/:articleId/comments/:commentId", authRequired, (req, res) => {
  const articleId = Number(req.params.articleId);
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(articleId) || !Number.isInteger(commentId)) {
    return res.status(400).json({ error: "invalid id" });
  }
  const comment = db.prepare("SELECT * FROM wiki_article_comments WHERE id = ? AND article_id = ?").get(commentId, articleId);
  if (!comment) return res.status(404).json({ error: "comment not found" });
  const p = rolePermissions(req.user.role);
  if (comment.author_id !== req.user.id && !p.canDeleteComments) {
    return res.status(403).json({ error: "forbidden" });
  }
  db.prepare("DELETE FROM wiki_article_comments WHERE id = ?").run(commentId);
  res.json({ ok: true });
});

// ── File upload ───────────────────────────────────────────────────────────────
app.post("/api/wiki/upload", authRequired, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file or invalid type (jpeg/png/gif/webp only)" });
  const url = "/uploads/" + req.file.filename;
  res.json({ url, filename: req.file.filename });
});

// ── Search ────────────────────────────────────────────────────────────────────
app.get("/api/wiki/search", (req, res) => {
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

  const articleRows = db.prepare(`
    SELECT a.id, a.title, a.body, c.slug AS category_slug
    FROM wiki_articles a
    JOIN wiki_categories c ON c.id = a.category_id
    WHERE a.status = 'approved'
      AND (LOWER(a.title) LIKE LOWER('%' || ? || '%')
        OR LOWER(a.body)  LIKE LOWER('%' || ? || '%'))
    LIMIT 20
  `).all(q, q);

  const categoryRows = db.prepare(`
    SELECT id, slug, name, description
    FROM wiki_categories
    WHERE LOWER(name) LIKE LOWER('%' || ? || '%')
       OR LOWER(description) LIKE LOWER('%' || ? || '%')
    LIMIT 20
  `).all(q, q);

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
});

// ── Likes ─────────────────────────────────────────────────────────────────────
app.post("/api/wiki/likes", authRequired, (req, res) => {
  const { target_type, target_id } = req.body || {};
  if (!["article", "category"].includes(target_type)) {
    return res.status(400).json({ error: "invalid target_type" });
  }
  const tid = Number(target_id);
  if (!Number.isInteger(tid) || tid < 1) {
    return res.status(400).json({ error: "invalid target_id" });
  }

  const existing = db.prepare(
    "SELECT id FROM wiki_likes WHERE user_id = ? AND target_type = ? AND target_id = ?"
  ).get(req.user.id, target_type, tid);

  if (existing) {
    db.prepare("DELETE FROM wiki_likes WHERE id = ?").run(existing.id);
  } else {
    db.prepare(
      "INSERT INTO wiki_likes (user_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)"
    ).run(req.user.id, target_type, tid, Date.now());
  }

  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM wiki_likes WHERE target_type = ? AND target_id = ?"
  ).get(target_type, tid).n;

  res.json({ liked: !existing, count });
});

app.get("/api/wiki/likes", authOptional, (req, res) => {
  const target_type = String(req.query.target_type || "");
  const tid = Number(req.query.target_id);
  if (!["article", "category"].includes(target_type)) {
    return res.status(400).json({ error: "invalid target_type" });
  }
  if (!Number.isInteger(tid) || tid < 1) {
    return res.status(400).json({ error: "invalid target_id" });
  }

  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM wiki_likes WHERE target_type = ? AND target_id = ?"
  ).get(target_type, tid).n;

  const liked = req.user
    ? !!db.prepare(
        "SELECT id FROM wiki_likes WHERE user_id = ? AND target_type = ? AND target_id = ?"
      ).get(req.user.id, target_type, tid)
    : false;

  res.json({ count, liked });
});

// ── Awards ────────────────────────────────────────────────────────────────────
app.get("/api/users/:id/awards", (req, res) => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: "invalid id" });
  const awards = db.prepare(`
    SELECT a.id, a.title, a.description, a.icon, a.created_at,
           u.nickname AS awarded_by_nickname
    FROM user_awards a
    JOIN users u ON u.id = a.awarded_by
    WHERE a.user_id = ?
    ORDER BY a.created_at DESC
  `).all(userId);
  res.json({ awards });
});

app.post("/api/users/:id/awards", authRequired, (req, res) => {
  const p = rolePermissions(req.user.role);
  if (!p.canManageUsers) return res.status(403).json({ error: "forbidden" });

  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: "invalid id" });
  const target = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  if (!target) return res.status(404).json({ error: "user not found" });

  const title = safeText(req.body?.title, 60);
  if (!title) return res.status(400).json({ error: "title required" });
  const description = safeText(req.body?.description, 200);
  const icon = safeText(req.body?.icon, 4);
  const now = Date.now();

  const info = db.prepare(
    "INSERT INTO user_awards (user_id, awarded_by, title, description, icon, created_at) VALUES (?,?,?,?,?,?)"
  ).run(userId, req.user.id, title, description, icon, now);

  const award = db.prepare(`
    SELECT a.id, a.title, a.description, a.icon, a.created_at,
           u.nickname AS awarded_by_nickname
    FROM user_awards a JOIN users u ON u.id = a.awarded_by
    WHERE a.id = ?
  `).get(info.lastInsertRowid);

  res.json({ award });
});

app.delete("/api/users/:id/awards/:awardId", authRequired, (req, res) => {
  const p = rolePermissions(req.user.role);
  if (!p.canManageUsers) return res.status(403).json({ error: "forbidden" });

  const userId = Number(req.params.id);
  const awardId = Number(req.params.awardId);
  if (!Number.isInteger(userId) || !Number.isInteger(awardId)) {
    return res.status(400).json({ error: "invalid id" });
  }

  const award = db.prepare("SELECT id FROM user_awards WHERE id = ? AND user_id = ?").get(awardId, userId);
  if (!award) return res.status(404).json({ error: "award not found" });

  db.prepare("DELETE FROM user_awards WHERE id = ?").run(awardId);
  res.json({ ok: true });
});

// ── Delete account ────────────────────────────────────────────────────────────
app.delete("/api/account", authRequired, (req, res) => {
  const user = getUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "not found" });
  if (user.role === "owner") return res.status(403).json({ error: "owner account cannot be deleted" });
  const email = user.email;
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO deleted_emails (email, deleted_at) VALUES (?, ?)").run(email, now);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  db.prepare("UPDATE users SET email = ?, nickname = ?, password_hash = ?, is_banned = 0, role = 'user', bio = '', avatar_url = '' WHERE id = ?")
    .run("deleted_" + user.id + "@deleted", "[удалён]", "deleted", user.id);
  res.json({ ok: true });
});

// ── Ban / Unban ───────────────────────────────────────────────────────────────
app.post("/api/users/:id/ban", authRequired, (req, res) => {
  const p = rolePermissions(req.user.role);
  if (!p.canManageUsers && !p.canDeleteComments) return res.status(403).json({ error: "forbidden" });
  const targetId = Number(req.params.id);
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
  if (!target) return res.status(404).json({ error: "not found" });
  if (target.role === "owner") return res.status(403).json({ error: "cannot ban owner" });
  if (!p.canManageUsers && ["admin", "owner"].includes(target.role)) {
    return res.status(403).json({ error: "insufficient permissions" });
  }
  const reason = safeText(req.body?.reason, 200);
  const now = Date.now();
  db.prepare("UPDATE users SET is_banned = 1 WHERE id = ?").run(targetId);
  db.prepare("INSERT OR REPLACE INTO user_bans (user_id, banned_by, reason, banned_at) VALUES (?,?,?,?)").run(targetId, req.user.id, reason, now);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(targetId);
  res.json({ ok: true });
});

app.delete("/api/users/:id/ban", authRequired, requireManageUsers, (req, res) => {
  const targetId = Number(req.params.id);
  db.prepare("UPDATE users SET is_banned = 0 WHERE id = ?").run(targetId);
  db.prepare("DELETE FROM user_bans WHERE user_id = ?").run(targetId);
  res.json({ ok: true });
});

app.get("/api/users/:id/ban", authRequired, requireManageUsers, (req, res) => {
  const targetId = Number(req.params.id);
  const ban = db.prepare(`
    SELECT b.reason, b.banned_at, u.nickname AS banned_by_nickname
    FROM user_bans b JOIN users u ON u.id = b.banned_by
    WHERE b.user_id = ?
  `).get(targetId);
  res.json({ ban: ban || null });
});

app.listen(PORT, () => {
  console.log(`Gwiki server running at http://localhost:${PORT}`);
  console.log(`SQLite DB: ${DB_PATH}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function seedMainAdmin() {
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(ADMIN_EMAIL);
  const now = Date.now();
  if (!existing) {
    db.prepare(
      "INSERT INTO users (email, password_hash, nickname, is_admin, role, created_at) VALUES (?, ?, ?, 1, 'owner', ?)"
    ).run(ADMIN_EMAIL, bcrypt.hashSync(ADMIN_PASSWORD, 11), ADMIN_NICK, now);
    return;
  }
  db.prepare("UPDATE users SET is_admin = 1, role = 'owner', nickname = ? WHERE id = ?").run(ADMIN_NICK, existing.id);
}

function authOptional(req, _res, next) {
  const token = getBearerToken(req);
  if (!token) return next();
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.*
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
    )
    .get(token);
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return next();
  }
  if (row.is_banned) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return next();
  }
  req.user = row;
  next();
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

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const expires = now + 1000 * 60 * 60 * 24 * 30;
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, expires, now);
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

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = cols.some((c) => c.name === column);
  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
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
