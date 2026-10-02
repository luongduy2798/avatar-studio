# Production runbook: Master + AWS + Runner

Runbook này dành cho production thật. Master chạy trực tiếp trên một Ubuntu
VM bằng PM2. Runner chạy native trên từng máy inference. S3, SQS và DynamoDB
là dịch vụ AWS managed, không cài trên VM.

Thay toàn bộ giá trị trong dấu <...> trước khi chạy.

## 1. Điều kiện

Cần có:

- AWS account và IAM role/user có quyền tạo S3, SQS, DynamoDB.
- Một Ubuntu VM có public DNS, ví dụ avatar.example.com.
- DNS A record trỏ avatar.example.com về IP VM.
- Source repository Master trên VM.
- PM2, Node.js và npm đã cài.
- AWS CLI đã cấu hình hoặc VM có IAM role.

Kiểm tra:

~~~bash
node --version
npm --version
pm2 --version
aws sts get-caller-identity
~~~

Không đặt AWS access key trong repository hoặc trong Runner.

## 2. Tạo resource AWS một lần

Chạy trên máy có AWS CLI. Chọn bucket name duy nhất toàn cầu:

~~~bash
export AWS_REGION=ap-southeast-1
export AVATAR_S3_BUCKET=<unique-avatar-bucket-name>
export AVATAR_SQS_QUEUE_NAME=avatar-generation
export AVATAR_SQS_DLQ_NAME=avatar-generation-dlq
export AVATAR_DYNAMODB_JOBS_TABLE=avatar-jobs
export AVATAR_DYNAMODB_RUNNERS_TABLE=avatar-runners
export AVATAR_DYNAMODB_ENROLLMENTS_TABLE=avatar-enrollments
export AVATAR_DYNAMODB_IDEMPOTENCY_TABLE=avatar-idempotency

aws sts get-caller-identity
~~~

### S3

~~~bash
if ! aws s3api head-bucket --bucket "$AVATAR_S3_BUCKET" 2>/dev/null; then
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$AVATAR_S3_BUCKET" --region "$AWS_REGION"
  else
    aws s3api create-bucket \
      --bucket "$AVATAR_S3_BUCKET" \
      --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
fi

aws s3api put-public-access-block \
  --bucket "$AVATAR_S3_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket "$AVATAR_S3_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
~~~

### SQS và DLQ

~~~bash
aws sqs create-queue \
  --queue-name "$AVATAR_SQS_DLQ_NAME" \
  --attributes VisibilityTimeout=900

export AVATAR_SQS_DLQ_URL="$(aws sqs get-queue-url \
  --queue-name "$AVATAR_SQS_DLQ_NAME" \
  --query QueueUrl --output text)"

export AVATAR_SQS_DLQ_ARN="$(aws sqs get-queue-attributes \
  --queue-url "$AVATAR_SQS_DLQ_URL" \
  --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)"

cat >/tmp/avatar-sqs-main-attributes.json <<EOF
{
  "VisibilityTimeout": "900",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$AVATAR_SQS_DLQ_ARN\",\"maxReceiveCount\":\"3\"}"
}
EOF

aws sqs create-queue \
  --queue-name "$AVATAR_SQS_QUEUE_NAME" \
  --attributes file:///tmp/avatar-sqs-main-attributes.json

export AVATAR_SQS_QUEUE_URL="$(aws sqs get-queue-url \
  --queue-name "$AVATAR_SQS_QUEUE_NAME" \
  --query QueueUrl --output text)"

rm -f /tmp/avatar-sqs-main-attributes.json

printf 'AVATAR_SQS_QUEUE_URL=%s\nAVATAR_SQS_DLQ_URL=%s\n' \
  "$AVATAR_SQS_QUEUE_URL" "$AVATAR_SQS_DLQ_URL"
~~~

### DynamoDB

