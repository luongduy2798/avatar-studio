# Avatar Studio API Server

NestJS CPU service for job submission and status reads.

Local mode stores job records, queue messages and files under the shared gpu-service/.runtime directory.
AWS mode uses S3, SQS and DynamoDB.

Run locally with npm install --package-lock=false and then npm run dev.

Run the complete local stack from the repository root with:

bash api-server/scripts/dev-stack.sh

The local dev stack resets jobs, queues, temporary work and generated outputs
when it starts. Model caches and virtual environments are kept.

The local benchmark API is available at `/api/v1/benchmarks`. It persists the
parent run, child jobs, queue messages and files under the shared
`gpu-service/.runtime` directory, so no external database is required for local
benchmarking.
