# Repository layout

Production code is split into two deployable units:

```text
master/
  src/                 Public API, Admin API, scheduler and Runner WSS gateway
  package.json         Node.js dependencies for Avatar Master
  deploy/              PM2, Nginx and Master deployment launchers
  Dockerfile           Optional Master container image

runner/
  agent/               WSS agent, enrollment and heartbeat
  runtime/             Python inference pipeline and LivePortrait adapter
  setup-liveportrait-*  Model/runtime setup for the runner machine
  install-*            Native installers for Unix and Windows
  Dockerfile           Optional runner container image

internal/
  web-client/           Internal benchmark UI only
  benchmark-api/        Local-only benchmark and multipart controllers
  worker/               Local queue worker and infrastructure adapters
  scripts/              Local benchmark/setup scripts
  Makefile              Local setup and benchmark entrypoint
```

Deploying Master requires only `master/` and its Node.js environment. Deploying
a Runner requires only `runner/`, the LivePortrait model/runtime and machine
dependencies such as Python, FFmpeg and the GPU driver. Neither production
service needs `internal/web-client/`.

For local benchmarking, `internal/scripts/dev-stack.sh` sets
`AVATAR_LOCAL_BENCHMARKS=1`, starts Master with the local-only benchmark module
and starts the local Runner runtime. Disposable state is stored in
`runner/.runtime`.
