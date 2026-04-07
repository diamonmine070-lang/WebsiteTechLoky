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

// Tạo thư mục uploads nếu chưa có
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors({
  origin: function(origin, cb) {
    // Cho phép request không có origin (curl, mobile app, same-origin)
    if (!origin) return cb(null, true);
    // Nếu chưa set hoặc là '*' -> cho phep tat ca
    if (!ALLOWED_ORIGINS.length) return cb(null, true);
    if (ALLOWED_ORIGINS.includes('*')) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin không được phép'));
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
    cb(ok ? null : new Error('Chỉ chấp nhận file ảnh (jpg, png, gif, webp)'), ok);
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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    article_id   INTEGER NOT NULL,
    user_id      INTEGER,
    ip           TEXT,
    user_agent   TEXT,
    duration_sec INTEGER DEFAULT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
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

// Them cac column moi vao view_log neu chua co
var existingVLCols = db.pragma('table_info(view_log)').map(function(c) { return c.name; });
if (!existingVLCols.includes('user_id'))      db.exec('ALTER TABLE view_log ADD COLUMN user_id INTEGER');
if (!existingVLCols.includes('user_agent'))   db.exec('ALTER TABLE view_log ADD COLUMN user_agent TEXT');
if (!existingVLCols.includes('duration_sec')) db.exec('ALTER TABLE view_log ADD COLUMN duration_sec INTEGER DEFAULT NULL');

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
      title:'"Thanh trì" cuối cùng ngăn người dùng iPhone chuyển sang Galaxy vừa bị phá vỡ',
      excerpt:'Samsung Galaxy S26 hỗ trợ Quick Share với iPhone, không cần app trung gian.',
      content:'<p>Samsung vừa công bố tính năng Quick Share mở rộng trên Galaxy S26, cho phép chia sẻ file trực tiếp với iPhone. Tốc độ đạt 480 Mbps qua Wi-Fi Direct + Bluetooth LE.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-25T09:00:00Z', read_time:4, views:18420,
      thumbnail:'https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=800&q=80',
      tags:JSON.stringify(['Samsung','Quick Share','iPhone','Galaxy S26']), is_featured:1, is_hot:1,
    },
    {
      slug:'openai-ket-thuc-sora-disney', category:'ai', category_label:'AI',
      title:'OpenAI đột ngột khai tử công cụ tạo video Sora, Disney mất 1 tỷ USD',
      excerpt:'Quyết định đóng cửa Sora chỉ sau 4 tháng khiến nhiều đối tác phải xem xét lại kế hoạch.',
      content:'<p>OpenAI ngừng dịch vụ Sora chỉ 4 tháng sau khi ra mắt. Chi phí mỗi phút video gần 40 USD khiến mô hình kinh doanh không khả thi.</p>',
      author:'Thanh Truc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-25T07:30:00Z', read_time:3, views:24103,
      thumbnail:'https://images.unsplash.com/photo-1677442135703-1787eea5ce01?w=800&q=80',
      tags:JSON.stringify(['OpenAI','Sora','AI','Disney']), is_featured:1, is_hot:1,
    },
    {
      slug:'intel-core-ultra-7-270k-plus', category:'tin-ict', category_label:'Tin ICT',
      title:'Intel Core Ultra 7 270K Plus: Lời khẳng định "Chúng tôi đã trở lại"',
      excerpt:'Core Ultra 7 270K Plus cải thiện hiệu năng gaming đáng kể so với thế hệ trước.',
      content:'<p>Intel ra mắt Core Ultra 7 270K Plus, xung boost 6.2 GHz. Vượt Ryzen 9 9950X 8–12% trong gaming 1080p.</p>',
      author:'Duc Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-23T10:15:00Z', read_time:5, views:11250,
      thumbnail:'https://images.unsplash.com/photo-1591370874773-6702e8f12fd8?w=800&q=80',
      tags:JSON.stringify(['Intel','CPU','Gaming','Arrow Lake']), is_featured:0, is_hot:0,
    },
    {
      slug:'honor-top3-antutu-2026', category:'mobile', category_label:'Mobile',
      title:'HONOR trở lại mạnh mẽ: Top 3 model thống trị bảng xếp hạng AnTuTu',
      excerpt:'HONOR đang khiến cả thị trường smartphone phải ngoái nhìn với màn lột xác ngoạn mục.',
      content:'<p>HONOR lần đầu có ba model lọt top 5 AnTuTu cùng tháng. Magic7 Pro, Magic7 RSR và GT Neo dẫn đầu phân khúc tương ứng.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-23T08:00:00Z', read_time:3, views:9870,
      thumbnail:'https://images.unsplash.com/photo-1607252650355-f7fd0460ccdb?w=800&q=80',
      tags:JSON.stringify(['HONOR','AnTuTu','Smartphone','Android']), is_featured:0, is_hot:0,
    },
    {
      slug:'microsoft-don-dep-copilot-windows-11', category:'internet', category_label:'Internet',
      title:'Microsoft dọn dẹp mớ bòng bong AI trên Windows 11',
      excerpt:'Sau nhiều năm nhồi nhét Copilot vào mọi ngóc ngách, Microsoft thừa nhận sai lầm.',
      content:'<p>Microsoft gộp toàn bộ điểm AI trên Windows 11 thành một Copilot duy nhất sau phản hồi tiêu cực từ người dùng toàn cầu.</p>',
      author:'Lan Anh', author_avatar:'https://i.pravatar.cc/40?img=44',
      date:'2026-03-24T11:00:00Z', read_time:4, views:15600,
      thumbnail:'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=800&q=80',
      tags:JSON.stringify(['Microsoft','Windows 11','Copilot','AI']), is_featured:0, is_hot:1,
    },
    {
      slug:'macbook-neo-8gb-60-apps', category:'do-choi-so', category_label:'Đồ chơi số',
      title:'MacBook Neo 8GB mở 60 ứng dụng cùng lúc không sập, laptop Windows sập màn hình',
      excerpt:'Hardware Canucks thử nghiệm thực tế cho kết quả bất ngờ về khả năng quản lý RAM.',
      content:'<p>Hardware Canucks mở đồng thời 60 app trên MacBook Neo 8GB và laptop Windows 16GB. Apple unified memory xử lý mượt; Windows crash ở app thứ 47.</p>',
      author:'Duc Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-24T09:30:00Z', read_time:3, views:22400,
      thumbnail:'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80',
      tags:JSON.stringify(['MacBook','Apple','RAM','Benchmark']), is_featured:0, is_hot:0,
    },
    {
      slug:'bitcoin-184ty-mot-ngay-mat-sach', category:'tra-da-cn', category_label:'Trà đá CN',
      title:'Người đào được 184 tỷ Bitcoin trong một ngày và mất sạch chỉ sau vài giờ',
      excerpt:'Sự cố suýt khai tử Bitcoin ngay từ giai đoạn mới khai sinh.',
      content:'<p>Năm 2010, lỗ hổng code Bitcoin cho phép tạo ra 184 tỷ BTC trong một block. Satoshi và cộng đồng emergency fork trong 5 giờ.</p>',
      author:'Thanh Truc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-23T14:00:00Z', read_time:6, views:31800,
      thumbnail:'https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=800&q=80',
      tags:JSON.stringify(['Bitcoin','Crypto','Lich su','Satoshi']), is_featured:0, is_hot:0,
    },
    {
      slug:'suzuki-haojue-uhr350-honda-adv350', category:'xe', category_label:'Xe',
      title:'Suzuki Haojue UHR350: Đủ sức đánh bại Honda ADV350 và Yamaha XMAX?',
      excerpt:'Mẫu xe tay ga côn lai 350cc mới với nền tảng kỹ thuật Suzuki, giá cạnh tranh.',
      content:'<p>Suzuki Haojue UHR350 ra mắt Đông Nam Á, giá dự kiến 85–90 triệu đồng tại Việt Nam. Động cơ 350cc DOHC 4 van, 29 mã lực, ABS 2 kênh.</p>',
      author:'Quoc Huy', author_avatar:'https://i.pravatar.cc/40?img=55',
      date:'2026-03-24T13:00:00Z', read_time:4, views:8900,
      thumbnail:'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?w=800&q=80',
      tags:JSON.stringify(['Xe','Suzuki','Honda ADV','Yamaha XMAX']), is_featured:0, is_hot:0,
    },
    // ─── thêm 14 bài nữa ────────────────────────────────
    {
      slug:'google-gemini-2-flash-mien-phi', category:'ai', category_label:'AI',
      title:'Google mở miễn phí Gemini 2.0 Flash: Nhanh hơn GPT-4o, dùng không giới hạn',
      excerpt:'Google bất ngờ cho phép tất cả người dùng truy cập Gemini 2.0 Flash không cần trả phí.',
      content:'<p>Google vừa công bố Gemini 2.0 Flash sẽ miễn phí cho toàn bộ người dùng từ tháng 4/2026. Model mới xử lý văn bản, hình ảnh và audio trong một lần gọi API duy nhất, tốc độ phản hồi nhanh hơn GPT-4o khoảng 40% theo benchmark nội bộ.</p><p>Đây là động thái cạnh tranh trực tiếp với OpenAI và Anthropic khi thị trường AI đang bão hòa ở phân khúc trả phí. Google kỳ vọng thu hút developer quay về hệ sinh thái của mình.</p><h3>Điểm nổi bật</h3><p>Gemini 2.0 Flash hỗ trợ ngữ cảnh 1 triệu token, tích hợp Google Search theo thời gian thực và có thể tạo code, phân tích dữ liệu trong một session duy nhất.</p>',
      author:'Thanh Trúc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-04-01T08:00:00Z', read_time:4, views:41200,
      thumbnail:'https://images.unsplash.com/photo-1555255707-c07966088b7b?w=800&q=80',
      tags:JSON.stringify(['Google','Gemini','AI','Miễn phí']), is_featured:1, is_hot:1,
    },
    {
      slug:'apple-iphone-17-pro-camera-periscope', category:'mobile', category_label:'Mobile',
      title:'iPhone 17 Pro lộ thiết kế camera periscope 5x hoàn toàn mới, mỏng nhất từ trước đến nay',
      excerpt:'Rò rỉ từ chuỗi cung ứng cho thấy Apple sẽ trang bị zoom periscope cho cả iPhone 17 Pro và Pro Max.',
      content:'<p>Theo thông tin từ Ross Young và Ming-Chi Kuo, iPhone 17 Pro sẽ là thiết bị mỏng nhất Apple từng sản xuất với độ dày chỉ 7.2mm. Camera sau được thiết kế lại hoàn toàn với cụm periscope 5x cho cả hai model Pro.</p><p>Màn hình sẽ được nâng cấp lên OLED ProMotion 2000 nit với refresh rate thích ứng 1-120Hz. Chip A19 Pro sản xuất trên tiến trình 3nm thế hệ hai của TSMC hứa hẹn tiết kiệm năng lượng tốt hơn 20%.</p><h3>Giá dự kiến</h3><p>iPhone 17 Pro dự kiến khởi điểm từ 1.099 USD, tăng 100 USD so với thế hệ trước do chi phí camera mới.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-31T10:30:00Z', read_time:3, views:29800,
      thumbnail:'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=800&q=80',
      tags:JSON.stringify(['Apple','iPhone 17','Camera','Periscope']), is_featured:0, is_hot:1,
    },
    {
      slug:'tiktok-ban-my-chinh-thuc-quay-lai', category:'internet', category_label:'Internet',
      title:'TikTok chính thức quay lại Mỹ sau 3 tháng bị cấm, đạt 10 triệu lượt tải trong 24h',
      excerpt:'ByteDance đạt thỏa thuận với chính phủ Mỹ, TikTok được phép hoạt động trở lại với điều kiện chia sẻ dữ liệu.',
      content:'<p>Sau ba tháng bị gỡ khỏi App Store và Google Play tại Mỹ, TikTok chính thức quay trở lại sau khi ByteDance đạt thỏa thuận với Bộ Tư pháp Mỹ. Theo đó, dữ liệu người dùng Mỹ sẽ được lưu trữ hoàn toàn trên máy chủ Oracle tại Hoa Kỳ.</p><p>Trong 24 giờ đầu sau khi quay lại, TikTok đạt 10 triệu lượt tải — con số kỷ lục chưa từng có với bất kỳ app nào. Giá cổ phiếu Snap và Meta giảm lần lượt 8% và 4% sau thông tin này.</p>',
      author:'Lan Anh', author_avatar:'https://i.pravatar.cc/40?img=44',
      date:'2026-03-30T14:00:00Z', read_time:3, views:55600,
      thumbnail:'https://images.unsplash.com/photo-1611162616475-46b635cb6868?w=800&q=80',
      tags:JSON.stringify(['TikTok','Mỹ','ByteDance','Mạng xã hội']), is_featured:0, is_hot:1,
    },
    {
      slug:'nvidia-rtx-5090-review-viet-nam', category:'do-choi-so', category_label:'Đồ chơi số',
      title:'RTX 5090 về Việt Nam: Đỉnh cao GPU nhưng giá 90 triệu có đáng không?',
      excerpt:'Chúng tôi đã test RTX 5090 trong 2 tuần — đây là kết quả thực tế nhất bạn có thể tìm thấy.',
      content:'<p>RTX 5090 là card đồ họa nhanh nhất thế giới hiện tại, không có gì để bàn cãi. Trong các bài test 4K gaming, card này đạt trung bình 180fps ở Cyberpunk 2077 với tất cả setting max, vượt RTX 4090 khoảng 65%.</p><p>Tuy nhiên, với mức giá 90 triệu đồng tại thị trường Việt Nam, câu hỏi thực sự là: ai cần card này? Với 99% game thủ, RTX 5080 ở mức 45 triệu cho hiệu năng 85% mà giá chỉ bằng một nửa.</p><h3>Kết luận</h3><p>RTX 5090 dành cho content creator và AI researcher hơn là game thủ thông thường. Nếu bạn cần render video 8K hay chạy model AI local, đây là khoản đầu tư hợp lý.</p>',
      author:'Đức Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-29T09:00:00Z', read_time:6, views:19300,
      thumbnail:'https://images.unsplash.com/photo-1591488320449-011701bb6704?w=800&q=80',
      tags:JSON.stringify(['NVIDIA','RTX 5090','GPU','Review']), is_featured:0, is_hot:0,
    },
    {
      slug:'xe-dien-vinfast-vf9-ban-chay-dong-nam-a', category:'xe', category_label:'Xe',
      title:'VinFast VF 9 bán chạy nhất Đông Nam Á Q1/2026, vượt Tesla Model Y',
      excerpt:'VinFast lần đầu vượt Tesla tại thị trường Đông Nam Á với doanh số 12.400 xe trong quý đầu năm.',
      content:'<p>Theo báo cáo từ Hiệp hội Ô tô Đông Nam Á, VinFast VF 9 đạt doanh số 12.400 xe trong Q1/2026, vượt Tesla Model Y ở mức 11.800 xe. Đây là lần đầu tiên một thương hiệu xe điện Việt Nam dẫn đầu thị trường khu vực.</p><p>Giá VF 9 tại Indonesia và Thái Lan thấp hơn Model Y khoảng 15%, kết hợp với chính sách bảo hành pin 10 năm và mạng lưới trạm sạc đang mở rộng nhanh, là những yếu tố then chốt.</p>',
      author:'Quốc Huy', author_avatar:'https://i.pravatar.cc/40?img=55',
      date:'2026-03-28T11:00:00Z', read_time:4, views:14700,
      thumbnail:'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?w=800&q=80',
      tags:JSON.stringify(['VinFast','VF9','Xe điện','Đông Nam Á']), is_featured:0, is_hot:0,
    },
    {
      slug:'deepseek-r2-benchmark-gpt5', category:'ai', category_label:'AI',
      title:'DeepSeek R2 ra mắt: Vượt GPT-5 ở toán học, chi phí rẻ hơn 30 lần',
      excerpt:'Model AI Trung Quốc tiếp tục gây sốc khi DeepSeek R2 đạt điểm toán học cao hơn cả GPT-5.',
      content:'<p>DeepSeek vừa phát hành R2, model AI mới nhất với điểm MATH-500 đạt 97.3%, vượt GPT-5 ở mức 96.1%. Đặc biệt, chi phí API của R2 chỉ bằng 1/30 so với GPT-5 do kiến trúc Mixture of Experts tối ưu hơn.</p><p>Phát hành mã nguồn mở toàn bộ, DeepSeek R2 đã có hơn 200.000 lượt fork trên GitHub chỉ trong 48 giờ đầu. Cổ phiếu NVDA giảm 6% trong phiên giao dịch ngay sau thông báo.</p><h3>Tác động đến thị trường</h3><p>Nhiều công ty AI Mỹ đang xem xét lại chiến lược định giá sau sự kiện này. OpenAI đã hạ giá API GPT-4o xuống 50% vào tuần trước, động thái được cho là phản ứng với áp lực từ DeepSeek.</p>',
      author:'Thanh Trúc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-27T07:00:00Z', read_time:5, views:38900,
      thumbnail:'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=800&q=80',
      tags:JSON.stringify(['DeepSeek','AI','GPT-5','Benchmark']), is_featured:1, is_hot:1,
    },
    {
      slug:'grab-sap-nhap-gojek-dong-nam-a', category:'internet', category_label:'Internet',
      title:'Grab và Gojek sắp sáp nhập? Thương vụ 18 tỷ USD định hình lại Đông Nam Á',
      excerpt:'Bloomberg đưa tin hai siêu app lớn nhất Đông Nam Á đang trong giai đoạn đàm phán sáp nhập cuối cùng.',
      content:'<p>Bloomberg đưa tin Grab và Gojek đang trong vòng đàm phán cuối cùng cho thương vụ sáp nhập trị giá 18 tỷ USD. Nếu thành công, công ty mới sẽ phục vụ hơn 620 triệu người dùng tại 8 quốc gia Đông Nam Á.</p><p>Đây là thương vụ startup lớn nhất lịch sử khu vực, vượt qua thương vụ Lazada–Alibaba năm 2016. Các cơ quan quản lý cạnh tranh tại Singapore, Indonesia và Việt Nam sẽ cần phê duyệt trước khi thỏa thuận có hiệu lực.</p>',
      author:'Lan Anh', author_avatar:'https://i.pravatar.cc/40?img=44',
      date:'2026-03-26T16:00:00Z', read_time:3, views:27400,
      thumbnail:'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=800&q=80',
      tags:JSON.stringify(['Grab','Gojek','Sáp nhập','Đông Nam Á']), is_featured:0, is_hot:1,
    },
    {
      slug:'pubg-mobile-5-ty-luot-tai', category:'apps-game', category_label:'Apps & Game',
      title:'PUBG Mobile cán mốc 5 tỷ lượt tải — tựa game mobile đầu tiên trong lịch sử',
      excerpt:'Krafton công bố PUBG Mobile vượt mốc 5 tỷ lượt tải toàn cầu, một kỳ tích chưa từng có.',
      content:'<p>Krafton vừa công bố PUBG Mobile đã đạt 5 tỷ lượt tải toàn cầu, trở thành tựa game di động đầu tiên trong lịch sử vượt mốc này. Ấn Độ chiếm 30% tổng lượt tải, tiếp theo là Brazil và Indonesia.</p><p>Con số ấn tượng này đạt được dù game bị cấm tại Ấn Độ trong giai đoạn 2020-2022. Phiên bản Battlegrounds Mobile India (BGMI) thay thế giúp Krafton giữ chân người dùng nước này.</p>',
      author:'Đức Anh', author_avatar:'https://i.pravatar.cc/40?img=33',
      date:'2026-03-26T10:00:00Z', read_time:3, views:16200,
      thumbnail:'https://images.unsplash.com/photo-1493711662062-fa541adb3fc8?w=800&q=80',
      tags:JSON.stringify(['PUBG Mobile','Game','Kỷ lục','Krafton']), is_featured:0, is_hot:0,
    },
    {
      slug:'fiber-quang-viet-nam-10gbps-fpt', category:'tin-ict', category_label:'Tin ICT',
      title:'FPT triển khai gói cáp quang 10Gbps tại Hà Nội và TP.HCM, giá chỉ 599.000đ/tháng',
      excerpt:'FPT Telecom chính thức thương mại hóa Internet 10Gbps cho hộ gia đình — nhanh gấp 10 lần gói hiện tại.',
      content:'<p>FPT Telecom vừa công bố gói Internet cáp quang 10Gbps dành cho hộ gia đình tại Hà Nội và TP.HCM với giá 599.000 đồng/tháng. Gói này nhanh gấp 10 lần gói 1Gbps phổ biến nhất hiện tại và được quảng cáo phù hợp cho hộ gia đình nhiều thiết bị 8K streaming và gaming chuyên nghiệp.</p><p>Hạ tầng GPON XGS-PON được triển khai tại 50 quận/huyện trong giai đoạn đầu. Viettel và VNPT dự kiến ra mắt gói tương tự trong Q3/2026.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-25T15:00:00Z', read_time:3, views:12100,
      thumbnail:'https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&q=80',
      tags:JSON.stringify(['FPT','Internet','Cáp quang','10Gbps']), is_featured:0, is_hot:0,
    },
    {
      slug:'facebook-thiet-ke-moi-2026', category:'internet', category_label:'Internet',
      title:'Facebook ra mắt giao diện hoàn toàn mới — lần đầu thiết kế lại toàn diện sau 6 năm',
      excerpt:'Meta công bố Facebook redesign 2026 với feed thông minh hơn, stories biến mất và Reels chiếm vị trí trung tâm.',
      content:'<p>Meta vừa giới thiệu giao diện mới hoàn toàn cho Facebook, lần đầu tiên kể từ thiết kế năm 2020. Thay đổi lớn nhất là Stories không còn xuất hiện ở đầu feed — thay vào đó, Reels chiếm toàn bộ cột bên phải trên desktop.</p><p>Feed chính được tổ chức lại theo thuật toán "Relevant to You" thay vì chronological, gây ra làn sóng phản đối từ người dùng cũ. Tuy nhiên, Meta cho biết thời gian sử dụng tăng 22% trong giai đoạn thử nghiệm.</p>',
      author:'Lan Anh', author_avatar:'https://i.pravatar.cc/40?img=44',
      date:'2026-03-24T08:00:00Z', read_time:3, views:21500,
      thumbnail:'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&q=80',
      tags:JSON.stringify(['Facebook','Meta','Thiết kế','Mạng xã hội']), is_featured:0, is_hot:0,
    },
    {
      slug:'viet-nam-trung-tam-ai-dong-nam-a', category:'tin-ict', category_label:'Tin ICT',
      title:'Việt Nam lọt top 3 quốc gia phát triển AI nhanh nhất Đông Nam Á năm 2026',
      excerpt:'Báo cáo của Google và Temasek xếp Việt Nam thứ ba về tốc độ tăng trưởng hệ sinh thái AI trong khu vực.',
      content:'<p>Theo báo cáo e-Conomy SEA 2026 của Google, Temasek và Bain & Company, Việt Nam đứng thứ ba Đông Nam Á về tốc độ phát triển hệ sinh thái AI, chỉ sau Singapore và Indonesia. Số lượng startup AI Việt Nam tăng 340% trong 2 năm qua.</p><p>Các yếu tố được ghi nhận bao gồm: chính sách thu hút đầu tư AI của chính phủ, nguồn nhân lực STEM trẻ và chi phí vận hành thấp hơn 60% so với Singapore. FPT, VNG và VinAI đang dẫn đầu làn sóng này.</p>',
      author:'Quốc Huy', author_avatar:'https://i.pravatar.cc/40?img=55',
      date:'2026-03-22T09:00:00Z', read_time:5, views:8900,
      thumbnail:'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=800&q=80',
      tags:JSON.stringify(['Việt Nam','AI','Đông Nam Á','Startup']), is_featured:0, is_hot:0,
    },
    {
      slug:'claude-4-anthropic-ra-mat', category:'ai', category_label:'AI',
      title:'Anthropic ra mắt Claude 4: Vượt GPT-5 ở lập luận, từ chối viết malware dù bị ép buộc',
      excerpt:'Claude 4 của Anthropic đánh dấu bước tiến về safety AI — model đầu tiên có thể giải thích lý do từ chối.',
      content:'<p>Anthropic vừa phát hành Claude 4 với điểm benchmark MMLU đạt 92.4%, vượt GPT-5 ở các tác vụ lập luận đa bước và phân tích pháp lý. Điểm đặc biệt là Claude 4 có thể giải thích chi tiết lý do từ chối các yêu cầu vi phạm nguyên tắc an toàn.</p><p>Trong bài test red-teaming độc lập, Claude 4 từ chối 100% yêu cầu viết malware và tổng hợp hóa chất nguy hiểm, kể cả khi người dùng dùng các kỹ thuật jailbreak phức tạp. Đây là lần đầu tiên một model đạt tỷ lệ từ chối hoàn hảo trong danh mục này.</p>',
      author:'Thanh Trúc', author_avatar:'https://i.pravatar.cc/40?img=22',
      date:'2026-03-21T11:00:00Z', read_time:5, views:33100,
      thumbnail:'https://images.unsplash.com/photo-1668854270929-ef9b4943dcd6?w=800&q=80',
      tags:JSON.stringify(['Anthropic','Claude 4','AI','Safety']), is_featured:0, is_hot:0,
    },
    {
      slug:'khong-gian-tam-ly-cong-nghe-nguoi-dung', category:'kham-pha', category_label:'Khám phá',
      title:'Nghiên cứu mới: Người dùng smartphone trung bình chạm vào màn hình 2.617 lần mỗi ngày',
      excerpt:'Dữ liệu từ 50.000 người dùng Android tiết lộ thói quen sử dụng điện thoại đáng kinh ngạc của con người hiện đại.',
      content:'<p>Nghiên cứu mới nhất từ Đại học Humboldt (Đức) theo dõi 50.000 người dùng Android trong 6 tháng cho thấy số lần chạm màn hình trung bình là 2.617 lần/ngày — tương đương 3 tiếng 15 phút tổng thời gian tương tác thực tế.</p><p>Điều thú vị là 47% lần mở điện thoại không có mục đích rõ ràng — người dùng chỉ mở ra và đóng lại trong vòng 15 giây. Nhóm tuổi 18-24 có số lần chạm cao gấp đôi nhóm 45-54 tuổi.</p><h3>Ứng dụng gây nghiện nhất</h3><p>TikTok dẫn đầu với 89 phút/ngày trung bình, tiếp theo là Instagram (64 phút) và YouTube (58 phút). Facebook lần đầu tiên rời top 3 sau 10 năm liên tiếp.</p>',
      author:'Minh Khoa', author_avatar:'https://i.pravatar.cc/40?img=11',
      date:'2026-03-20T14:00:00Z', read_time:5, views:24600,
      thumbnail:'https://images.unsplash.com/photo-1512428559087-560fa5ceab42?w=800&q=80',
      tags:JSON.stringify(['Nghiên cứu','Smartphone','Tâm lý học','Thói quen']), is_featured:0, is_hot:0,
    },
  ]);
  console.log('[seed] 22 bài viết');

  // ── Seed view_log: tạo lịch sử xem thực tế dựa trên views đã seed ──
  // Thay vì hardcode views=18420, tạo view_log records để số liệu có nguồn gốc thật
  var seededArticles = db.prepare('SELECT id, views, shares FROM articles').all();
  var logView = db.prepare('INSERT OR IGNORE INTO view_log (article_id, ip, created_at) VALUES (?,?,?)');
  var ips = [
    '118.70.1.','203.162.4.','171.244.2.','14.160.3.','42.114.5.',
    '113.160.6.','27.72.7.','115.79.8.','1.55.9.','222.252.10.',
  ];

  // Tạo view_log cho 30 ngày qua — phân phối theo views đã seed
  db.transaction(function() {
    var now = Date.now();
    var day = 86400000;
    seededArticles.forEach(function(art) {
      // Phân phối views ngẫu nhiên trong 30 ngày, nhiều hơn ở ngày đầu
      var totalViews = Math.min(art.views, 200); // giới hạn records để không quá nặng
      for (var v = 0; v < totalViews; v++) {
        var daysAgo = Math.floor(Math.pow(Math.random(), 2) * 30); // exponential decay
        var ts = new Date(now - daysAgo * day - Math.random() * day);
        var ipBase = ips[Math.floor(Math.random() * ips.length)];
        var ip = ipBase + (Math.floor(Math.random() * 254) + 1);
        logView.run(art.id, ip, ts.toISOString());
      }
    });
  })();
  console.log('[seed] Đã tạo lịch sử lượt xem');
}

