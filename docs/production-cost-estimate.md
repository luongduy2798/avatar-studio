# Production speed & cost estimate

Ngày estimate: **2026-09-29**

Mục tiêu production: mỗi job tạo đủ **6 biểu cảm** trong **<= 15 giây**.

## AWS g6.xlarge / NVIDIA L4

- GPU: NVIDIA L4 24 GB VRAM
- Giá On-Demand tham chiếu: **$0.8048/giờ**
- Chạy 24/7: khoảng **$587.50/tháng / GPU**
- Cộng storage, logs, network và hạ tầng nhỏ khác: nên dự trù khoảng **$610-650/tháng / GPU**

## Estimate tốc độ

Đây là **estimate cho L4**, chưa phải benchmark CUDA thật.

| Tải trên 1 L4 | Latency estimate | Capacity trong 15s |
| --- | ---: | ---: |
| 1 job | ~4-6s | 1 job |
| 2 job batch | ~5-7s | 2 job |
| **4 job batch** | **~7-10s** | **4 job** |
| 8 job batch | ~11-15s | 8 job, sát SLA |

Mức dùng để planning ban đầu:

- **Safe estimate:** 4 job / 15s / L4
- **Kỳ vọng nếu CUDA batching tốt:** 6-8 job / 15s / L4
- Không nên planning production cao hơn 8 job / 15s trước khi benchmark thật.

## Chi phí theo throughput

Nếu GPU được tận dụng liên tục:

| Capacity | Throughput | Compute / 1.000 jobs |
| --- | ---: | ---: |
| 4 job / 15s | ~960 job/giờ | **~$0.84** |
| 6 job / 15s | ~1.440 job/giờ | **~$0.56** |
| 8 job / 15s | ~1.920 job/giờ | **~$0.42** |

Các số trên là chi phí compute khi GPU bận liên tục. Nếu instance vẫn running nhưng ít jobs thì AWS vẫn tính theo số giờ instance chạy.

## Estimate theo lượng user thực tế

DAU chỉ cho biết quy mô user. Để sizing GPU cần quy đổi theo chuỗi:

**DAU -> jobs/user/day -> jobs/day -> peak jobs/min -> concurrent jobs -> số L4 -> cost/tháng**.

### Giả định planning

Các bảng dưới đây dùng cùng một bộ giả định để dễ so sánh:

- **2 jobs / user / ngày**.
- Traffic peak = **5x traffic trung bình**.
- Safe capacity = **4 jobs / 15s / L4 = 16 jobs/phút/L4**.
- Peak GPU planning có khoảng **20% headroom**.
- Giữ một lượng GPU warm theo tải trung bình và autoscale lên peak.
- Cost planning giả định peak kéo dài khoảng **2 giờ/ngày**, tháng 30 ngày.
- Giá compute dùng **$0.8048/giờ/L4**; chưa cộng VAT và data transfer lớn.

Đây là baseline để planning, không phải dự báo traffic thật. Khi có production telemetry thì thay trực tiếp jobs/user/day và peak factor bằng số đo thật.

### 1. User scale -> traffic

| Scenario | DAU | Jobs/user/day | Jobs/day | Avg jobs/min | Peak jobs/min (5x) | Peak concurrent jobs trong 15s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Small | 1.000 | 2 | 2.000 | ~1,4 | ~6,9 | ~1,7 |
| Medium | 10.000 | 2 | 20.000 | ~13,9 | ~69,4 | ~17,4 |
| Large | 50.000 | 2 | 100.000 | ~69,4 | ~347,2 | ~86,8 |
| Very large | 100.000 | 2 | 200.000 | ~138,9 | ~694,4 | ~173,6 |

`Peak concurrent jobs` ở đây là số jobs dự kiến đến trong một cửa sổ SLA 15 giây tại giờ cao điểm.

### 2. Peak traffic -> GPU sizing

