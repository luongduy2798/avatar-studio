# Kiến trúc tổng thể Avatar Studio

> Production integration với Moodlab dùng một process `avatar-master`, bên trong
> có Public API, Scheduler và WSS gateway. Runtime inference nằm trong
> Runner agent; Master đọc SQS và gửi assignment qua WSS. Các sơ đồ bên dưới
> mô tả boundary production và local benchmark.

Tài liệu này mô tả boundary production và boundary local hiện tại. Production có
hai artifact độc lập:

```text
avatar-master/     NestJS / TypeScript / CPU
avatar-runner/     Python / PyTorch / LivePortrait / GPU
```

`internal/web-client`, `internal/benchmark-api`, `master` và `runner` trong
monorepo là boundary local/benchmark. Khi đóng gói production, Public API và
Scheduler chạy chung trong `avatar-master`; LivePortrait chạy trong
`avatar-runner`.

## 1. Hai khối production

### avatar-master

`avatar-master` là một NestJS process duy nhất, gồm:

Trách nhiệm:

- Public API cho Moodlab,
- Admin API cho runner,
- validate input,
- presigned S3 upload/download,
- tạo job và lưu DynamoDB,
- publish/consume SQS,
- scheduler và lease,
- WSS gateway cho Runner.

### avatar-runner

`avatar-runner` là agent cài trên máy inference.

Trách nhiệm:

- kết nối outbound WSS tới Master,
- nhận assignment,
- preprocess ảnh,
- chạy LivePortrait,
- upload output bằng presigned URL,
- gửi progress/result/heartbeat.

Runner không đọc SQS và không có AWS credentials.

## 2. Kiến trúc production

```text
Moodlab ── HTTPS ──> avatar-master :8000
                         ├── Public/Admin API
                         ├── SQS consumer + scheduler
                         └── WSS /runner/ws
                                  ▲
                                  │ outbound WSS
                           avatar-runner
                           LivePortrait

avatar-master ──> SQS / DLQ
avatar-master ──> DynamoDB
avatar-master ──> S3
avatar-runner ──> S3 presigned URLs
```

Production mapping dự kiến:

| Thành phần | Công nghệ / hạ tầng |
| --- | --- |
| Master | NestJS process trên VM/CPU, PM2 hoặc Docker |
| Input/output | S3 |
| Job state | DynamoDB |
| Queue | SQS |
| Retry exhausted | SQS DLQ |
| Runner | Native installer trên Ubuntu/macOS/Windows GPU |
| Metrics/logs | CloudWatch |

## 3. Luồng tạo một job

```text
Moodlab
    ↓ POST /api/v1/uploads/init
avatar-master
    ↓ presigned PUT
Moodlab ── upload trực tiếp ──> S3
    ↓ POST /api/v1/jobs
avatar-master
    ├─ validate
    ├─ tạo jobId
    ├─ tạo job record
    └─ enqueue
    ↓ 202 + jobId
Moodlab polling GET job

SQS
    ↓
avatar-master → WSS assignment → avatar-runner
                                      ├─ preprocess
                                      ├─ LivePortrait
                                      ├─ export/upload S3
                                      └─ completed → Master ack
```

API không giữ HTTP request trong toàn bộ thời gian inference. Burst request được hấp thụ bởi queue, còn số GPU quyết định thời gian drain queue.

## 4. Job contract

Generation message giữa API và GPU nên giữ nhỏ và versioned, ví dụ:

```json
{
  "version": 1,
  "jobId": "job_123",
  "inputKey": "jobs/job_123/input/source.jpg",
  "expressions": [
    "unbothered",
    "locked_in",
    "cracking_up",
    "full_panic",
    "big_winner",
    "spectacular_flop"
  ],
  "intensity": 1
}
```

Không cần shared runtime package giữa TypeScript và Python. Contract được giữ ổn định bằng schema/version và integration tests.

## 5. Job lifecycle

Lifecycle ở mức client:

```text
queued
  ↓
processing
  ↓
completed
```

Nhánh lỗi:

```text
processing
  ↓
retrying
  ↓
processing

hoặc

failed
```

Worker có thể dùng `stage` chi tiết hơn trong khi `status` public vẫn đơn giản cho frontend.

Ví dụ:

```json
{
  "jobId": "job_123",
  "status": "processing",
  "stage": "expressions",
  "progress": 50,
  "completed": 3,
  "total": 6
}
```

## 6. Reliability

Queue/job layer phải bảo đảm:

- job được lưu bền vững trước khi xử lý,
- API restart không làm mất job,
- message chỉ được ack sau khi worker hoàn tất,
- visibility timeout cho job đang chạy,
- retry có giới hạn,
- DLQ cho job lỗi nhiều lần,
- idempotency để duplicate delivery không tạo trạng thái/output hỏng,
- worker crash thì message có thể quay lại queue,
- job state nằm ngoài memory của API process.

Mục tiêu là không còn mô hình `generation_jobs = {}` hoặc `BackgroundTasks` làm nguồn sự thật cho production.

## 7. Burst traffic và autoscaling

