# Kiến trúc tổng thể Avatar Studio

Tài liệu này mô tả kiến trúc hệ thống sau khi tách repository thành ba application độc lập:

```text
avatar-studio/
├── api-server/    NestJS / TypeScript / CPU
├── gpu-service/   Python / PyTorch / LivePortrait / GPU
└── web-client/    React / TypeScript / Vite
```

Mục tiêu chính là tách hoàn toàn HTTP/API orchestration khỏi GPU inference để web, API và GPU có thể deploy và scale độc lập.

## 1. Ba khối chính

### web-client

`web-client` là React + Vite application mà người dùng tương tác trực tiếp.

Trách nhiệm:

- chọn/upload ảnh,
- gửi yêu cầu tạo bộ biểu cảm,
- nhận `jobId`,
- polling trạng thái job,
- hiển thị `queued`, `processing`, `completed`, `failed`,
- hiển thị và tải các PNG kết quả.

Web chỉ giao tiếp với `api-server`. Web không biết SQS, S3, DynamoDB hay GPU worker tồn tại.

### api-server

`api-server` là NestJS service chạy CPU.

Trách nhiệm:

- nhận HTTP request từ web/client,
- validate input,
- tạo `jobId`,
- lưu ảnh input qua storage adapter,
- tạo persistent job record,
- enqueue generation message,
- trả trạng thái và output metadata cho client.

API không load LivePortrait, không chạy Python inference và không cần GPU.

### gpu-service

`gpu-service` là Python worker sở hữu toàn bộ ML/CV pipeline.

Trách nhiệm:

- consume generation job,
- claim/update trạng thái job,
- download/read ảnh input,
- preprocess ảnh,
- chạy LivePortrait,
- tạo 6 biểu cảm,
- cutout/matting/export PNG,
- upload/store output,
- cập nhật progress và kết quả,
- ack job sau khi xử lý thành công.

Python được giữ cho cục GPU vì pipeline hiện tại dựa trên PyTorch, LivePortrait, OpenCV, NumPy và ONNX Runtime.

## 2. Kiến trúc production

```text
                         ┌─────────────────────┐
                         │     web-client      │
                         │   React / Vite      │
                         └──────────┬──────────┘
                                    │ HTTPS
                                    ▼
                         ┌─────────────────────┐
                         │     api-server      │
                         │ NestJS / CPU        │
                         └───┬────────┬────────┘
                             │        │
                    job/meta │        │ input/output
                             ▼        ▼
                    ┌────────────┐  ┌────────────┐
                    │ DynamoDB   │  │     S3     │
                    │ Job Store  │  │  Storage   │
                    └─────▲──────┘  └─────▲──────┘
                          │               │
                          │               │
                    ┌─────┴───────────────┴─────┐
                    │       gpu-service         │
                    │ Python GPU Worker         │
                    │ LivePortrait loaded once  │
                    └───────────▲───────────────┘
                                │
                                │ consume / ack
                                │
                         ┌──────┴──────┐
                         │     SQS     │
                         │ generation │
                         └──────┬──────┘
                                │ retry exhausted
                                ▼
                         ┌─────────────┐
                         │   SQS DLQ   │
                         └─────────────┘
```

Production mapping dự kiến:

| Thành phần | Công nghệ / hạ tầng |
| --- | --- |
| Web | React/Vite, static hosting + CDN |
| API | NestJS container trên CPU compute, ví dụ ECS Fargate |
| Input/output | S3 |
| Job state | DynamoDB |
| Queue | SQS |
| Retry exhausted | SQS DLQ |
| GPU worker | Python container trên EC2 GPU, ban đầu ưu tiên g6.xlarge |
| Metrics/logs | CloudWatch |

## 3. Luồng tạo một job

```text
User chọn ảnh
    ↓
web-client
    ↓ POST create job
api-server
    ├─ validate
    ├─ tạo jobId
    ├─ lưu input
    ├─ tạo job record
    └─ enqueue
    ↓
202 + jobId
    ↓
web-client polling GET job

SQS
    ↓
gpu-service
    ├─ claim job
    ├─ processing
    ├─ preprocess
    ├─ LivePortrait
    ├─ cutout/export
    ├─ lưu outputs
    ├─ completed
    └─ ack message

web-client
    ↓
GET job → completed + output URLs
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
api-server nhận + persist + enqueue
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
web-client
    ↓
api-server local
    ↓
local job store + local queue + local storage
    ↓
gpu-service trên Mac / MPS
```

Hiện local adapters dùng shared runtime dưới `gpu-service/.runtime` để API process và GPU worker có thể chạy độc lập mà vẫn chia sẻ durable state cho dev/smoke test.

Chạy toàn bộ local stack:

```bash
bash scripts/dev-stack.sh
```

## 9. Deployment boundary

Ba application phải deploy độc lập:

```text
web-client   → static web deployment
api-server   → CPU container deployment
gpu-service  → GPU worker deployment
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