// Seed admin user
if (db.prepare("SELECT COUNT(*) as c FROM users WHERE role='admin'").get().c === 0) {
  var hash = bcrypt.hashSync('admin123456', 10);
  db.prepare("INSERT INTO users (name,email,password,avatar,role,status) VALUES (?,?,?,?,?,?)")
    .run('Admin', 'admin@techpulse.vn', hash, 'https://i.pravatar.cc/80?img=1', 'admin', 'active');
  console.log('[seed] Đã tạo tài khoản admin');
}

// Seed default site settings
if (db.prepare("SELECT COUNT(*) as c FROM site_settings").get().c === 0) {
  var settingInsert = db.prepare("INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)");
  db.transaction(function(rows) { for (var r of rows) settingInsert.run(r.k, r.v); })([
    { k:'siteName',    v:'TechPulse' },
    { k:'domain',      v:'techpulse.vn' },
    { k:'email',       v:'noreply@techpulse.vn' },
    { k:'description', v:'Tin tức công nghệ mới nhất' },
  ]);
  console.log('[seed] Đã tạo cài đặt hệ thống');
}

// ============================================================
// SYNC VIEWS TỪ VIEW_LOG THỰC TẾ (chạy mỗi lần khởi động)
// ============================================================
(function syncViewsFromLog() {
  try {
    // Tính tổng views thực tế từ view_log cho từng bài
    var realViews = db.prepare(`
      SELECT article_id, COUNT(*) as real_views
      FROM view_log
      GROUP BY article_id
    `).all();

    var update = db.prepare('UPDATE articles SET views = ? WHERE id = ? AND ? > views');
    db.transaction(function() {
      realViews.forEach(function(row) {
        // Chỉ cập nhật nếu số thực tế cao hơn số seed (tránh reset về 0 khi log ít)
        update.run(row.real_views, row.article_id, row.real_views);
      });
    })();

    // Tính trending score: kết hợp views 24h gần đây + views tổng + shares
    // Score = (views_24h * 3) + (shares * 5) + log(total_views + 1)
    var trendingUpdate = db.prepare(`
      UPDATE articles SET
        is_hot = CASE
          WHEN (
            (SELECT COUNT(*) FROM view_log
             WHERE article_id = articles.id
             AND created_at > datetime('now', '-24 hours')) * 3
            + shares * 5
            + CAST(LOG(views + 1) AS INTEGER) * 2
          ) > 50 THEN 1
          ELSE is_hot
        END
      WHERE status = 'published' AND deleted_at IS NULL
    `);
    trendingUpdate.run();

    console.log('[sync] Đã đồng bộ views từ view_log (' + realViews.length + ' bài)');
  } catch(e) {
    console.warn('[sync] Lỗi đồng bộ views:', e.message);
  }
})();