Hệ thống phải có khả năng nhận burst lớn mà không làm mất request. Tuy nhiên mục tiêu product hiện tại còn yêu cầu job đã được chấp nhận phải trả đủ 6 ảnh trong **<= 15 giây** ở tải nằm trong capacity đã công bố. Vì vậy cần phân biệt rõ **durability của queue** với **latency capacity của GPU fleet**.

Ví dụ khi có 1.000 request gần như đồng thời:

```text
1.000 requests
      ↓
master nhận + persist + enqueue
      ↓
SQS giữ 1.000 jobs
      ↓
GPU fleet xử lý dần theo capacity hiện tại
```

Flow trên bảo đảm hấp thụ burst, nhưng nếu 1.000 request tới gần như cùng lúc thì autoscaling bắt đầu sau khi queue tăng không thể tự bảo đảm cả 1.000 job đều hoàn tất trong 15 giây. EC2/container/model cold-start nằm ngoài latency budget này. Muốn giữ SLA tức thời phải có **warm capacity đã sẵn sàng inference trước khi burst tới**, hoặc một GPU phải xử lý được nhiều job trong cùng cửa sổ SLA nhờ concurrency/batching đã benchmark.

Autoscaler nên dựa ít nhất trên:

- queue depth,
- tuổi của message cũ nhất,
- số worker đang active,
- GPU utilization,
- p50/p95 processing latency,
- failure rate.

Autoscaling production nên có hai tầng:

- **warm floor**: số worker tối thiểu đang running, container sống và model đã load; đây là capacity chịu trách nhiệm cho SLA 15 giây của traffic tức thời và phải có N+1 headroom/reserve đủ để một worker lỗi không làm mất toàn bộ latency headroom,
- **elastic burst capacity**: worker bổ sung được scale-out khi queue depth/queue age tăng; tầng này bảo vệ SLA khi traffic cao kéo dài nhưng không thay thế warm floor cho burst đột ngột.

Không scale từ 0 nếu vẫn tuyên bố SLA <=15 giây. `min_workers` phải được xác định từ p95/p99 arrival rate và benchmark throughput thực tế trên L4. Nếu có traffic theo lịch hoặc sự kiện dự đoán được, pre-scale trước khi traffic bắt đầu để tránh trả idle cost cả ngày.

Capacity phải được tính theo throughput trong cửa sổ SLA, không chỉ theo jobs/giờ:

```text
jobs_per_worker_in_sla = floor(15s / p95_processing_seconds)
warm_workers_required   = ceil(expected_burst_jobs / jobs_per_worker_in_sla)
```

Khi benchmark L4 phải test cả 1-job-at-a-time và multi-job concurrency/dynamic batching. Chỉ tăng concurrency nếu throughput tăng mà p95 latency vẫn <=15 giây, VRAM không OOM và failure rate không tăng.

Chi phí và capacity cụ thể được tách riêng trong [production-cost-estimate.md](./production-cost-estimate.md).

## 8. Local development

Local mode giữ cùng boundary giữa ba application nhưng dùng adapter local thay AWS:

```text
internal/web-client
    ↓
master local
    ↓
local job store + local queue + local storage
    ↓
runner trên Mac / MPS
```

Hiện local adapters dùng shared runtime dưới `runner/.runtime` để Master process và Runner runtime có thể chạy độc lập mà vẫn chia sẻ durable state cho dev/smoke test.

Chạy toàn bộ local stack:

```bash
bash internal/scripts/dev-stack.sh
```

## 9. Deployment boundary

Ba application phải deploy độc lập:

```text
internal/web-client → internal benchmark only
master       → CPU service deployment
runner       → GPU worker deployment
```

Nguyên tắc:

- scale web không ảnh hưởng API/GPU,
- scale API không tạo thêm GPU,
- scale GPU không cần restart API,
- GPU worker không phụ thuộc session/user frontend,
- API không cần biết worker cụ thể nào đang xử lý job.

## 10. Acceptance cho production architecture

Trước khi coi kiến trúc production hoàn tất cần kiểm tra:

- burst 100, 500 và 1.000 request enqueue được ổn định,
- API restart không mất job,
- worker crash giữa job có thể recovery/retry,
- duplicate queue delivery không làm hỏng output,
- retry exhausted đi vào DLQ và job chuyển `failed`,
- nhiều GPU worker có thể consume song song,
- autoscaling có min/max rõ ràng,
- có warm floor được tính từ p95/p99 traffic và SLA <=15 giây; không dựa vào cold scale-out để đáp ứng burst tức thời,
- warm floor có failure headroom/N+1 để một worker restart/crash không tạo user-visible failure ngay lập tức,
- metrics đủ để theo dõi queue wait, processing latency, failure và GPU utilization,
- có dashboard/alarm cho p95/p99 end-to-end latency, oldest-message age và số job vượt 15 giây,
- load test chứng minh các burst size đã công bố vẫn đạt latency target và không có user-visible failure ở tải nằm trong capacity,
- benchmark NVIDIA L4 được dùng để chốt capacity và chi phí thực tế.
