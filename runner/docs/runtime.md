# Avatar Runner Runtime

Python worker that owns preprocessing, LivePortrait inference, cutout and PNG export.

The staged worker keeps one long-lived LivePortrait process. CPU preprocessing,
GPU decode and export use bounded internal queues, so a later job can prepare while
an earlier job is decoding. Compatible prepared jobs are grouped only at the GPU
decode stage; a single ready job is still dispatched after the short batch window.

Staged pipeline defaults:

- `AVATAR_PIPELINE_MODE=staged`
- `AVATAR_PREPROCESS_WORKERS=2`
- `AVATAR_EXPORT_WORKERS=2`
- `AVATAR_PREPROCESS_QUEUE_SIZE=6`
- `AVATAR_DECODE_QUEUE_SIZE=6`
- `AVATAR_MAX_DECODE_BATCH=3` jobs
- `AVATAR_DECODE_BATCH_WAIT_MS=25`
- `AVATAR_DECODE_BATCH_SIZE` remains the expression-item chunk size for each
  torch decode call (24 in the local defaults); `AVATAR_MAX_DECODE_BATCH` limits
  how many jobs can enter the coordinator group. CUDA automatically splits on OOM.
- `AVATAR_ONNX_THREADS` is a total session thread budget; staged preprocessing
  divides it across its worker count.

Production runs the cross-platform Runner agent from `runner/`. The native
installer starts `runner.agent.main` and keeps the process connected to Master.
