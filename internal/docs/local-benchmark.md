# Local batch benchmark

Avatar Studio can benchmark one machine at a time without Docker or an external
database. The web client and the local Master/Runner processes share the local
`runner/.runtime` directory.

The internal dev stack sets `AVATAR_LOCAL_BENCHMARKS=1`; production Master keeps
this flag off and does not load the benchmark-only endpoints.

## macOS

```bash
make -f internal/Makefile setup
make -f internal/Makefile doctor
make -f internal/Makefile run
```

Apple Silicon uses MPS when available. Intel Macs use the CPU fallback.

## Ubuntu server

Install Python 3.10, Node.js, Git and FFmpeg first. For CUDA benchmarking,
install a compatible NVIDIA driver and confirm that `nvidia-smi` works.

```bash
make -f internal/Makefile setup PLATFORM=ubuntu
make -f internal/Makefile doctor PLATFORM=ubuntu
make -f internal/Makefile run PLATFORM=ubuntu
```

Without `make`, run these two commands from the repository root:

```bash
bash internal/scripts/setup-ubuntu.sh
AVATAR_SKIP_SETUP=1 bash internal/scripts/dev-stack.sh
```

The second command starts a fresh local session each time, clearing old jobs,
queue messages and generated outputs. From another computer, connect with an
SSH tunnel (`ssh -L 5173:127.0.0.1:5173 -L 8000:127.0.0.1:8000 user@server`)
and open `http://127.0.0.1:5173` in the local browser.

The Ubuntu setup installs PyTorch 2.7 from the CUDA 12.8 wheel channel when
`nvidia-smi` is available, and the CPU wheel channel otherwise. This is needed
for RTX 50-series Blackwell cards. Set
`TORCH_INDEX_URL` to a different PyTorch channel when the server requires it.

## Browser benchmark

Open `http://127.0.0.1:5173`, upload one image, choose expressions, then use the
**Batch benchmark** panel. A run creates one warmup job and the configured
number of measured batches. Each measured batch contains the requested number
of jobs. Every child job uses the same image but performs its own preprocessing
and generation; prepared features are not shared between jobs.

The result includes per-job progress, stage timings, total batch progress,
measured batch wall time, throughput, p50/p95 latency and generated PNGs.
`Total` includes warmup; use `Measured batch` and `Jobs/s · measured` when
comparing batch throughput. JSON and CSV reports are available from the
benchmark panel.

The worker's staged mode keeps one LivePortrait process and batches only the
GPU decode stage. Use the **Staggered load test** panel to send normal requests
one by one (for example, 1,000 ms apart) and compare queue wait, processing,
end-to-end latency and jobs/s per request.

## Storage

Local mode stores job records, queue messages, input files and output files under
`runner/.runtime`. Delete that directory to clear old benchmark data.

Docker is optional for later Ubuntu reproducibility. It is not required for the
native macOS or Ubuntu benchmark flow.

`make -f internal/Makefile run` and the direct dev stack command start a fresh
local session. They clear local jobs, queue messages, temporary work and
generated outputs before starting the services. The LivePortrait model cache
and virtual environments are kept, so this reset does not reinstall the model.