Sizing bên dưới dùng safe capacity **16 jobs/phút/L4**, chưa dùng mức kỳ vọng 6-8 jobs/15s cho tới khi benchmark CUDA thật.

| Scenario | Peak jobs/min | L4 tối thiểu tại peak | L4 planning +20% | Warm L4 theo tải trung bình |
| --- | ---: | ---: | ---: | ---: |
| Small | ~6,9 | 1 | 2 | 1 |
| Medium | ~69,4 | 5 | 6 | 2 |
| Large | ~347,2 | 22 | 27 | 6 |
| Very large | ~694,4 | 44 | 53 | 11 |

`Warm L4` là baseline để tránh cold start và chịu tải trung bình. Khi traffic tăng, autoscaling bổ sung GPU tới mức peak planning.

### 3. Monthly cost estimate

Có hai số cost cần nhìn riêng:

- **Ideal compute:** giả sử GPU luôn được fill gần 100%, chỉ tính đúng số GPU-hours cần để xử lý volume jobs.
- **Planning compute:** giữ số warm GPU 24/7 và scale lên mức peak planning khoảng 2 giờ/ngày.

| Scenario | Jobs/tháng | Ideal GPU-hours | Ideal compute/tháng | Planning GPU-hours | Planning compute/tháng |
| --- | ---: | ---: | ---: | ---: | ---: |
| Small | 60.000 | ~62,5h | **~$50** | ~780h | **~$628** |
| Medium | 600.000 | ~625h | **~$503** | ~1.680h | **~$1.352** |
| Large | 3.000.000 | ~3.125h | **~$2.515** | ~5.580h | **~$4.491** |
| Very large | 6.000.000 | ~6.250h | **~$5.030** | ~10.440h | **~$8.402** |

Planning compute ở trên mới là **GPU compute**. Khi cộng storage, logs, network, queue/API và monitoring, nên thêm khoảng **5-10% buffer hạ tầng** ở giai đoạn estimate ban đầu; data transfer lớn cần tính riêng theo traffic thật.

Điểm quan trọng là **DAU không trực tiếp quyết định số GPU**. Hai hệ thống cùng 100.000 DAU có thể cần số GPU rất khác nhau nếu jobs/user/day hoặc mức dồn traffic giờ cao điểm khác nhau.

## Extreme burst: 1.000 jobs cùng lúc

Đây là stress case riêng, không dùng làm baseline cho traffic bình thường. Nếu 1.000 jobs đến gần như đồng thời và tất cả đều phải hoàn tất trong <=15s:

| Safe capacity / L4 | GPU tối thiểu | Planning có headroom |
| --- | ---: | ---: |
| 4 jobs / 15s | 250 | ~275-300 |
| 6 jobs / 15s | 167 | ~185-200 |
| 8 jobs / 15s | 125 | ~140-150 |

Chỉ nên dùng bảng này cho event/burst đặc biệt. Traffic production bình thường nên sizing từ **peak jobs/min** như các bảng phía trên.

## Benchmark local hiện tại

Mac/MPS steady-state hiện khoảng:

- worker processing: **~14.43s/job**
- end-to-end local: **~15.38s/job**

Batch lớn trên MPS chạy tệ do MPS/CPU fallback, nên **không dùng số Mac để suy ra capacity L4**.

## Việc cần benchmark trên L4

Chạy cùng pipeline với batch 1 / 2 / 4 / 8 và đo:

- p50 / p95 / p99 latency
- jobs / 15s
- peak VRAM
- GPU utilization
- OOM / retry / error rate

Chỉ tăng capacity production khi **p95 vẫn <=15s** và không có OOM/error đáng kể.

Mốc mặc định trước khi có benchmark thật: **1 L4 = safe capacity 4 concurrent jobs / 15s**.

## Nguồn giá

- AWS G6: https://aws.amazon.com/ec2/instance-types/g6/
- AWS On-Demand: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-on-demand-instances.html