// ── Job tự động: cập nhật views mỗi 5 phút ──────────────────────────────────
setInterval(function() {
  try {
    var realViews = db.prepare(`
      SELECT article_id, COUNT(*) as real_views
      FROM view_log
      WHERE created_at > datetime('now', '-30 days')
      GROUP BY article_id
    `).all();

    var upd = db.prepare('UPDATE articles SET views = ? WHERE id = ?');
    db.transaction(function() {
      realViews.forEach(function(r) { upd.run(r.real_views, r.article_id); });
    })();
  } catch(e) {}
}, 5 * 60 * 1000); // mỗi 5 phút

// ── Bounce rate: tính từ view_log (duration_sec < 30s = bounce) ─────────────
setInterval(function() {
  try {
    db.prepare(`
      UPDATE articles SET bounce_rate = (
        SELECT ROUND(
          100.0 * SUM(CASE WHEN duration_sec < 30 THEN 1 ELSE 0 END)
          / NULLIF(COUNT(*), 0)
        , 1)
        FROM view_log WHERE article_id = articles.id
      )
      WHERE status = 'published'
    `).run();
  } catch(e) {}
}, 15 * 60 * 1000); // mỗi 15 phút

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
  logView:              db.prepare('INSERT INTO view_log (article_id, user_id, ip, user_agent) VALUES (?,?,?,?)'),
  updateViewDuration:   db.prepare("UPDATE view_log SET duration_sec=? WHERE article_id=? AND ip=? AND duration_sec IS NULL ORDER BY created_at DESC LIMIT 1"),
  hasViewedRecently:    db.prepare("SELECT 1 FROM view_log WHERE article_id=? AND ip=? AND created_at > datetime('now','-1 hour')"),

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
  { id:'do-choi-so', label:'Đồ chơi số' },
  { id:'tra-da-cn',  label:'Trà đá CN' },
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
  if (!token) return res_err(res, 'Cần đăng nhập', 401);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res_err(res, 'Token không hợp lệ hoặc đã hết hạn', 401);
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, function() {
    var user = stmt.userById.get(req.user.id);
    if (!user || user.role !== 'admin') return res_err(res, 'Không có quyền truy cập', 403);
    next();
  });
}

