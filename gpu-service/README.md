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
LIVEPORTRAIT_ROOT="$HOME/.cache/avatar-studio/LivePortrait" \
"$HOME/.cache/avatar-studio/LivePortrait/.venv/bin/python" \
  scripts/benchmark_capacity.py \
  --source .runtime/outputs/<job>/input/source.jpg \
  --cases 1:1,1:6,2:12,4:24
```
