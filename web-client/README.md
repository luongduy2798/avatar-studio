# Avatar Studio Web Client

React + TypeScript + Vite UI. It talks only to the NestJS API and has no direct
dependency on SQS, S3, DynamoDB or the GPU worker.

Run locally with npm install --package-lock=false and then npm run dev.

The **Batch benchmark** panel accepts one uploaded image, a batch size and a
measured-run count. It reports warmup/measured progress, per-job timings and
allows downloading JSON/CSV reports.