// Optional auth: nếu có token thì gán req.user, không có thì bỏ qua
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
      return res_err(res, 'Quá nhiều yêu cầu. Vui lòng thử lại sau.', 429);
    }
    rateLimitMap[key].push(now);
    next();
  };
}
setInterval(function() { rateLimitMap = {}; }, 300000);

// ============================================================
// ROUTES - HEALTH (admin only)
// ============================================================

app.get('/health', function(_req, res) {
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
  if (!req.file) return res_err(res, 'Không có file hoặc định dạng không hợp lệ');
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

  var total = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get(...args).c;
  var rows  = db.prepare('SELECT * ' + baseSQL + ' ORDER BY ' + orderBy + ' LIMIT ? OFFSET ?')
                .all(...args, limit, offset)
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
  if (q.length > 200) return res_err(res, 'Từ khóa tìm kiếm quá dài');

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
  if (q.length > 300) return res_err(res, 'Từ khóa tìm kiếm quá dài');

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
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);

  // Dedup view: 1 IP chi tinh 1 view / gio
  var ip = req.ip || 'unknown';
  var ua = (req.headers['user-agent'] || '').slice(0, 300);
  var alreadyViewed = stmt.hasViewedRecently.get(row.id, ip);
  if (!alreadyViewed) {
    stmt.incrViews.run(row.id);
    stmt.logView.run(row.id, (req.user && req.user.id) || null, ip, ua);
    // Cập nhật interest nếu đăng nhập
    if (req.user) {
      stmt.upsertInterest.run(req.user.id, row.category);
    }
  }

  res_ok(res, formatArticle(row, true));
});

