# Avatar Master

NestJS service containing Moodlab's public API, scheduler, runner registry and
runner WSS gateway.

`master/` is a standalone deployable unit. It does not import the Python runner
or the benchmark web client/API. Production only needs this directory plus its
Node.js dependencies and AWS configuration.

Local-only benchmark and multipart endpoints live under `internal/benchmark-api`
and are loaded only when `AVATAR_LOCAL_BENCHMARKS=1` is set by the internal
development stack.

Production mode uses S3, SQS and DynamoDB. The Master package can be deployed
without the Runner source tree.

Production chạy một entrypoint duy nhất: `npm run start`. Process này chứa
Public API cho Moodlab, Admin API, SQS scheduler và WSS gateway cho Runner.
AWS production bật `AVATAR_MASTER_ENABLED=1`.

Chi tiết cài đặt production nằm trong [docs/production-moodlab.md](docs/production-moodlab.md).

Run locally with `npm install --package-lock=false` and then `npm run dev`.
For the full internal benchmark UI, run `make -f internal/Makefile run` from the
repository root so the local-only module is enabled.
