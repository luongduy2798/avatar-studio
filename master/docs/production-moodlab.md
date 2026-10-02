# Production Avatar Service cho Moodlab

Production có một process NestJS trên VM/EC2 CPU:

- `avatar-master`: nhận request Moodlab, đọc SQS, điều phối runner và mở WSS trên cùng port 8000.

S3 lưu input/output, DynamoDB lưu job/runner/enrollment/idempotency, SQS giữ queue và DLQ giữ lỗi sau retry. Runner không đọc SQS và không giữ AWS credentials; runner nhận assignment qua WSS và upload bằng presigned URL.

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
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

Nginx dùng cấu hình mẫu tại `deploy/nginx/avatar.conf`; production cần HTTPS để Moodlab gọi API và runner kết nối WSS. Cả hai route đều proxy tới port 8000.

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