// GET /api/articles/:id/related
app.get('/api/articles/:id/related', function(req, res) {
  var id  = parseInt(req.params.id);
  if (isNaN(id)) return res_err(res, 'ID không hợp lệ', 400);
  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);
  res_ok(res, stmt.related.all(row.category, row.id).map(function(r) { return formatArticle(r, false); }));
});

// POST /api/articles/:id/ping — client gửi duration_sec khi rời bài
app.post('/api/articles/:id/ping', rateLimit(30), function(req, res) {
  var id  = parseInt(req.params.id);
  if (isNaN(id)) return res_ok(res, { ok: true }); // silent ignore
  var dur = parseInt(req.body.duration_sec);
  if (!dur || dur < 1 || dur > 86400) return res_ok(res, { ok: true });
  var ip  = req.ip || 'unknown';
  try { stmt.updateViewDuration.run(dur, id, ip); } catch(e) {}
  res_ok(res, { ok: true });
});

// GET /api/articles/:id/comments
app.get('/api/articles/:id/comments', function(req, res) {
  var id     = parseInt(req.params.id);
  if (isNaN(id)) return res_err(res, 'ID không hợp lệ', 400);
  var page   = Math.max(1, parseInt(req.query.page)  || 1);
  var limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  var offset = (page - 1) * limit;

  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);

  var total = stmt.countComments.get(id).c;
  var items = stmt.getComments.all(id, limit, offset);
  res_ok(res, paginateResult(items, total, page, limit));
});

