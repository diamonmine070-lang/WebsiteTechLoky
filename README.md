# TechPulse

Nền tảng tin tức công nghệ Việt Nam gồm 3 phần:

| File | Mô tả |
|------|-------|
| `backend.js` | Node.js + Express + SQLite API server |
| `admin-mobile-v2.html` | Admin dashboard (mobile-first) |
| `news-ui.html` | Giao diện người dùng |

## Cài đặt & chạy local

```bash
# 1. Cài dependencies
npm install

# 2. Tạo file .env từ mẫu
cp .env.example .env
# Mở .env và đổi JWT_SECRET

# 3. Chạy server
npm start
# → http://localhost:3000

# 4. Mở admin
# Mở file admin-mobile-v2.html trong trình duyệt
# Hoặc thêm vào đầu file: window.TECHPULSE_API = 'http://localhost:3000'

# 5. Mở user app
# Mở file news-ui.html trong trình duyệt
```

## Deploy lên Railway

1. Push code lên GitHub (không cần commit `*.db` và `node_modules`)
2. Vào [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Set environment variables:
   - `JWT_SECRET` = chuỗi random dài
   - `ALLOWED_ORIGINS` = URL của 2 frontend
   - `BASE_URL` = URL Railway tự cấp (vd: `https://xxx.up.railway.app`)
4. Railway tự chạy `npm start`

## Deploy lên Render

1. New Web Service → Connect GitHub repo
2. Build Command: `npm install`
3. Start Command: `npm start`
4. Set environment variables như trên
5. **Lưu ý**: Render free tier sleep sau 15 phút inactive → dùng paid plan hoặc Railway

## Kết nối frontend với backend

Thêm vào đầu mỗi HTML file (trước thẻ `<script>` chính):

```html
<script>
  window.TECHPULSE_API = 'https://url-backend-cua-ban.railway.app';
</script>
```

## Tài khoản mặc định

Sau khi chạy lần đầu, DB tự tạo admin:
- Email: `admin@techpulse.vn`
- Password: `admin123456`
- **Đổi ngay sau khi deploy!**

## API Routes

Xem comment đầu file `backend.js` để biết danh sách đầy đủ routes.
