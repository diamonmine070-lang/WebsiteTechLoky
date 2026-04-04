/**
 * TechPulse Backend - backend.js
 * Node.js + Express + SQLite (better-sqlite3)
 *
 * Cai dat:
 *   npm install express bcryptjs jsonwebtoken cors better-sqlite3 multer
 *
 * Chay:
 *   node backend.js
 *
 * DB file: ./techpulse.db  (restart khong mat data)
 * Base URL: http://localhost:3000
 *
 * ============================================================
 * API ROUTES
 * ============================================================
 * PUBLIC
 *   GET    /health                       (require admin token)
 *   GET    /api/categories
 *   GET    /api/articles                 ?page&limit&category&featured&hot&sort
 *   GET    /api/articles/search          ?q&page&limit&category&sort
 *   GET    /api/articles/trending        ?limit
 *   GET    /api/articles/:id
 *   GET    /api/articles/:id/related
 *   GET    /api/articles/:id/comments    ?page&limit
 *   POST   /api/search                   { q, category?, page?, limit? }  AI semantic
 *
 * AUTH
 *   POST   /api/auth/register            { name, email, password }
 *   POST   /api/auth/login               { email, password }
 *   POST   /api/auth/forgot-password     { email }
 *   POST   /api/auth/refresh             { token }
 *
 * USER (JWT required)
 *   GET    /api/auth/me
 *   PUT    /api/auth/me                  { name?, avatar? }
 *   PUT    /api/auth/me/password         { currentPassword, newPassword }
 *   GET    /api/user/bookmarks
 *   POST   /api/user/bookmarks/:id       toggle
 *   GET    /api/user/notifications
 *   PUT    /api/user/notifications       { email?, breaking?, weekly?, marketing? }
 *   POST   /api/articles/:id/comments    { content }
 *   DELETE /api/comments/:id             (own comment or admin)
 *
 * UPLOAD
 *   POST   /api/upload                   multipart/form-data, field: file
 *
 * NEWSLETTER (public)
 *   POST   /api/newsletter/subscribe     { email, frequency, topics[] }
 *
 * ADMIN (JWT + role=admin)
 *   GET    /api/admin/articles           ?page&limit&status&category
 *   POST   /api/admin/articles           { ...fields }
 *   PUT    /api/admin/articles/:id       { ...fields }
 *   DELETE /api/admin/articles/:id
 *   GET    /api/admin/stats
 *   GET    /api/admin/traffic            ?period=7d|30d
 *   GET    /api/admin/users              ?page&limit&role&status
 *   PATCH  /api/admin/users/:id          { role?, status?, name?, email? }
 *   DELETE /api/admin/users/:id
 *   GET    /api/admin/settings
 *   PUT    /api/admin/settings           { siteName, domain, email, ... }
 * ============================================================
 */

'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const https    = require('https');
const multer   = require('multer');

const app = express();
const PORT        = process.env.PORT        || 3000;
const JWT_SECRET  = process.env.JWT_SECRET  || 'techpulse-secret-change-in-prod';
const JWT_EXPIRES = '7d';
const DB_PATH     = path.join(__dirname, 'techpulse.db');
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
const ALLOWED_ORIGINS   = (process.env.ALLOWED_ORIGINS   || '').split(',').map(s => s.trim()).filter(Boolean);
const GOOGLE_CLIENT_ID  = process.env.GOOGLE_CLIENT_ID   || '';

// Tao thu muc uploads neu chua co
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
  origin: function(origin, cb) {
    // Cho phep request khong co origin (curl, mobile app, same-origin)
    if (!origin) return cb(null, true);
    if (!ALLOWED_ORIGINS.length) return cb(null, true); // dev mode: cho phep tat ca
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin khong duoc phep'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));

// Multer config: chi nhan anh, max 5MB
const storage = multer.diskStorage({
  destination: function(_req, _file, cb) { cb(null, UPLOAD_DIR); },
  filename: function(_req, file, cb) {
    var ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
  },
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function(_req, file, cb) {
    var ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('Chi chap nhan file anh (jpg, png, gif, webp)'), ok);
  },
});

