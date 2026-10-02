# Production Avatar Service cho Moodlab

Production có một process NestJS trên VM/EC2 CPU:

- `avatar-master`: nhận request Moodlab, đọc SQS, điều phối runner và mở WSS trên cùng port 8000.

S3 lưu input/output, DynamoDB lưu job/runner/enrollment/idempotency, SQS giữ queue và DLQ giữ lỗi sau retry. Runner không đọc SQS và không giữ AWS credentials; runner nhận assignment qua WSS và upload bằng presigned URL.

Runbook triển khai theo từng bước, có thể copy lệnh trực tiếp, nằm trong
[production-runbook.md](production-runbook.md).

DynamoDB table key tối thiểu:

| Table | Partition key | TTL |
| --- | --- | --- |
| jobs | `jobId` | không bắt buộc |
| runners | `runnerId` | không bắt buộc |
| enrollments | `codeHash` | `expiresAt` |
| idempotency | `id` | `expiresAt` |

## Cài runner

```bash
cd /path/to/avatar-runner
AVATAR_MASTER_URL=wss://avatar.example.com/runner/ws \
AVATAR_RUNNER_ENROLL_CODE=ABCD1234 \
LIVEPORTRAIT_ROOT="$HOME/.cache/avatar-studio/LivePortrait" \
bash install.sh
```

Windows chạy `install-windows.ps1` trong Runner repo. Runner tự cài native service, reconnect khi mất mạng và lưu token trong credentials file.

## Chạy API/Master

Build API một lần rồi chạy bằng PM2:

```bash
cd /path/to/avatar-master
npm install
npm run setup:admin
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

Nginx dùng cấu hình mẫu tại `deploy/nginx/avatar.conf`; production cần HTTPS để Moodlab gọi API và runner kết nối WSS. Cả hai route đều proxy tới port 8000.

## Quản trị Master

Mở `https://avatar.example.com/admin` và đăng nhập bằng `AVATAR_ADMIN_TOKEN`
được truyền vào môi trường process Master. Trang được phục vụ bởi cùng process,
không cần service frontend riêng. `npm run build` tạo `admin-ui/dist/`; khi
deploy bằng PM2/native, đóng gói cả `admin-ui/dist/` và `dist/`.

Trang hiển thị Runner và heartbeat, tự cập nhật mỗi 10 giây, có tìm kiếm và lọc
trạng thái. Chọn **Kết nối Runner** để tạo mã enrollment có TTL và lấy lệnh cài.
Mở chi tiết một Runner để thu hồi quyền kết nối. Sau thu hồi, scheduler ngắt
socket của Runner; job chưa hoàn tất được xử lý qua cơ chế retry/DLQ hiện có.

Token admin và mã enrollment không được lưu trên browser storage. Trang tổng
quan báo số job do Runner online cung cấp; đây không phải thống kê toàn bộ
job/queue hoặc lịch sử throughput.

Biến production tối thiểu:

```text
AVATAR_INFRA_MODE=aws
AVATAR_MASTER_ENABLED=1
AVATAR_S3_BUCKET=...
AVATAR_SQS_QUEUE_URL=...
AVATAR_SQS_DLQ_URL=...
AVATAR_DYNAMODB_JOBS_TABLE=...
AVATAR_DYNAMODB_RUNNERS_TABLE=...
AVATAR_DYNAMODB_ENROLLMENTS_TABLE=...
AVATAR_DYNAMODB_IDEMPOTENCY_TABLE=...
AVATAR_MOODLAB_API_KEYS=...
AVATAR_ADMIN_TOKEN=...
AVATAR_PUBLIC_URL=https://avatar.example.com
```

Admin tạo enrollment code bằng `POST /api/v1/admin/runners/enrollment-codes`. Moodlab dùng flow `POST /api/v1/uploads/init`, upload trực tiếp lên S3, sau đó `POST /api/v1/jobs` với `Idempotency-Key`.

IAM của Master được cấp quyền S3 Put/Head/Get-presign, SQS Send/Receive/Delete/Visibility/DLQ và DynamoDB job/runner/enrollment/idempotency; Runner không được cấp AWS key.

Master khởi động bằng `deploy/start.sh`; Runner khởi động bằng
`deploy/start.sh` trong Runner package.
