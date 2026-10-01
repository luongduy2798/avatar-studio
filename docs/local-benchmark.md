# Local batch benchmark

Avatar Studio can benchmark one machine at a time without Docker or an external
database. The web client, API server and GPU worker share the local
`gpu-service/.runtime` directory.

## macOS

```bash
make setup
make doctor
make run
```

Apple Silicon uses MPS when available. Intel Macs use the CPU fallback.

## Ubuntu server

Install Python 3.10, Node.js, Git and FFmpeg first. For CUDA benchmarking,
install a compatible NVIDIA driver and confirm that `nvidia-smi` works.

```bash
make setup PLATFORM=ubuntu
make doctor PLATFORM=ubuntu
make run PLATFORM=ubuntu
```

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

## Storage

Local mode stores job records, queue messages, input files and output files under
`gpu-service/.runtime`. Delete that directory to clear old benchmark data.

Docker is optional for later Ubuntu reproducibility. It is not required for the
native macOS or Ubuntu benchmark flow.

`make run` starts a fresh local session. It clears local jobs, queue messages,
temporary work and generated outputs before starting the services. The
LivePortrait model cache and virtual environments are kept, so this reset does
not reinstall the model.