// POST /api/articles/:id/comments
app.post('/api/articles/:id/comments', requireAuth, rateLimit(10), function(req, res) {
  var id      = parseInt(req.params.id);
  if (isNaN(id)) return res_err(res, 'ID không hợp lệ', 400);
  var content = (req.body.content || '').trim();
  if (!content)              return res_err(res, 'Nội dung bình luận không được để trống');
  if (content.length > 2000) return res_err(res, 'Bình luận quá dài (tối đa 2000 ký tự)');

  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);

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
  if (!comment) return res_err(res, 'Bình luận không tồn tại', 404);

  var user = stmt.userById.get(req.user.id);
  var isOwner = comment.user_id === req.user.id;
  var isAdmin = user && user.role === 'admin';

  if (!isOwner && !isAdmin) return res_err(res, 'Không có quyền xóa bình luận này', 403);

  stmt.softDelComment.run(id);
  res_ok(res, { message: 'Đã xóa bình luận', id: id });
});


// POST /api/articles/:id/share  (tang share count)
app.post('/api/articles/:id/share', function(req, res) {
  var id = parseInt(req.params.id);
  var row = stmt.articleById.get(id);
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);
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

  if (!name || !email || !password) return res_err(res, 'Vui lòng điền đầy đủ thông tin');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res_err(res, 'Email không hợp lệ');
  if (password.length < 8)  return res_err(res, 'Mật khẩu phải có ít nhất 8 ký tự');
  if (password.length > 128) return res_err(res, 'Mật khẩu quá dài');
  if (stmt.userByEmail.get(email)) return res_err(res, 'Email đã được sử dụng');

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
  if (!email || !password) return res_err(res, 'Vui lòng nhập email và mật khẩu');

  var user = stmt.userByEmail.get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res_err(res, 'Email hoặc mật khẩu không đúng', 401);
  }
  if (user.status === 'banned') return res_err(res, 'Tài khoản đã bị khoá', 403);

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
  res_ok(res, { message: 'Nếu email tồn tại, link đặt lại mật khẩu sẽ được gửi trong vài phút.' });
});

