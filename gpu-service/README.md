# Avatar Studio GPU Service

Python worker that owns preprocessing, LivePortrait inference, cutout and PNG export.

The worker pulls a small group of generation messages, prepares each source once,
batches compatible LivePortrait decode work across users, updates durable job state,
uploads outputs, and acknowledges each message only after that job completes.

Production batching defaults:

- `AVATAR_JOB_BATCH_SIZE=4`
- `AVATAR_JOB_BATCH_WAIT_MS=25`
- CUDA decode batch defaults to 24 expression items (4 jobs × 6 expressions) and
  automatically splits the decode batch on CUDA OOM.
- macOS/MPS keeps the safe decode default of 1; use the capacity benchmark to test
  larger MPS decode batches explicitly.

Create a Python 3.10 virtual environment, install requirements.txt, then run:

.venv/bin/python -m app.main

To benchmark multi-user capacity with an existing sample image:

```bash
cd /path/to/avatar-studio
LIVEPORTRAIT_ROOT="$HOME/.cache/avatar-studio/LivePortrait" \
"$HOME/.cache/avatar-studio/LivePortrait/.venv/bin/python" \
  scripts/benchmark_capacity.py \
  --source gpu-service/.runtime/outputs/<job>/input/source.jpg \
  --cases 1:1,1:6,2:12,4:24
```

## Local batch benchmark

The browser benchmark uses one uploaded image and creates one warmup child job,
then N independent child jobs per measured batch. Each child runs the same
expression set without reusing prepared features; the provider can decode the
measured jobs together. The default is one warmup job followed by three
measured batches. Use measured batch wall time and measured jobs/s to compare
throughput; total time includes warmup. Results show per-job progress, stage
timings, output PNGs and can be downloaded as JSON/CSV.

On macOS:

```bash
make setup
make doctor
make run
```

On Ubuntu with NVIDIA CUDA:

```bash
make setup PLATFORM=ubuntu
make doctor PLATFORM=ubuntu
make run PLATFORM=ubuntu
```

Open `http://127.0.0.1:5173`, upload one image, then use **Batch benchmark**.
Docker is optional for Ubuntu and is not required on macOS.
