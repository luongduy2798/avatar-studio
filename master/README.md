# Avatar Master

NestJS service containing Moodlab's public API, scheduler, runner registry and
runner WSS gateway.

`master/` is a standalone deployable unit. It does not import the Python runner
or the benchmark web client/API. Production only needs this directory plus its
Node.js dependencies and AWS configuration.

Local-only benchmark and multipart endpoints live under `internal/benchmark-api`
and are loaded only when `AVATAR_LOCAL_BENCHMARKS=1` is set by the internal
development stack.

Production mode uses S3, SQS and DynamoDB. The Master package can be deployed
without the Runner source tree.

Production chạy một entrypoint duy nhất: `npm run start`. Process này chứa
Public API cho Moodlab, Admin API, SQS scheduler và WSS gateway cho Runner.
AWS production bật `AVATAR_MASTER_ENABLED=1`.

Chi tiết cài đặt production nằm trong [docs/production-moodlab.md](docs/production-moodlab.md).
Các bước triển khai copy-paste nằm trong [docs/production-runbook.md](docs/production-runbook.md).

## Trang quản trị

Master phục vụ trang quản trị tại `/admin` trên cùng port với API:

- Đăng nhập bằng `AVATAR_ADMIN_TOKEN` đã cấu hình trong môi trường của Master.
- Xem tổng Runner, online/offline và số job Runner online đang xử lý.
- Tìm/lọc Runner; xem GPU, backend, capacity, phiên bản và heartbeat.
- Tạo mã enrollment một lần, chọn TTL và sao chép lệnh cài Ubuntu/macOS/Windows.
- Thu hồi quyền kết nối Runner sau khi xác nhận.

Admin UI là package React + Vite nằm trong `admin-ui/`. Cài và build cùng
Master bằng:

```bash
npm run setup:admin
npm run build
```

`npm run build` tạo NestJS trong `dist/` và static UI trong `admin-ui/dist/`.
Khi triển khai Master bằng PM2, giữ cả hai thư mục này cùng với cấu hình Nginx.

Token chỉ giữ trong bộ nhớ tab; tải lại trang hoặc đăng xuất sẽ cần nhập lại.
Trang không lưu token trong localStorage, cookie hoặc URL. Các Admin API vẫn
xác thực Bearer token cho mọi lần đọc/ghi. Production sử dụng HTTPS.

Ví dụ chạy local (trong thư mục `master/`):

```bash
npm install --package-lock=false
npm run setup:admin
AVATAR_ADMIN_TOKEN='<token-cua-ban>' npm run dev
```

Mở `http://localhost:8000/admin`. Muốn Runner kết nối ở local, thêm
`AVATAR_MASTER_ENABLED=1` khi khởi động. Biến trong `.env.example` là mẫu;
Master đọc biến môi trường của process, không tự nạp file `.env`.

Khi phát triển giao diện với Vite HMR, chạy thêm `npm run dev:admin` và mở
`http://localhost:5174/admin/`. Vite proxy các request `/api` tới Master ở
port 8000. Trang `/admin` trên port 8000 dùng bản build trong
`admin-ui/dist/`.

Run locally with `npm install --package-lock=false` and then `npm run dev`.
For the full internal benchmark UI, run `make -f internal/Makefile run` from the
repository root so the local-only module is enabled.
