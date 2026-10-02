# Internal tooling

Thư mục này chỉ chứa công cụ phát triển và benchmark nội bộ. Nó không được
đóng gói khi triển khai Master hoặc Runner production.

- `web-client/`: giao diện benchmark local.
- `benchmark-api/`: các endpoint benchmark/multipart chỉ được nạp khi chạy local.
- `worker/`: worker local dùng queue và storage trên máy.
- `scripts/`: setup, doctor và dev stack local.
- `Makefile`: entrypoint duy nhất cho các lệnh local.
- `docs/`: hướng dẫn benchmark và sơ đồ boundary repository.

Chạy từ repository root:

```bash
make -f internal/Makefile setup
make -f internal/Makefile run
```

Runbook copy-paste đầy đủ nằm trong
[docs/local-runbook.md](docs/local-runbook.md). Benchmark chi tiết nằm trong
[docs/local-benchmark.md](docs/local-benchmark.md).

Production không dùng `internal/`; Master lấy code trong `master/`, còn máy
inference cài Runner từ `runner/`.