~~~bash
create_table() {
  local table_name="$1"
  local key_name="$2"
  if ! aws dynamodb describe-table --table-name "$table_name" >/dev/null 2>&1; then
    aws dynamodb create-table \
      --table-name "$table_name" \
      --attribute-definitions "AttributeName=$key_name,AttributeType=S" \
      --key-schema "AttributeName=$key_name,KeyType=HASH" \
      --billing-mode PAY_PER_REQUEST
  fi
  aws dynamodb wait table-exists --table-name "$table_name"
}

create_table "$AVATAR_DYNAMODB_JOBS_TABLE" jobId
create_table "$AVATAR_DYNAMODB_RUNNERS_TABLE" runnerId
create_table "$AVATAR_DYNAMODB_ENROLLMENTS_TABLE" codeHash
create_table "$AVATAR_DYNAMODB_IDEMPOTENCY_TABLE" id

aws dynamodb update-time-to-live \
  --table-name "$AVATAR_DYNAMODB_ENROLLMENTS_TABLE" \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt

aws dynamodb update-time-to-live \
  --table-name "$AVATAR_DYNAMODB_IDEMPOTENCY_TABLE" \
  --time-to-live-specification Enabled=true,AttributeName=expiresAt
~~~

IAM role của VM Master cần quyền tối thiểu trên đúng các resource vừa tạo:

~~~text
s3:PutObject, s3:GetObject, s3:HeadObject
sqs:SendMessage, sqs:ReceiveMessage, sqs:DeleteMessage,
sqs:ChangeMessageVisibility, sqs:GetQueueAttributes
dynamodb:GetItem, dynamodb:PutItem, dynamodb:UpdateItem,
dynamodb:DeleteItem, dynamodb:Scan
~~~

Runner không được gắn IAM role và không nhận AWS credentials.

## 3. Cài Master trên Ubuntu VM

Đặt source tại /opt/avatar-master. Nếu source đã được upload thì bỏ qua lệnh
git clone:

~~~bash
sudo mkdir -p /opt/avatar-master
sudo chown -R "$USER":"$USER" /opt/avatar-master
git clone <MASTER_REPOSITORY_URL> /opt/avatar-master
cd /opt/avatar-master
~~~

Nếu repository hiện tại chứa thư mục master thay vì là repository Master riêng:

~~~bash
cd /path/to/avatar-studio/master
~~~

Cài dependencies và build:

~~~bash
npm install --no-audit --no-fund --package-lock=false
npm run setup:admin
npm run build
~~~

## 4. Cấu hình environment cho Master

Tạo file secrets ngoài source:

~~~bash
sudo install -d -m 0750 /etc/avatar-master
sudo tee /etc/avatar-master/master.env >/dev/null <<'ENV_FILE'
PORT=8000
AWS_REGION=ap-southeast-1
AVATAR_INFRA_MODE=aws
AVATAR_MASTER_ENABLED=1
AVATAR_LOCAL_BENCHMARKS=0
AVATAR_S3_BUCKET=<unique-avatar-bucket-name>
AVATAR_SQS_QUEUE_URL=<sqs-main-queue-url>
AVATAR_SQS_DLQ_URL=<sqs-dlq-url>
AVATAR_DYNAMODB_JOBS_TABLE=avatar-jobs
AVATAR_DYNAMODB_RUNNERS_TABLE=avatar-runners
AVATAR_DYNAMODB_ENROLLMENTS_TABLE=avatar-enrollments
AVATAR_DYNAMODB_IDEMPOTENCY_TABLE=avatar-idempotency
AVATAR_MOODLAB_API_KEYS=<moodlab-api-key>
AVATAR_ADMIN_TOKEN=<long-random-admin-token>
AVATAR_RUNNER_WS_PATH=/runner/ws
AVATAR_RUNNER_HEARTBEAT_TIMEOUT_SECONDS=30
AVATAR_RUNNER_LEASE_SECONDS=900
AVATAR_MAX_ATTEMPTS=3
AVATAR_RUNNER_VERSION=1.0.0
AVATAR_PUBLIC_URL=https://avatar.example.com
AVATAR_CORS_ORIGINS=https://avatar.example.com
ENV_FILE
sudo chmod 600 /etc/avatar-master/master.env
~~~

Thay URL và queue URL bằng giá trị thật. Lấy queue URL bằng lệnh ở bước 2.