// ============================================================
// DATABASE INIT
// ============================================================

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    slug           TEXT    UNIQUE NOT NULL,
    category       TEXT    NOT NULL,
    category_label TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    excerpt        TEXT,
    content        TEXT,
    author         TEXT,
    author_avatar  TEXT,
    date           TEXT    NOT NULL DEFAULT (datetime('now')),
    read_time      INTEGER DEFAULT 4,
    views          INTEGER DEFAULT 0,
    shares         INTEGER DEFAULT 0,
    bounce_rate    REAL    DEFAULT 0,
    thumbnail      TEXT,
    tags           TEXT    DEFAULT '[]',
    is_featured    INTEGER DEFAULT 0,
    is_hot         INTEGER DEFAULT 0,
    status         TEXT    DEFAULT 'published',
    deleted_at     TEXT    DEFAULT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    UNIQUE NOT NULL,
    password    TEXT    NOT NULL,
    avatar      TEXT,
    role        TEXT    DEFAULT 'user',
    status      TEXT    DEFAULT 'active',
    phone       TEXT,
    last_ip     TEXT,
    last_device TEXT,
    created_at  TEXT    DEFAULT (datetime('now')),
    updated_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id    INTEGER NOT NULL,
    article_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, article_id),
    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now')),
    deleted_at TEXT    DEFAULT NULL,
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS newsletters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    frequency  TEXT DEFAULT 'daily',
    topics     TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS notification_settings (
    user_id   INTEGER PRIMARY KEY,
    email_on  INTEGER DEFAULT 1,
    breaking  INTEGER DEFAULT 1,
    weekly    INTEGER DEFAULT 0,
    marketing INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS view_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id INTEGER NOT NULL,
    user_id    INTEGER,
    ip         TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ads (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    platform   TEXT    NOT NULL,
    revenue    REAL    DEFAULT 0,
    clicks     INTEGER DEFAULT 0,
    impressions INTEGER DEFAULT 0,
    ctr        REAL    DEFAULT 0,
    rpm        REAL    DEFAULT 0,
    period     TEXT    NOT NULL,
    created_at TEXT    DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_interests (
    user_id    INTEGER NOT NULL,
    category   TEXT    NOT NULL,
    score      INTEGER DEFAULT 1,
    updated_at TEXT    DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, category),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_stats (
    user_id      INTEGER PRIMARY KEY,
    total_views  INTEGER DEFAULT 0,
    total_comments INTEGER DEFAULT 0,
    total_shares INTEGER DEFAULT 0,
    avg_read_time TEXT    DEFAULT '0:00',
    updated_at   TEXT    DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS site_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_articles_status   ON articles(status);
  CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);
  CREATE INDEX IF NOT EXISTS idx_articles_views    ON articles(views DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_date     ON articles(date DESC);
  CREATE INDEX IF NOT EXISTS idx_articles_hot      ON articles(is_hot);
  CREATE INDEX IF NOT EXISTS idx_articles_featured ON articles(is_featured);
  CREATE INDEX IF NOT EXISTS idx_view_log_article  ON view_log(article_id);
  CREATE INDEX IF NOT EXISTS idx_view_log_date     ON view_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_comments_article  ON comments(article_id);
`);

// Migration: them cac column moi neu chua co (cho DB cu)
var existingCols = db.pragma('table_info(articles)').map(function(c) { return c.name; });
if (!existingCols.includes('shares'))      db.exec('ALTER TABLE articles ADD COLUMN shares INTEGER DEFAULT 0');
if (!existingCols.includes('bounce_rate')) db.exec('ALTER TABLE articles ADD COLUMN bounce_rate REAL DEFAULT 0');
if (!existingCols.includes('deleted_at'))  db.exec('ALTER TABLE articles ADD COLUMN deleted_at TEXT DEFAULT NULL');

var existingUserCols = db.pragma('table_info(users)').map(function(c) { return c.name; });
if (!existingUserCols.includes('status'))      db.exec("ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'");
if (!existingUserCols.includes('phone'))       db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!existingUserCols.includes('last_ip'))     db.exec('ALTER TABLE users ADD COLUMN last_ip TEXT');
if (!existingUserCols.includes('last_device')) db.exec('ALTER TABLE users ADD COLUMN last_device TEXT');

var existingCommentCols = db.pragma('table_info(comments)').map(function(c) { return c.name; });
if (!existingCommentCols.includes('deleted_at')) db.exec('ALTER TABLE comments ADD COLUMN deleted_at TEXT DEFAULT NULL');

// Them user_id vao view_log neu chua co
var existingVLCols = db.pragma('table_info(view_log)').map(function(c) { return c.name; });
if (!existingVLCols.includes('user_id')) db.exec('ALTER TABLE view_log ADD COLUMN user_id INTEGER');

// ============================================================
// SEED DATA
// ============================================================

if (db.prepare('SELECT COUNT(*) as c FROM articles').get().c === 0) {
  var ins = db.prepare(`
    INSERT INTO articles
      (slug,category,category_label,title,excerpt,content,author,author_avatar,
       date,read_time,views,thumbnail,tags,is_featured,is_hot)
    VALUES
      (@slug,@category,@category_label,@title,@excerpt,@content,@author,@author_avatar,
       @date,@read_time,@views,@thumbnail,@tags,@is_featured,@is_hot)
  `);

  db.transaction(function(rows) { for (var r of rows) ins.run(r); })([
    {
      slug:'thanh-tri-galaxy-quick-share-iphone', category:'mobile', category_label:'Mobile',
      title:'"Thanh tri" cuoi cung ngan nguoi dung iPhone chuyen sang Galaxy vua bi pha vo',
      excerpt:'Samsung Galaxy S26 ho tro Quick Share voi iPhone, khong can app trung gian.',
      content:'<p>Samsung vua cong bo tinh nang Quick Share mo rong tren Galaxy S26, cho phep chia se file truc tiep voi iPhone. Toc do dat 480 Mbps qua Wi-Fi Direct + Bluetooth LE.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-25T09:00:00Z', read_time:4, views:18420,
      thumbnail:'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=800&q=80',
      tags:JSON.stringify(['Samsung','Quick Share','iPhone','Galaxy S26']), is_featured:1, is_hot:1,
    },
    {
      slug:'openai-ket-thuc-sora-disney', category:'ai', category_label:'AI',
      title:'OpenAI dot ngot khai tu cong cu tao video Sora, Disney mat 1 ty USD',
      excerpt:'Quyet dinh dong cua Sora chi sau 4 thang khien nhieu doi tac phai xem xet lai ke hoach.',
      content:'<p>OpenAI ngung dich vu Sora chi 4 thang sau khi ra mat. Chi phi moi phut video gan 40 USD khien mo hinh kinh doanh khong kha thi.</p>',
      author:'Thanh Truc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-25T07:30:00Z', read_time:3, views:24103,
      thumbnail:'https://images.unsplash.com/photo-1677442135703-1787eea5ce01?w=800&q=80',
      tags:JSON.stringify(['OpenAI','Sora','AI','Disney']), is_featured:1, is_hot:1,
    },
    {
      slug:'intel-core-ultra-7-270k-plus', category:'tin-ict', category_label:'Tin ICT',
      title:'Intel Core Ultra 7 270K Plus: Loi khang dinh "Chung toi da tro lai"',
      excerpt:'Core Ultra 7 270K Plus cai thien hieu nang gaming dang ke so voi the he truoc.',
      content:'<p>Intel ra mat Core Ultra 7 270K Plus, xung boost 6.2 GHz. Vuot Ryzen 9 9950X 8-12% trong gaming 1080p.</p>',
      author:'Duc Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-23T10:15:00Z', read_time:5, views:11250,
      thumbnail:'https://images.unsplash.com/photo-1591370874773-6702e8f12fd8?w=800&q=80',
      tags:JSON.stringify(['Intel','CPU','Gaming','Arrow Lake']), is_featured:0, is_hot:0,
    },
    {
      slug:'honor-top3-antutu-2026', category:'mobile', category_label:'Mobile',
      title:'HONOR tro lai manh me: Top 3 model thong tri bang xep hang AnTuTu',
      excerpt:'HONOR dang khien ca thi truong smartphone phai ngoai nhin voi man lot xac ngoan muc.',
      content:'<p>HONOR lan dau co ba model lot top 5 AnTuTu cung thang. Magic7 Pro, Magic7 RSR va GT Neo dan dau phan khuc tuong ung.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-23T08:00:00Z', read_time:3, views:9870,
      thumbnail:'https://images.unsplash.com/photo-1607252650355-f7fd0460ccdb?w=800&q=80',
      tags:JSON.stringify(['HONOR','AnTuTu','Smartphone','Android']), is_featured:0, is_hot:0,
    },
    {
      slug:'microsoft-don-dep-copilot-windows-11', category:'internet', category_label:'Internet',
      title:'Microsoft don dep mo bong bong AI tren Windows 11',
      excerpt:'Sau nhieu nam nhoi nhet Copilot vao moi ngoc ngach, Microsoft thua nhan sai lam.',
      content:'<p>Microsoft gop toan bo diem AI tren Windows 11 thanh mot Copilot duy nhat sau phan hoi tieu cuc tu nguoi dung toan cau.</p>',
      author:'Lan Anh', author_avatar:'https://i.pravatar.cc/40?img=44',
      date:'2026-03-24T11:00:00Z', read_time:4, views:15600,
      thumbnail:'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&q=80',
      tags:JSON.stringify(['Microsoft','Windows 11','Copilot','AI']), is_featured:0, is_hot:1,
    },
    {
      slug:'macbook-neo-8gb-60-apps', category:'do-choi-so', category_label:'Do choi so',
      title:'MacBook Neo 8GB mo 60 ung dung cung luc khong sap, laptop Windows sap man hinh',
      excerpt:'Hardware Canucks thu nghiem thuc te cho ket qua bat ngo ve kha nang quan ly RAM.',
      content:'<p>Hardware Canucks mo dong thoi 60 app tren MacBook Neo 8GB va laptop Windows 16GB. Apple unified memory xu ly muot; Windows crash o app thu 47.</p>',
      author:'Duc Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-24T09:30:00Z', read_time:3, views:22400,
      thumbnail:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80',
      tags:JSON.stringify(['MacBook','Apple','RAM','Benchmark']), is_featured:0, is_hot:0,
    },
    {
      slug:'bitcoin-184ty-mot-ngay-mat-sach', category:'tra-da-cn', category_label:'Tra da CN',
      title:'Nguoi dao duoc 184 ty Bitcoin trong mot ngay va mat sach chi sau vai gio',
      excerpt:'Su co suyt khai tu Bitcoin ngay tu giai doan moi khai sinh.',
      content:'<p>Nam 2010, lo hong code Bitcoin cho phep tao ra 184 ty BTC trong mot block. Satoshi va cong dong emergency fork trong 5 gio.</p>',
      author:'Thanh Truc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-23T14:00:00Z', read_time:6, views:31800,
      thumbnail:'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=800&q=80',
      tags:JSON.stringify(['Bitcoin','Crypto','Lich su','Satoshi']), is_featured:0, is_hot:0,
    },
    {
      slug:'suzuki-haojue-uhr350-honda-adv350', category:'xe', category_label:'Xe',
      title:'Suzuki Haojue UHR350: Du suc danh phu dau Honda ADV350 va Yamaha XMAX?',
      excerpt:'Mau xe tay ga con lai 350cc moi voi nen tang ky thuat Suzuki, gia canh tranh.',
      content:'<p>Suzuki Haojue UHR350 ra mat Dong Nam A, gia du kien 85-90 trieu dong tai Viet Nam. Dong co 350cc DOHC 4 van, 29 ma luc, ABS 2 kenh.</p>',
      author:'Quoc Huy', author_avatar:'https://i.pravatar.cc/40?img=55',
      date:'2026-03-24T13:00:00Z', read_time:4, views:8900,
      thumbnail:'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=800&q=80',
      tags:JSON.stringify(['Xe','Suzuki','Honda ADV','Yamaha XMAX']), is_featured:0, is_hot:0,
    },
  ]);
  console.log('[seed] 8 bai viet');
}

// Seed admin user
if (db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c === 0) {
  var hash = bcrypt.hashSync('admin123456', 10);
  db.prepare("INSERT INTO users (name,email,password,avatar,role,status) VALUES (?,?,?,?,?,?)")
    .run('Admin', 'admin@techpulse.vn', hash, 'https://i.pravatar.cc/80?img=1', 'admin', 'active');
  console.log('[seed] admin user created');
}

// Seed default site settings
if (db.prepare("SELECT COUNT(*) as c FROM site_settings").get().c === 0) {
  var settingInsert = db.prepare("INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)");
  db.transaction(function(rows) { for (var r of rows) settingInsert.run(r.k, r.v); })([
    { k:'siteName',    v:'TechPulse' },
    { k:'domain',      v:'techpulse.vn' },
    { k:'email',       v:'noreply@techpulse.vn' },
    { k:'description', v:'Tin tuc cong nghe moi nhat' },
  ]);
  console.log('[seed] site settings');
}

// ============================================================
// PREPARED STATEMENTS
// ============================================================

const stmt = {
  // Articles
  articleById:   db.prepare('SELECT * FROM articles WHERE id=? AND deleted_at IS NULL'),
  articleBySlug: db.prepare('SELECT * FROM articles WHERE slug=? AND deleted_at IS NULL'),
  incrViews:     db.prepare('UPDATE articles SET views=views+1 WHERE id=?'),
  incrShares:    db.prepare('UPDATE articles SET shares=shares+1 WHERE id=?'),
  softDelete:    db.prepare("UPDATE articles SET deleted_at=datetime('now'), status='archived' WHERE id=?"),
  hardDelete:    db.prepare('DELETE FROM articles WHERE id=?'),
  related:       db.prepare("SELECT * FROM articles WHERE category=? AND id!=? AND status='published' AND deleted_at IS NULL ORDER BY views DESC LIMIT 4"),
  trending:      db.prepare("SELECT * FROM articles WHERE status='published' AND deleted_at IS NULL ORDER BY views DESC LIMIT ?"),
  searchArticles:db.prepare("SELECT * FROM articles WHERE status='published' AND deleted_at IS NULL AND (title LIKE ? OR excerpt LIKE ? OR content LIKE ? OR tags LIKE ?) ORDER BY date DESC"),

  // Users
  userById:      db.prepare('SELECT * FROM users WHERE id=?'),
  userByEmail:   db.prepare('SELECT * FROM users WHERE email=?'),
  insertUser:    db.prepare('INSERT INTO users (name,email,password,avatar) VALUES (?,?,?,?)'),
  updateProfile: db.prepare("UPDATE users SET name=?,avatar=?,updated_at=datetime('now') WHERE id=?"),
  updatePw:      db.prepare('UPDATE users SET password=? WHERE id=?'),
  updateLastSeen:db.prepare("UPDATE users SET last_ip=?,last_device=?,updated_at=datetime('now') WHERE id=?"),
  allUsers:      db.prepare('SELECT id,name,email,avatar,role,status,phone,last_ip,last_device,created_at,updated_at FROM users ORDER BY id DESC'),
  countUsers:    db.prepare('SELECT COUNT(*) as c FROM users'),

  // Bookmarks
  getBookmarks:  db.prepare('SELECT article_id FROM bookmarks WHERE user_id=?'),
  hasBookmark:   db.prepare('SELECT 1 FROM bookmarks WHERE user_id=? AND article_id=?'),
  addBookmark:   db.prepare('INSERT OR IGNORE INTO bookmarks (user_id,article_id) VALUES (?,?)'),
  delBookmark:   db.prepare('DELETE FROM bookmarks WHERE user_id=? AND article_id=?'),

  // Comments
  getComments:   db.prepare(`
    SELECT c.id, c.content, c.created_at, c.deleted_at,
           u.id as user_id, u.name as user_name, u.avatar as user_avatar
    FROM comments c JOIN users u ON c.user_id=u.id
    WHERE c.article_id=? AND c.deleted_at IS NULL
    ORDER BY c.created_at DESC
    LIMIT ? OFFSET ?
  `),
  countComments:    db.prepare('SELECT COUNT(*) as c FROM comments WHERE article_id=? AND deleted_at IS NULL'),
  addComment:       db.prepare('INSERT INTO comments (article_id,user_id,content) VALUES (?,?,?)'),
  commentById:      db.prepare('SELECT * FROM comments WHERE id=? AND deleted_at IS NULL'),
  softDelComment:   db.prepare("UPDATE comments SET deleted_at=datetime('now') WHERE id=?"),

  // Newsletters
  nlByEmail:     db.prepare('SELECT * FROM newsletters WHERE email=?'),
  nlInsert:      db.prepare('INSERT INTO newsletters (email,frequency,topics) VALUES (?,?,?)'),
  nlUpdate:      db.prepare("UPDATE newsletters SET frequency=?,topics=?,updated_at=datetime('now') WHERE email=?"),

  // Notifications
  getNotif:      db.prepare('SELECT * FROM notification_settings WHERE user_id=?'),
  upsertNotif:   db.prepare(`
    INSERT INTO notification_settings (user_id,email_on,breaking,weekly,marketing) VALUES (?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      email_on=excluded.email_on, breaking=excluded.breaking,
      weekly=excluded.weekly, marketing=excluded.marketing
  `),

  // View log
  logView:       db.prepare('INSERT INTO view_log (article_id, user_id, ip) VALUES (?,?,?)'),
  hasViewedRecently: db.prepare("SELECT 1 FROM view_log WHERE article_id=? AND ip=? AND created_at > datetime('now','-1 hour')"),

  // User stats
  upsertUserStats: db.prepare(`
    INSERT INTO user_stats (user_id, total_views, total_comments, total_shares)
      VALUES (?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_views    = excluded.total_views,
      total_comments = excluded.total_comments,
      total_shares   = excluded.total_shares,
      updated_at     = datetime('now')
  `),

  // User interests
  upsertInterest: db.prepare(`
    INSERT INTO user_interests (user_id, category, score)
      VALUES (?,?,1)
    ON CONFLICT(user_id, category) DO UPDATE SET
      score      = score + 1,
      updated_at = datetime('now')
  `),
  getUserInterests: db.prepare('SELECT category, score FROM user_interests WHERE user_id=? ORDER BY score DESC'),
};

// ============================================================
// HELPERS
// ============================================================

const CATEGORIES = [
  { id:'mobile',     label:'Mobile' },
  { id:'ai',         label:'AI' },
  { id:'tin-ict',    label:'Tin ICT' },
  { id:'internet',   label:'Internet' },
  { id:'kham-pha',   label:'Kham pha' },
  { id:'xe',         label:'Xe' },
  { id:'apps-game',  label:'Apps & Game' },
  { id:'do-choi-so', label:'Do choi so' },
  { id:'tra-da-cn',  label:'Tra da CN' },
];
const VALID_CATEGORY_IDS = new Set(CATEGORIES.map(function(c) { return c.id; }));
const VALID_STATUSES = new Set(['published', 'draft', 'archived']);
const VALID_ROLES    = new Set(['admin', 'editor', 'premium', 'user']);
const VALID_USER_STATUSES = new Set(['active', 'premium', 'pending', 'banned']);

function res_ok(res, data, status) {
  return res.status(status || 200).json({ success: true, data: data });
}
function res_err(res, message, status) {
  return res.status(status || 400).json({ success: false, error: message });
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatArticle(row, full) {
  if (!row) return null;
  var art = {
    id:            row.id,
    slug:          row.slug,
    category:      row.category,
    categoryLabel: row.category_label,
    title:         row.title,
    excerpt:       row.excerpt,
    author:        row.author,
    authorAvatar:  row.author_avatar,
    date:          row.date,
    readTime:      row.read_time,
    views:         row.views,
    shares:        row.shares || 0,
    bounceRate:    row.bounce_rate || 0,
    thumbnail:     row.thumbnail,
    tags:          JSON.parse(row.tags || '[]'),
    isFeatured:    row.is_featured === 1,
    isHot:         row.is_hot === 1,
    status:        row.status,
    commentCount:  stmt.countComments.get(row.id).c,
  };
  if (full) {
    art.content = row.content;
  } else {
    art.summary = stripHtml(row.content).slice(0, 120) + '...';
  }
  return art;
}

// Full fields cho admin (bao gom draft, deleted_at)
function formatArticleAdmin(row) {
  if (!row) return null;
  var art = formatArticle(row, true);
  art.deletedAt = row.deleted_at;
  return art;
}

// paginate dung LIMIT/OFFSET - chi can truyen total rieng
function paginateResult(items, total, page, limit) {
  return {
    items: items,
    total: total,
    page:  page,
    pages: Math.ceil(total / limit) || 1,
    limit: limit,
  };
}

function safeUser(row) {
  if (!row) return null;
  return {
    id:         row.id,
    name:       row.name,
    email:      row.email,
    avatar:     row.avatar,
    role:       row.role || 'user',
    status:     row.status || 'active',
    phone:      row.phone || null,
    createdAt:  row.created_at,
    updatedAt:  row.updated_at,
  };
}

function safeUserAdmin(row) {
  if (!row) return null;
  return Object.assign(safeUser(row), {
    lastIp:     row.last_ip || null,
    lastDevice: row.last_device || null,
  });
}

// Vietnamese slug: map dau -> khong dau
function vn2slug(str) {
  var map = {
    'à':'a','á':'a','ả':'a','ã':'a','ạ':'a',
    'ă':'a','ắ':'a','ặ':'a','ằ':'a','ẳ':'a','ẵ':'a',
    'â':'a','ấ':'a','ầ':'a','ẩ':'a','ẫ':'a','ậ':'a',
    'đ':'d',
    'è':'e','é':'e','ẻ':'e','ẽ':'e','ẹ':'e',
    'ê':'e','ế':'e','ề':'e','ể':'e','ễ':'e','ệ':'e',
    'ì':'i','í':'i','ỉ':'i','ĩ':'i','ị':'i',
    'ò':'o','ó':'o','ỏ':'o','õ':'o','ọ':'o',
    'ô':'o','ố':'o','ồ':'o','ổ':'o','ỗ':'o','ộ':'o',
    'ơ':'o','ớ':'o','ờ':'o','ở':'o','ỡ':'o','ợ':'o',
    'ù':'u','ú':'u','ủ':'u','ũ':'u','ụ':'u',
    'ư':'u','ứ':'u','ừ':'u','ử':'u','ữ':'u','ự':'u',
    'ỳ':'y','ý':'y','ỷ':'y','ỹ':'y','ỵ':'y',
  };
  return str
    .toLowerCase()
    .split('').map(function(c) { return map[c] || c; }).join('')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function generateSlug(title) {
  var base = vn2slug(title) || 'bai-viet';
  return base + '-' + Date.now();
}

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

function requireAuth(req, res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res_err(res, 'Can dang nhap', 401);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res_err(res, 'Token khong hop le hoac da het han', 401);
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, function() {
    var user = stmt.userById.get(req.user.id);
    if (!user || user.role !== 'admin') return res_err(res, 'Khong co quyen truy cap', 403);
    next();
  });
}

// Optional auth: neu co token thi gan req.user, khong co thi bo qua
function optionalAuth(req, _res, next) {
  var token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch(e) { /* bo qua */ }
  }
  next();
}

// Rate limiter (in-memory, production: dung Redis)
var rateLimitMap = {};
function rateLimit(maxPerMin) {
  return function(req, res, next) {
    var key = (req.ip || 'unknown') + ':' + req.path;
    var now = Date.now();
    if (!rateLimitMap[key]) rateLimitMap[key] = [];
    rateLimitMap[key] = rateLimitMap[key].filter(function(t) { return now - t < 60000; });
    if (rateLimitMap[key].length >= maxPerMin) {
      return res_err(res, 'Qua nhieu request. Vui long thu lai sau.', 429);
    }
    rateLimitMap[key].push(now);
    next();
  };
}
setInterval(function() { rateLimitMap = {}; }, 300000);

// ============================================================
// ROUTES - HEALTH (admin only)
// ============================================================

app.get('/health', requireAdmin, function(_req, res) {
  res.json({
    status:   'ok',
    articles: db.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').get().c,
    users:    db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    comments: db.prepare('SELECT COUNT(*) as c FROM comments WHERE deleted_at IS NULL').get().c,
    uptime:   Math.floor(process.uptime()) + 's',
    time:     new Date().toISOString(),
  });
});

// ============================================================
// ROUTES - UPLOAD
// ============================================================

app.post('/api/upload', requireAuth, upload.single('file'), function(req, res) {
  if (!req.file) return res_err(res, 'Khong co file hoac dinh dang khong hop le');
  var url = (process.env.BASE_URL || 'http://localhost:' + PORT) + '/uploads/' + req.file.filename;
  res_ok(res, { url: url, filename: req.file.filename }, 201);
});

// ============================================================
// ROUTES - CATEGORIES
// ============================================================

app.get('/api/categories', function(_req, res) {
  var counts = db.prepare("SELECT category, COUNT(*) as c FROM articles WHERE status='published' AND deleted_at IS NULL GROUP BY category").all();
  var countMap = {};
  counts.forEach(function(r) { countMap[r.category] = r.c; });
  res_ok(res, CATEGORIES.map(function(cat) {
    return { id: cat.id, label: cat.label, count: countMap[cat.id] || 0 };
  }));
});

// ============================================================
// ROUTES - ARTICLES (PUBLIC)
// ============================================================

// GET /api/articles
app.get('/api/articles', function(req, res) {
  var page     = Math.max(1, parseInt(req.query.page)  || 1);
  var limit    = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
  var category = req.query.category;
  var featured = req.query.featured;
  var hot      = req.query.hot;
  var sort     = req.query.sort;
  var offset   = (page - 1) * limit;

  var where = ["status='published'", "deleted_at IS NULL"];
  var args  = [];

  if (category && VALID_CATEGORY_IDS.has(category)) {
    where.push('category=?'); args.push(category);
  }
  if (featured === 'true') where.push('is_featured=1');
  if (hot === 'true')      where.push('is_hot=1');

  var orderBy = (sort === 'views') ? 'views DESC' : 'date DESC';
  var baseSQL = 'FROM articles WHERE ' + where.join(' AND ');

  var total = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get.apply(null, args).c;
  var rows  = db.prepare('SELECT * ' + baseSQL + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?')
                .all.apply(null, args.concat([limit, offset]))
                .map(function(r) { return formatArticle(r, false); });

  res_ok(res, paginateResult(rows, total, page, limit));
});

// GET /api/articles/trending
app.get('/api/articles/trending', function(req, res) {
  var limit = Math.min(20, parseInt(req.query.limit) || 5);
  res_ok(res, stmt.trending.all(limit).map(function(r) { return formatArticle(r, false); }));
});

// GET /api/articles/search  -- phai truoc /:id
app.get('/api/articles/search', function(req, res) {
  var q        = (req.query.q || '').trim();
  var page     = Math.max(1, parseInt(req.query.page)  || 1);
  var limit    = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  var category = req.query.category;
  var sort     = req.query.sort;
  var offset   = (page - 1) * limit;

  if (!q) return res_ok(res, paginateResult([], 0, 1, limit));
  if (q.length > 200) return res_err(res, 'Query qua dai');

  var like = '%' + q + '%';
  var rows = stmt.searchArticles.all(like, like, like, like);

  if (category && category !== 'all' && VALID_CATEGORY_IDS.has(category)) {
    rows = rows.filter(function(r) { return r.category === category; });
  }
  if (sort === 'views') {
    rows.sort(function(a, b) { return b.views - a.views; });
  }

  var total = rows.length;
  var items = rows.slice(offset, offset + limit).map(function(r) { return formatArticle(r, false); });
  res_ok(res, paginateResult(items, total, page, limit));
});

// POST /api/search  -- AI semantic search (fulltext fallback)
app.post('/api/search', rateLimit(20), function(req, res) {
  var q        = (req.body.q || '').trim();
  var page     = Math.max(1, parseInt(req.body.page)  || 1);
  var limit    = Math.min(20, Math.max(1, parseInt(req.body.limit) || 10));
  var category = req.body.category;
  var offset   = (page - 1) * limit;

  if (!q) return res_ok(res, paginateResult([], 0, 1, limit));
  if (q.length > 300) return res_err(res, 'Query qua dai');

  // Fulltext search: tach query thanh tung tu, tim tat ca
  var terms = q.toLowerCase().split(/\s+/).filter(function(t) { return t.length > 1; }).slice(0, 5);
  var like  = '%' + q + '%';

  var rows = stmt.searchArticles.all(like, like, like, like);

  // Boost score: cong diem cho moi term match
  rows = rows.map(function(r) {
    var score = 0;
    var titleLow = (r.title || '').toLowerCase();
    var exLow    = (r.excerpt || '').toLowerCase();
    terms.forEach(function(t) {
      if (titleLow.includes(t))  score += 3;
      if (exLow.includes(t))     score += 1;
      if ((r.tags || '').toLowerCase().includes(t)) score += 2;
    });
    return { row: r, score: score };
  });
  rows.sort(function(a, b) { return b.score - a.score; });

  if (category && category !== 'all' && VALID_CATEGORY_IDS.has(category)) {
    rows = rows.filter(function(r) { return r.row.category === category; });
  }

  var total = rows.length;
  var items = rows.slice(offset, offset + limit).map(function(r) { return formatArticle(r.row, false); });
  res_ok(res, paginateResult(items, total, page, limit));
});

// GET /api/articles/:id  (slug hoac id)
app.get('/api/articles/:id', optionalAuth, function(req, res) {
  var id  = parseInt(req.params.id);
  var row = isNaN(id) ? stmt.articleBySlug.get(req.params.id) : stmt.articleById.get(id);
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);

  // Dedup view: 1 IP chi tinh 1 view / gio
  var ip = req.ip || 'unknown';
  var alreadyViewed = stmt.hasViewedRecently.get(row.id, ip);
  if (!alreadyViewed) {
    stmt.incrViews.run(row.id);
    stmt.logView.run(row.id, (req.user && req.user.id) || null, ip);
    // Cap nhat interest neu dang nhap
    if (req.user) {
      stmt.upsertInterest.run(req.user.id, row.category);
    }
  }

  res_ok(res, formatArticle(row, true));
});

// GET /api/articles/:id/related
app.get('/api/articles/:id/related', function(req, res) {
  var row = stmt.articleById.get(parseInt(req.params.id));
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);
  res_ok(res, stmt.related.all(row.category, row.id).map(function(r) { return formatArticle(r, false); }));
});

// GET /api/articles/:id/comments
app.get('/api/articles/:id/comments', function(req, res) {
  var id     = parseInt(req.params.id);
  var page   = Math.max(1, parseInt(req.query.page)  || 1);
  var limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  var offset = (page - 1) * limit;

  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);

  var total = stmt.countComments.get(id).c;
  var items = stmt.getComments.all(id, limit, offset);
  res_ok(res, paginateResult(items, total, page, limit));
});

// POST /api/articles/:id/comments
app.post('/api/articles/:id/comments', requireAuth, rateLimit(10), function(req, res) {
  var id      = parseInt(req.params.id);
  var content = (req.body.content || '').trim();
  if (!content)              return res_err(res, 'Noi dung binh luan khong duoc de trong');
  if (content.length > 2000) return res_err(res, 'Binh luan qua dai (toi da 2000 ky tu)');

  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);

  var info = stmt.addComment.run(id, req.user.id, content);
  var user = stmt.userById.get(req.user.id);
  res_ok(res, {
    id:          info.lastInsertRowid,
    content:     content,
    created_at:  new Date().toISOString(),
    user_id:     user.id,
    user_name:   user.name,
    user_avatar: user.avatar,
  }, 201);
});

// DELETE /api/comments/:id  (owner hoac admin)
app.delete('/api/comments/:id', requireAuth, function(req, res) {
  var id      = parseInt(req.params.id);
  var comment = stmt.commentById.get(id);
  if (!comment) return res_err(res, 'Binh luan khong ton tai', 404);

  var user = stmt.userById.get(req.user.id);
  var isOwner = comment.user_id === req.user.id;
  var isAdmin = user && user.role === 'admin';

  if (!isOwner && !isAdmin) return res_err(res, 'Khong co quyen xoa binh luan nay', 403);

  stmt.softDelComment.run(id);
  res_ok(res, { message: 'Da xoa binh luan', id: id });
});

// POST /api/articles/:id/share  (tang share count)
app.post('/api/articles/:id/share', function(req, res) {
  var id = parseInt(req.params.id);
  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);
  stmt.incrShares.run(id);
  res_ok(res, { id: id, shares: row.shares + 1 });
});

// ============================================================
// ROUTES - AUTH
// ============================================================

app.post('/api/auth/register', rateLimit(5), function(req, res) {
  var name     = (req.body.name     || '').trim().slice(0, 100);
  var email    = (req.body.email    || '').trim().toLowerCase().slice(0, 200);
  var password = (req.body.password || '');

  if (!name || !email || !password) return res_err(res, 'Vui long dien day du thong tin');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res_err(res, 'Email khong hop le');
  if (password.length < 8)  return res_err(res, 'Mat khau phai co it nhat 8 ky tu');
  if (password.length > 128) return res_err(res, 'Mat khau qua dai');
  if (stmt.userByEmail.get(email)) return res_err(res, 'Email da duoc su dung');

  var hashed = bcrypt.hashSync(password, 10);
  var avatar  = 'https://i.pravatar.cc/80?u=' + encodeURIComponent(email);
  var info    = stmt.insertUser.run(name, email, hashed, avatar);
  var user    = stmt.userById.get(info.lastInsertRowid);
  var token   = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res_ok(res, { token: token, user: safeUser(user) }, 201);
});

app.post('/api/auth/login', rateLimit(10), function(req, res) {
  var email    = (req.body.email    || '').trim().toLowerCase();
  var password = (req.body.password || '');
  if (!email || !password) return res_err(res, 'Vui long nhap email va mat khau');

  var user = stmt.userByEmail.get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res_err(res, 'Email hoac mat khau khong dung', 401);
  }
  if (user.status === 'banned') return res_err(res, 'Tai khoan da bi khoa', 403);

  // Cap nhat last_ip, last_device
  var device = (req.headers['user-agent'] || '').slice(0, 200);
  stmt.updateLastSeen.run(req.ip || null, device, user.id);

  // Role co trong JWT de frontend biet quyen
  var token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
  res_ok(res, { token: token, user: safeUser(user) });
});

app.post('/api/auth/forgot-password', rateLimit(3), function(req, res) {
  var email = (req.body.email || '').trim().toLowerCase();
  if (!email) return res_err(res, 'Vui long nhap email');
  // TODO: gui email that qua SendGrid / Nodemailer
  // Tra ve success du user co ton tai hay khong (tranh enum user)
  res_ok(res, { message: 'Neu email ton tai, link dat lai mat khau se duoc gui trong vai phut.' });
});

// ============================================================
// POST /api/auth/google  — Google Identity Services (popup flow)
// Frontend gui credential (ID token tu GIS), backend verify voi Google
// ============================================================
app.post('/api/auth/google', rateLimit(10), function(req, res) {
  var credential = (req.body.credential || '').trim();
  if (!credential) return res_err(res, 'Thieu Google credential');

  var verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);

  https.get(verifyUrl, function(r) {
    var raw = '';
    r.on('data', function(chunk) { raw += chunk; });
    r.on('end', function() {
      var payload;
      try { payload = JSON.parse(raw); } catch(e) { return res_err(res, 'Phan hoi Google khong hop le'); }

      if (payload.error || !payload.email) {
        return res_err(res, 'Token Google khong hop le: ' + (payload.error_description || payload.error || 'unknown'));
      }
      // Kiem tra audience neu da set GOOGLE_CLIENT_ID
      if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
        return res_err(res, 'Google client_id khong khop');
      }
      // email_verified phai la true
      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        return res_err(res, 'Email Google chua duoc xac minh');
      }

      var email  = payload.email.trim().toLowerCase().slice(0, 200);
      var name   = (payload.name  || email.split('@')[0]).trim().slice(0, 100);
      var avatar = payload.picture || null;

      // Tim user cu hoac tao moi
      var user = stmt.userByEmail.get(email);
      if (!user) {
        // Password ngau nhien — user nay chi login duoc bang Google
        var dummyPw = bcrypt.hashSync(Math.random().toString(36) + Date.now().toString(), 8);
        var genAvatar = avatar || ('https://i.pravatar.cc/80?u=' + encodeURIComponent(email));
        var info = db.prepare(
          "INSERT INTO users (name, email, password, avatar, role, status) VALUES (?, ?, ?, ?, 'user', 'active')"
        ).run(name, email, dummyPw, genAvatar);
        user = stmt.userById.get(info.lastInsertRowid);
      } else {
        // Cap nhat avatar Google neu user chua co avatar
        if (avatar && !user.avatar) {
          db.prepare("UPDATE users SET avatar=?, updated_at=datetime('now') WHERE id=?").run(avatar, user.id);
          user = stmt.userById.get(user.id);
        }
      }

      if (user.status === 'banned') return res_err(res, 'Tai khoan da bi khoa', 403);

      // Cap nhat last_ip, last_device
      var device = (req.headers['user-agent'] || '').slice(0, 200);
      stmt.updateLastSeen.run(req.ip || null, device, user.id);

      var token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      res_ok(res, { token: token, user: safeUser(user) });
    });
  }).on('error', function(e) {
    res_err(res, 'Khong ket noi duoc Google: ' + e.message);
  });
});

app.post('/api/auth/refresh', function(req, res) {
  var token = (req.body.token || '').trim();
  if (!token) return res_err(res, 'Thieu token', 401);
  try {
    var decoded  = jwt.verify(token, JWT_SECRET);
    var user     = stmt.userById.get(decoded.id);
    if (!user) return res_err(res, 'Tai khoan khong ton tai', 404);
    if (user.status === 'banned') return res_err(res, 'Tai khoan da bi khoa', 403);
    var newToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res_ok(res, { token: newToken, user: safeUser(user) });
  } catch (e) {
    return res_err(res, 'Token khong hop le', 401);
  }
});

app.get('/api/auth/me', requireAuth, function(req, res) {
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tai khoan khong ton tai', 404);
  // Kem theo interests
  var interests = stmt.getUserInterests.all(user.id).map(function(r) { return r.category; });
  var data = safeUser(user);
  data.interests = interests;
  res_ok(res, data);
});

app.put('/api/auth/me', requireAuth, function(req, res) {
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tai khoan khong ton tai', 404);
  var name   = ((req.body.name   || user.name  ) + '').trim().slice(0, 100);
  var avatar = ((req.body.avatar || user.avatar || '') + '').trim().slice(0, 500);
  stmt.updateProfile.run(name, avatar, req.user.id);
  res_ok(res, safeUser(stmt.userById.get(req.user.id)));
});

app.put('/api/auth/me/password', requireAuth, function(req, res) {
  var currentPassword = req.body.currentPassword || '';
  var newPassword     = req.body.newPassword     || '';
  if (!currentPassword || !newPassword) return res_err(res, 'Vui long nhap day du');
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tai khoan khong ton tai', 404);
  if (!bcrypt.compareSync(currentPassword, user.password)) return res_err(res, 'Mat khau hien tai khong dung');
  if (newPassword.length < 8)   return res_err(res, 'Mat khau moi phai co it nhat 8 ky tu');
  if (newPassword.length > 128) return res_err(res, 'Mat khau qua dai');
  stmt.updatePw.run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res_ok(res, { message: 'Doi mat khau thanh cong' });
});

// ============================================================
// ROUTES - BOOKMARKS
// ============================================================

app.get('/api/user/bookmarks', requireAuth, function(req, res) {
  var ids = stmt.getBookmarks.all(req.user.id).map(function(r) { return r.article_id; });
  if (!ids.length) return res_ok(res, []);
  var ph   = ids.map(function() { return '?'; }).join(',');
  var rows = db.prepare('SELECT * FROM articles WHERE id IN (' + ph + ') AND deleted_at IS NULL')
               .all.apply(null, ids);
  res_ok(res, rows.map(function(r) { return formatArticle(r, false); }));
});

app.post('/api/user/bookmarks/:id', requireAuth, function(req, res) {
  var aid = parseInt(req.params.id);
  if (!stmt.articleById.get(aid)) return res_err(res, 'Bai viet khong ton tai', 404);
  if (stmt.hasBookmark.get(req.user.id, aid)) {
    stmt.delBookmark.run(req.user.id, aid);
    res_ok(res, { id: aid, saved: false });
  } else {
    stmt.addBookmark.run(req.user.id, aid);
    res_ok(res, { id: aid, saved: true });
  }
});

// ============================================================
// ROUTES - NOTIFICATIONS
// ============================================================

app.get('/api/user/notifications', requireAuth, function(req, res) {
  var row = stmt.getNotif.get(req.user.id);
  if (row) {
    res_ok(res, { email: row.email_on===1, breaking: row.breaking===1, weekly: row.weekly===1, marketing: row.marketing===1 });
  } else {
    res_ok(res, { email: true, breaking: true, weekly: false, marketing: false });
  }
});

app.put('/api/user/notifications', requireAuth, function(req, res) {
  var cur = stmt.getNotif.get(req.user.id) || { email_on:1, breaking:1, weekly:0, marketing:0 };
  function b(val, fallback) { return val === undefined ? fallback : (val ? 1 : 0); }
  var eo = b(req.body.email,     cur.email_on);
  var br = b(req.body.breaking,  cur.breaking);
  var wk = b(req.body.weekly,    cur.weekly);
  var mk = b(req.body.marketing, cur.marketing);
  stmt.upsertNotif.run(req.user.id, eo, br, wk, mk);
  res_ok(res, { email: eo===1, breaking: br===1, weekly: wk===1, marketing: mk===1 });
});

// ============================================================
// GET /api/user/stats  — thong ke profile overview
// ============================================================
app.get('/api/user/stats', requireAuth, function(req, res) {
  var uid = req.user.id;
  var bookmarks = db.prepare('SELECT COUNT(*) as c FROM bookmarks WHERE user_id=?').get(uid).c;
  var comments  = db.prepare('SELECT COUNT(*) as c FROM comments  WHERE user_id=? AND deleted_at IS NULL').get(uid).c;
  var views     = db.prepare('SELECT COUNT(*) as c FROM view_log  WHERE user_id=?').get(uid).c;
  // Bai doc gan day (5 bai cuoi trong view_log)
  var recent    = db.prepare(`
    SELECT DISTINCT vl.article_id, a.title, a.category_label, a.thumbnail, a.date
    FROM view_log vl
    JOIN articles a ON a.id = vl.article_id AND a.deleted_at IS NULL
    WHERE vl.user_id = ?
    ORDER BY vl.created_at DESC
    LIMIT 5
  `).all(uid);
  res_ok(res, {
    views:     views,
    bookmarks: bookmarks,
    comments:  comments,
    recent:    recent.map(function(r) {
      return { id: r.article_id, title: r.title, cat: r.category_label, thumbnail: r.thumbnail, date: r.date };
    }),
  });
});

// ============================================================
// ROUTES - NEWSLETTER
// ============================================================

app.post('/api/newsletter/subscribe', rateLimit(5), function(req, res) {
  var email     = (req.body.email     || '').trim().toLowerCase().slice(0, 200);
  var frequency = req.body.frequency  || 'daily';
  var topics    = req.body.topics     || [];

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res_err(res, 'Email khong hop le');
  if (!['daily','weekly','breaking'].includes(frequency)) frequency = 'daily';

  var topicsJson = JSON.stringify(Array.isArray(topics) ? topics.slice(0,10) : []);
  if (stmt.nlByEmail.get(email)) {
    stmt.nlUpdate.run(frequency, topicsJson, email);
    return res_ok(res, { message: 'Da cap nhat cai dat ban tin.', email: email });
  }
  stmt.nlInsert.run(email, frequency, topicsJson);
  res_ok(res, { message: 'Dang ky thanh cong! Vui long kiem tra email de xac nhan.', email: email }, 201);
});

// ============================================================
// ROUTES - ADMIN
// ============================================================

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, function(_req, res) {
  var totalViews = db.prepare('SELECT SUM(views) as v FROM articles WHERE deleted_at IS NULL').get().v || 0;
  // Weekly views: tong views 7 ngay qua tu view_log
  var weeklyRows = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as cnt
    FROM view_log
    WHERE created_at >= datetime('now', '-7 days')
    GROUP BY day ORDER BY day ASC
  `).all();

  res_ok(res, {
    articles:    db.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').get().c,
    drafts:      db.prepare("SELECT COUNT(*) as c FROM articles WHERE status='draft' AND deleted_at IS NULL").get().c,
    users:       db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    comments:    db.prepare('SELECT COUNT(*) as c FROM comments WHERE deleted_at IS NULL').get().c,
    newsletters: db.prepare('SELECT COUNT(*) as c FROM newsletters').get().c,
    bookmarks:   db.prepare('SELECT COUNT(*) as c FROM bookmarks').get().c,
    totalViews:  totalViews,
    weeklyViews: weeklyRows,
    topArticles: db.prepare('SELECT id,title,views,shares,thumbnail,category_label FROM articles WHERE deleted_at IS NULL ORDER BY views DESC LIMIT 5').all(),
    recentUsers: db.prepare('SELECT id,name,email,avatar,role,status,created_at FROM users ORDER BY id DESC LIMIT 5').all(),
  });
});

// GET /api/admin/traffic?period=7d|30d
app.get('/api/admin/traffic', requireAdmin, function(req, res) {
  var period = req.query.period === '30d' ? '30 days' : '7 days';
  var rows = db.prepare(`
    SELECT date(created_at) as day, COUNT(*) as views
    FROM view_log
    WHERE created_at >= datetime('now', '-${period}')
    GROUP BY day
    ORDER BY day ASC
  `).all();
  res_ok(res, rows);
});

// GET /api/admin/articles
app.get('/api/admin/articles', requireAdmin, function(req, res) {
  var page     = Math.max(1, parseInt(req.query.page)  || 1);
  var limit    = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  var status   = req.query.status;
  var category = req.query.category;
  var offset   = (page - 1) * limit;

  var where = ['1=1'];
  var args  = [];

  // Admin co the xem ca deleted
  if (req.query.includeDeleted !== 'true') where.push('deleted_at IS NULL');
  if (status && VALID_STATUSES.has(status))             { where.push('status=?'); args.push(status); }
  if (category && VALID_CATEGORY_IDS.has(category))     { where.push('category=?'); args.push(category); }

  var baseSQL = 'FROM articles WHERE ' + where.join(' AND ');
  var total   = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get.apply(null, args).c;
  var rows    = db.prepare('SELECT * ' + baseSQL + ' ORDER BY date DESC LIMIT ? OFFSET ?')
                  .all.apply(null, args.concat([limit, offset]))
                  .map(formatArticleAdmin);

  res_ok(res, paginateResult(rows, total, page, limit));
});

// POST /api/admin/articles
app.post('/api/admin/articles', requireAdmin, function(req, res) {
  var b = req.body;
  if (!b.title || !b.category) return res_err(res, 'Thieu title hoac category');
  if (!VALID_CATEGORY_IDS.has(b.category)) return res_err(res, 'Category khong hop le');

  var slug = generateSlug(b.title);
  var info = db.prepare(`
    INSERT INTO articles
      (slug,category,category_label,title,excerpt,content,author,author_avatar,
       date,read_time,thumbnail,tags,is_featured,is_hot,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    slug,
    b.category,
    b.categoryLabel || (CATEGORIES.find(function(c) { return c.id === b.category; }) || {}).label || b.category,
    b.title.slice(0, 500),
    (b.excerpt || '').slice(0, 1000),
    b.content || '',
    (b.author || 'Admin').slice(0, 100),
    (b.authorAvatar || '').slice(0, 500),
    b.date || new Date().toISOString(),
    parseInt(b.readTime) || 4,
    (b.thumbnail || '').slice(0, 500),
    JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 10) : []),
    b.isFeatured ? 1 : 0,
    b.isHot ? 1 : 0,
    VALID_STATUSES.has(b.status) ? b.status : 'published'
  );

  res_ok(res, formatArticleAdmin(stmt.articleById.get(info.lastInsertRowid)), 201);
});

// PUT /api/admin/articles/:id
app.put('/api/admin/articles/:id', requireAdmin, function(req, res) {
  var id  = parseInt(req.params.id);
  var row = db.prepare('SELECT * FROM articles WHERE id=?').get(id); // cho phep edit ca archived
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);

  var b = req.body;
  if (b.category && !VALID_CATEGORY_IDS.has(b.category)) return res_err(res, 'Category khong hop le');
  if (b.status   && !VALID_STATUSES.has(b.status))       return res_err(res, 'Status khong hop le');

  var newTitle = (b.title || row.title).slice(0, 500);
  // Chi tai tao slug neu title thay doi
  var newSlug  = (b.title && b.title !== row.title) ? generateSlug(b.title) : row.slug;

  db.prepare(`
    UPDATE articles SET
      slug=?, category=?, category_label=?, title=?, excerpt=?, content=?,
      author=?, author_avatar=?, date=?, read_time=?, thumbnail=?,
      tags=?, is_featured=?, is_hot=?, status=?, bounce_rate=?
    WHERE id=?
  `).run(
    newSlug,
    b.category      || row.category,
    b.categoryLabel || row.category_label,
    newTitle,
    b.excerpt       !== undefined ? b.excerpt.slice(0, 1000) : row.excerpt,
    b.content       !== undefined ? b.content : row.content,
    (b.author       || row.author).slice(0, 100),
    b.authorAvatar  !== undefined ? b.authorAvatar.slice(0, 500) : row.author_avatar,
    b.date          || row.date,
    parseInt(b.readTime) || row.read_time,
    b.thumbnail     !== undefined ? b.thumbnail.slice(0, 500) : row.thumbnail,
    b.tags          ? JSON.stringify(b.tags.slice(0, 10)) : row.tags,
    b.isFeatured    !== undefined ? (b.isFeatured ? 1 : 0) : row.is_featured,
    b.isHot         !== undefined ? (b.isHot      ? 1 : 0) : row.is_hot,
    VALID_STATUSES.has(b.status) ? b.status : row.status,
    b.bounceRate    !== undefined ? parseFloat(b.bounceRate) || 0 : row.bounce_rate,
    id
  );

  res_ok(res, formatArticleAdmin(db.prepare('SELECT * FROM articles WHERE id=?').get(id)));
});

// DELETE /api/admin/articles/:id  (soft delete)
app.delete('/api/admin/articles/:id', requireAdmin, function(req, res) {
  var id  = parseInt(req.params.id);
  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Khong tim thay bai viet', 404);

  if (req.query.hard === 'true') {
    // Hard delete chi khi truyen ?hard=true
    stmt.hardDelete.run(id);
    res_ok(res, { message: 'Da xoa vinh vien bai viet', id: id });
  } else {
    stmt.softDelete.run(id);
    res_ok(res, { message: 'Da xoa bai viet (co the khoi phuc)', id: id });
  }
});

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, function(req, res) {
  var page   = Math.max(1, parseInt(req.query.page)  || 1);
  var limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  var offset = (page - 1) * limit;

  var where = ['1=1'];
  var args  = [];

  if (req.query.role   && VALID_ROLES.has(req.query.role))               { where.push('role=?');   args.push(req.query.role); }
  if (req.query.status && VALID_USER_STATUSES.has(req.query.status))     { where.push('status=?'); args.push(req.query.status); }

  var baseSQL = 'FROM users WHERE ' + where.join(' AND ');
  var total   = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get.apply(null, args).c;
  var rows    = db.prepare('SELECT * ' + baseSQL + ' ORDER BY id DESC LIMIT ? OFFSET ?')
                  .all.apply(null, args.concat([limit, offset]))
                  .map(safeUserAdmin);

  res_ok(res, paginateResult(rows, total, page, limit));
});

// PATCH /api/admin/users/:id
app.patch('/api/admin/users/:id', requireAdmin, function(req, res) {
  var id   = parseInt(req.params.id);
  var user = stmt.userById.get(id);
  if (!user) return res_err(res, 'Nguoi dung khong ton tai', 404);

  var b = req.body;
  var name   = (b.name   !== undefined) ? (b.name + '').trim().slice(0, 100)   : user.name;
  var email  = (b.email  !== undefined) ? (b.email + '').trim().toLowerCase().slice(0, 200) : user.email;
  var role   = (b.role   !== undefined && VALID_ROLES.has(b.role))         ? b.role   : user.role;
  var status = (b.status !== undefined && VALID_USER_STATUSES.has(b.status)) ? b.status : user.status;
  var phone  = (b.phone  !== undefined) ? (b.phone + '').trim().slice(0, 20) : user.phone;

  // Kiem tra email trung neu thay doi
  if (email !== user.email && stmt.userByEmail.get(email)) {
    return res_err(res, 'Email da duoc su dung boi tai khoan khac');
  }

  db.prepare(`
    UPDATE users SET name=?, email=?, role=?, status=?, phone=?, updated_at=datetime('now') WHERE id=?
  `).run(name, email, role, status, phone, id);

  res_ok(res, safeUserAdmin(stmt.userById.get(id)));
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', requireAdmin, function(req, res) {
  var id   = parseInt(req.params.id);
  var user = stmt.userById.get(id);
  if (!user) return res_err(res, 'Nguoi dung khong ton tai', 404);
  if (user.role === 'admin') return res_err(res, 'Khong the xoa tai khoan admin', 403);

  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res_ok(res, { message: 'Da xoa nguoi dung', id: id });
});

// GET /api/admin/settings
app.get('/api/admin/settings', requireAdmin, function(_req, res) {
  var rows = db.prepare('SELECT key, value FROM site_settings').all();
  var settings = {};
  rows.forEach(function(r) { settings[r.key] = r.value; });
  res_ok(res, settings);
});

// PUT /api/admin/settings
app.put('/api/admin/settings', requireAdmin, function(req, res) {
  var allowed = ['siteName', 'domain', 'email', 'description', 'logoUrl', 'timezone'];
  var upsert  = db.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  var updated = {};

  db.transaction(function() {
    allowed.forEach(function(key) {
      if (req.body[key] !== undefined) {
        var val = (req.body[key] + '').trim().slice(0, 500);
        upsert.run(key, val);
        updated[key] = val;
      }
    });
  })();

  res_ok(res, updated);
});

// ============================================================
// 404 & GRACEFUL SHUTDOWN
// ============================================================

app.use(function(_req, res) { res_err(res, 'Route khong ton tai', 404); });

var server = app.listen(PORT, function() {
  var c = db.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').get().c;
  console.log('TechPulse API  -> http://localhost:' + PORT);
  console.log('SQLite DB      -> ' + DB_PATH);
  console.log('Bai viet       -> ' + c);
  console.log('JWT expires    -> ' + JWT_EXPIRES);
  // KHONG log password o day
});

function shutdown() {
  console.log('[shutdown] Dong ket noi...');
  server.close(function() {
    db.close();
    console.log('[shutdown] Done.');
    process.exit(0);
  });
  // Force exit sau 10s neu hang
  setTimeout(function() { process.exit(1); }, 10000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