// ============================================================
// POST /api/auth/google  — Google Identity Services (popup flow)
// Frontend gui credential (ID token tu GIS), backend verify voi Google
// ============================================================
app.post('/api/auth/google', rateLimit(10), function(req, res) {
  var credential = (req.body.credential || '').trim();
  if (!credential) return res_err(res, 'Thiếu Google credential');

  var verifyUrl = 'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential);

  https.get(verifyUrl, function(r) {
    var raw = '';
    r.on('data', function(chunk) { raw += chunk; });
    r.on('end', function() {
      var payload;
      try { payload = JSON.parse(raw); } catch(e) { return res_err(res, 'Phản hồi Google không hợp lệ'); }

      if (payload.error || !payload.email) {
        return res_err(res, 'Token Google không hợp lệ: ' + (payload.error_description || payload.error || 'unknown'));
      }
      // Kiem tra audience neu da set GOOGLE_CLIENT_ID
      if (GOOGLE_CLIENT_ID && payload.aud !== GOOGLE_CLIENT_ID) {
        return res_err(res, 'Google client_id không khớp');
      }
      // email_verified phai la true
      if (payload.email_verified !== 'true' && payload.email_verified !== true) {
        return res_err(res, 'Email Google chưa được xác minh');
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

      if (user.status === 'banned') return res_err(res, 'Tài khoản đã bị khoá', 403);

      // Cap nhat last_ip, last_device
      var device = (req.headers['user-agent'] || '').slice(0, 200);
      stmt.updateLastSeen.run(req.ip || null, device, user.id);

      var token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
      res_ok(res, { token: token, user: safeUser(user) });
    });
  }).on('error', function(e) {
    res_err(res, 'Không kết nối được Google: ' + e.message);
  });
});

app.post('/api/auth/refresh', function(req, res) {
  var token = (req.body.token || '').trim();
  if (!token) return res_err(res, 'Thieu token', 401);
  try {
    var decoded  = jwt.verify(token, JWT_SECRET);
    var user     = stmt.userById.get(decoded.id);
    if (!user) return res_err(res, 'Tài khoản không tồn tại', 404);
    if (user.status === 'banned') return res_err(res, 'Tài khoản đã bị khoá', 403);
    var newToken = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res_ok(res, { token: newToken, user: safeUser(user) });
  } catch (e) {
    return res_err(res, 'Token không hợp lệ', 401);
  }
});

app.get('/api/auth/me', requireAuth, function(req, res) {
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tài khoản không tồn tại', 404);
  // Kem theo interests
  var interests = stmt.getUserInterests.all(user.id).map(function(r) { return r.category; });
  var data = safeUser(user);
  data.interests = interests;
  res_ok(res, data);
});

app.put('/api/auth/me', requireAuth, function(req, res) {
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tài khoản không tồn tại', 404);
  var name   = ((req.body.name   || user.name  ) + '').trim().slice(0, 100);
  var avatar = ((req.body.avatar || user.avatar || '') + '').trim().slice(0, 500);
  stmt.updateProfile.run(name, avatar, req.user.id);
  res_ok(res, safeUser(stmt.userById.get(req.user.id)));
});

app.put('/api/auth/me/password', requireAuth, function(req, res) {
  var currentPassword = req.body.currentPassword || '';
  var newPassword     = req.body.newPassword     || '';
  if (!currentPassword || !newPassword) return res_err(res, 'Vui lòng nhập đầy đủ');
  var user = stmt.userById.get(req.user.id);
  if (!user) return res_err(res, 'Tài khoản không tồn tại', 404);
  if (!bcrypt.compareSync(currentPassword, user.password)) return res_err(res, 'Mật khẩu hiện tại không đúng');
  if (newPassword.length < 8)   return res_err(res, 'Mật khẩu mới phải có ít nhất 8 ký tự');
  if (newPassword.length > 128) return res_err(res, 'Mật khẩu quá dài');
  stmt.updatePw.run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res_ok(res, { message: 'Đổi mật khẩu thành công' });
});

// ============================================================
// ROUTES - BOOKMARKS
// ============================================================

app.get('/api/user/bookmarks', requireAuth, function(req, res) {
  var ids = stmt.getBookmarks.all(req.user.id).map(function(r) { return r.article_id; });
  if (!ids.length) return res_ok(res, []);
  var ph   = ids.map(function() { return '?'; }).join(',');
  var rows = db.prepare('SELECT * FROM articles WHERE id IN (' + ph + ') AND deleted_at IS NULL')
               .all(...ids);
  res_ok(res, rows.map(function(r) { return formatArticle(r, false); }));
});

app.post('/api/user/bookmarks/:id', requireAuth, function(req, res) {
  var aid = parseInt(req.params.id);
  if (!stmt.articleById.get(aid)) return res_err(res, 'Bài viết không tồn tại', 404);
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

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res_err(res, 'Email không hợp lệ');
  if (!['daily','weekly','breaking'].includes(frequency)) frequency = 'daily';

  var topicsJson = JSON.stringify(Array.isArray(topics) ? topics.slice(0,10) : []);
  if (stmt.nlByEmail.get(email)) {
    stmt.nlUpdate.run(frequency, topicsJson, email);
    return res_ok(res, { message: 'Đã cập nhật cài đặt bản tin.', email: email });
  }
  stmt.nlInsert.run(email, frequency, topicsJson);
  res_ok(res, { message: 'Đăng ký thành công! Vui lòng kiểm tra email để xác nhận.', email: email }, 201);
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

  // Tong views hom nay
  var todayViews = db.prepare(`
    SELECT COUNT(*) as c FROM view_log
    WHERE created_at >= datetime('now', 'start of day')
  `).get().c || 0;

  // Bounce rate trung binh (chi tinh bai co duration_sec)
  var avgBounce = db.prepare(`
    SELECT ROUND(100.0 * SUM(CASE WHEN duration_sec < 30 THEN 1 ELSE 0 END)
      / NULLIF(COUNT(*), 0), 1) as rate
    FROM view_log WHERE duration_sec IS NOT NULL
  `).get().rate || 0;

  // Thoi gian doc trung binh (giay)
  var avgDuration = db.prepare(`
    SELECT ROUND(AVG(duration_sec), 0) as avg
    FROM view_log WHERE duration_sec IS NOT NULL AND duration_sec > 0
  `).get().avg || 0;

  // Views theo category (cho content page)
  var categoryViews = db.prepare(`
    SELECT a.category, a.category_label, COUNT(vl.id) as views
    FROM view_log vl
    JOIN articles a ON a.id = vl.article_id
    WHERE vl.created_at >= datetime('now', '-30 days')
    GROUP BY a.category ORDER BY views DESC
  `).all();

  // Device breakdown tu user_agent
  var agents = db.prepare(`
    SELECT user_agent FROM view_log
    WHERE user_agent IS NOT NULL AND user_agent != ''
    AND created_at >= datetime('now', '-7 days')
  `).all();
  var mobile = 0, desktop = 0;
  agents.forEach(function(r) {
    var ua = (r.user_agent || '').toLowerCase();
    if (/mobi|android|iphone|ipad|tablet/.test(ua)) mobile++;
    else desktop++;
  });
  var total_ua = mobile + desktop || 1;

  res_ok(res, {
    articles:      db.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').get().c,
    drafts:        db.prepare("SELECT COUNT(*) as c FROM articles WHERE status='draft' AND deleted_at IS NULL").get().c,
    users:         db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    comments:      db.prepare('SELECT COUNT(*) as c FROM comments WHERE deleted_at IS NULL').get().c,
    newsletters:   db.prepare('SELECT COUNT(*) as c FROM newsletters').get().c,
    bookmarks:     db.prepare('SELECT COUNT(*) as c FROM bookmarks').get().c,
    totalViews:    totalViews,
    todayViews:    todayViews,
    weeklyViews:   weeklyRows,
    avgBounceRate: avgBounce,
    avgReadSec:    avgDuration,
    categoryViews: categoryViews,
    deviceSplit:   { mobile: Math.round(mobile/total_ua*100), desktop: Math.round(desktop/total_ua*100) },
    topArticles:   db.prepare('SELECT id,title,views,shares,bounce_rate,thumbnail,category_label FROM articles WHERE deleted_at IS NULL ORDER BY views DESC LIMIT 5').all(),
    recentUsers:   db.prepare('SELECT id,name,email,avatar,role,status,created_at FROM users ORDER BY id DESC LIMIT 5').all(),
  });
});

// GET /api/admin/notifications — tổng hợp sự kiện gần đây
app.get('/api/admin/notifications', requireAdmin, function(_req, res) {
  var notifs = [];

  // Bình luận mới (7 ngày)
  var newComments = db.prepare(`
    SELECT c.id, c.created_at, u.name as user_name, a.title as article_title
    FROM comments c
    JOIN users u ON u.id = c.user_id
    JOIN articles a ON a.id = c.article_id
    WHERE c.deleted_at IS NULL AND c.created_at >= datetime('now', '-7 days')
    ORDER BY c.created_at DESC LIMIT 10
  `).all();
  newComments.forEach(function(r) {
    notifs.push({ type: 'comment', icon: 'comment', title: 'Bình luận mới',
      desc: (r.user_name || '—') + ' bình luận vào "' + (r.article_title || '').slice(0,40) + '"',
      time: r.created_at, read: false });
  });

  // User mới (7 ngày)
  var newUsers = db.prepare(`
    SELECT id, name, email, created_at FROM users
    WHERE created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 5
  `).all();
  newUsers.forEach(function(r) {
    notifs.push({ type: 'user', icon: 'user', title: 'Người dùng mới',
      desc: (r.name || r.email || '—') + ' vừa đăng ký tài khoản',
      time: r.created_at, read: false });
  });

  // Newsletter mới (7 ngày)
  var newNL = db.prepare(`
    SELECT email, created_at FROM newsletters
    WHERE created_at >= datetime('now', '-7 days')
    ORDER BY created_at DESC LIMIT 5
  `).all();
  newNL.forEach(function(r) {
    notifs.push({ type: 'newsletter', icon: 'mail', title: 'Đăng ký newsletter',
      desc: r.email + ' đã đăng ký nhận bản tin',
      time: r.created_at, read: false });
  });

  // Bài viết mới (3 ngày)
  var newArticles = db.prepare(`
    SELECT id, title, author, date FROM articles
    WHERE deleted_at IS NULL AND date >= datetime('now', '-3 days')
    ORDER BY date DESC LIMIT 5
  `).all();
  newArticles.forEach(function(r) {
    notifs.push({ type: 'article', icon: 'article', title: 'Bài viết mới xuất bản',
      desc: '"' + (r.title || '').slice(0, 50) + '" — ' + (r.author || 'Admin'),
      time: r.date, read: true });
  });

  // Sắp xếp mới nhất trước
  notifs.sort(function(a, b) { return new Date(b.time) - new Date(a.time); });

  res_ok(res, {
    items: notifs.slice(0, 30),
    unread: notifs.filter(function(n) { return !n.read; }).length,
  });
});

// GET /api/admin/traffic?period=7d|30d&groupBy=hour
app.get('/api/admin/traffic', requireAdmin, function(req, res) {
  var groupBy = req.query.groupBy;

  if (groupBy === 'hour') {
    // Traffic theo giờ hôm nay (0–23)
    var rows = db.prepare(`
      SELECT strftime('%H', created_at) as hour, COUNT(*) as views
      FROM view_log
      WHERE created_at >= datetime('now', 'start of day')
      GROUP BY hour
      ORDER BY hour ASC
    `).all();
    // Điền đủ 24 giờ dù không có data
    var filled = [];
    for (var h = 0; h < 24; h++) {
      var hStr = String(h).padStart(2, '0');
      var found = rows.find(function(r) { return r.hour === hStr; });
      filled.push({ hour: hStr + ':00', views: found ? found.views : 0 });
    }
    return res_ok(res, filled);
  }

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
  var total   = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get(...args).c;
  var rows    = db.prepare('SELECT * ' + baseSQL + ' ORDER BY date DESC LIMIT ? OFFSET ?')
                  .all(...args, limit, offset)
                  .map(formatArticleAdmin);

  res_ok(res, paginateResult(rows, total, page, limit));
});

// POST /api/admin/articles
app.post('/api/admin/articles', requireAdmin, function(req, res) {
  var b = req.body;
  if (!b.title || !b.category) return res_err(res, 'Thiếu tiêu đề hoặc chuyên mục');
  if (!VALID_CATEGORY_IDS.has(b.category)) return res_err(res, 'Chuyên mục không hợp lệ');

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
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);

  var b = req.body;
  if (b.category && !VALID_CATEGORY_IDS.has(b.category)) return res_err(res, 'Chuyên mục không hợp lệ');
  if (b.status   && !VALID_STATUSES.has(b.status))       return res_err(res, 'Trạng thái không hợp lệ');

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
  if (!row) return res_err(res, 'Không tìm thấy bài viết', 404);

  if (req.query.hard === 'true') {
    // Hard delete chi khi truyen ?hard=true
    stmt.hardDelete.run(id);
    res_ok(res, { message: 'Đã xoá vĩnh viễn bài viết', id: id });
  } else {
    stmt.softDelete.run(id);
    res_ok(res, { message: 'Đã xoá bài viết (có thể khôi phục)', id: id });
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
  var total   = db.prepare('SELECT COUNT(*) as c ' + baseSQL).get(...args).c;
  var rows    = db.prepare('SELECT * ' + baseSQL + ' ORDER BY id DESC LIMIT ? OFFSET ?')
                  .all(...args, limit, offset)
                  .map(safeUserAdmin);

  res_ok(res, paginateResult(rows, total, page, limit));
});

// PATCH /api/admin/users/:id
app.patch('/api/admin/users/:id', requireAdmin, function(req, res) {
  var id   = parseInt(req.params.id);
  var user = stmt.userById.get(id);
  if (!user) return res_err(res, 'Người dùng không tồn tại', 404);

  var b = req.body;
  var name   = (b.name   !== undefined) ? (b.name + '').trim().slice(0, 100)   : user.name;
  var email  = (b.email  !== undefined) ? (b.email + '').trim().toLowerCase().slice(0, 200) : user.email;
  var role   = (b.role   !== undefined && VALID_ROLES.has(b.role))         ? b.role   : user.role;
  var status = (b.status !== undefined && VALID_USER_STATUSES.has(b.status)) ? b.status : user.status;
  var phone  = (b.phone  !== undefined) ? (b.phone + '').trim().slice(0, 20) : user.phone;

  // Kiem tra email trung neu thay doi
  if (email !== user.email && stmt.userByEmail.get(email)) {
    return res_err(res, 'Email đã được sử dụng boi tai khoan khac');
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
  if (!user) return res_err(res, 'Người dùng không tồn tại', 404);
  if (user.role === 'admin') return res_err(res, 'Không thể xoá tài khoản admin', 403);

  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res_ok(res, { message: 'Đã xoá người dùng', id: id });
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

app.use(function(_req, res) { res_err(res, 'Route không tồn tại', 404); });

var server = app.listen(PORT, function() {
  var c = db.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').get().c;
  console.log('TechPulse API  -> http://localhost:' + PORT);
  console.log('SQLite DB      -> ' + DB_PATH);
  console.log('Bai viet       -> ' + c);
  console.log('JWT expires    -> ' + JWT_EXPIRES);
  // Auto-ping de Render free tier khong bi sleep (ping moi 14 phut)
  var SELF_URL = (process.env.RENDER_EXTERNAL_URL || 'https://websitetechloky.onrender.com');
  setInterval(function() {
    https.get(SELF_URL + '/health', function(r) {
      console.log('[ping] ' + r.statusCode);
    }).on('error', function() {});
  }, 14 * 60 * 1000);
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