## 5. Chạy Master bằng PM2

Nạp environment rồi khởi động:

~~~bash
cd /opt/avatar-master
set -a
source /etc/avatar-master/master.env
set +a

pm2 delete avatar-master 2>/dev/null || true
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 status
pm2 logs avatar-master --lines 100
~~~

Ecosystem đã dùng deploy/start.sh. Script này kiểm tra AWS variables,
bật AWS infrastructure mode và chạy dist/main.js.

Kiểm tra health từ VM:

~~~bash
curl -fsS http://127.0.0.1:8000/api/v1/health
~~~

Kết quả cần có infrastructure là aws.

Nếu thay đổi environment:

~~~bash
cd /opt/avatar-master
set -a
source /etc/avatar-master/master.env
set +a
pm2 restart avatar-master --update-env
pm2 save
~~~

Thiết lập PM2 tự khởi động sau reboot:

~~~bash
pm2 startup
~~~

Chạy đúng câu lệnh sudo mà PM2 in ra, sau đó:

~~~bash
pm2 save
~~~

## 6. Nginx và HTTPS

Cài Nginx:

~~~bash
sudo apt-get update
sudo apt-get install -y nginx
~~~

Cài site và thay hostname:

~~~bash
sudo cp /opt/avatar-master/deploy/nginx/avatar.conf \
  /etc/nginx/sites-available/avatar-master

sudo sed -i 's/avatar.example.com/<YOUR_DOMAIN>/g' \
  /etc/nginx/sites-available/avatar-master

sudo ln -sfn \
  /etc/nginx/sites-available/avatar-master \
  /etc/nginx/sites-enabled/avatar-master

sudo nginx -t
sudo systemctl reload nginx
~~~

Cài TLS sau khi DNS đã trỏ đúng:

~~~bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d <YOUR_DOMAIN>
~~~

Sau khi có HTTPS, các endpoint chính là:

~~~text
https://<YOUR_DOMAIN>/api/v1/health
https://<YOUR_DOMAIN>/admin
wss://<YOUR_DOMAIN>/runner/ws
~~~

## 7. Enroll Runner

Mở Admin tại https://<YOUR_DOMAIN>/admin, nhập AVATAR_ADMIN_TOKEN và chọn
Kết nối Runner để tạo enrollment code.

Hoặc tạo code bằng API:

~~~bash
export AVATAR_ADMIN_TOKEN=<long-random-admin-token>
export AVATAR_PUBLIC_URL=https://<YOUR_DOMAIN>

curl -fsS -X POST \
  "$AVATAR_PUBLIC_URL/api/v1/admin/runners/enrollment-codes" \
  -H "Authorization: Bearer $AVATAR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"ttl_seconds":900}'
~~~

Lấy code trong response JSON. Trên máy Runner Ubuntu/macOS:

~~~bash
cd /path/to/avatar-runner
AVATAR_MASTER_URL=wss://<YOUR_DOMAIN>/runner/ws \
AVATAR_RUNNER_ENROLL_CODE=<ONE_TIME_CODE> \
bash install.sh
~~~

Runner installer tự tạo Python environment, enroll một lần và cài service
native. Ubuntu dùng systemd user service; macOS dùng launchd. Runner không cần
AWS credentials.

## 8. Kiểm tra production

~~~bash
curl -fsS https://<YOUR_DOMAIN>/api/v1/health
pm2 status
pm2 logs avatar-master --lines 100
~~~

Trong Admin UI cần thấy Runner ở trạng thái Online. Nếu Runner Offline, kiểm
tra DNS/TLS, outbound WSS và log service trên máy Runner.

## 9. Cập nhật phiên bản

~~~bash
cd /opt/avatar-master
git pull --ff-only
npm install --no-audit --no-fund --package-lock=false
npm run setup:admin
npm run build

set -a
source /etc/avatar-master/master.env
set +a
pm2 restart avatar-master --update-env
pm2 save
~~~

Cập nhật Runner bằng installer mới trên từng máy. Không xóa credentials nếu
muốn giữ enrollment hiện tại.
