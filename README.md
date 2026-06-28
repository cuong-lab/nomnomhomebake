# nomnom — Website bán bánh ngọt

Web bán hàng minimalist & modern, dựng bằng Vite + Tailwind CSS v4.

## Chạy dự án (lần đầu)

```bash
npm install
npm run dev
```

Sau đó mở link `localhost` hiện ra trong terminal (thường là http://localhost:5173).

## Lệnh khác

- `npm run build` — build bản production vào thư mục `dist/`
- `npm run preview` — xem thử bản đã build

## Cấu trúc

```
index.html        → trang chính (layout + hero)
src/main.js       → điểm vào JavaScript
src/style.css     → Tailwind + design tokens (màu, font) của nomnom
vite.config.js    → cấu hình Vite + plugin Tailwind
```

## Design system

- Màu: trắng tinh, kem (#FDFBF7), đất ấm (#D4C5B9), đen mực (#0A0A0A)
- Font: Playfair Display (tiêu đề, serif) + Inter (giao diện, sans-serif)

## Các bước tiếp theo

- [x] Step 1: Core layout & design system
- [ ] Step 2: Homepage & product grid
- [ ] Step 3: Cart drawer & checkout
- [ ] Step 4: "Our Story" section
