# Avatar Studio API Server

NestJS CPU service for job submission and status reads.

Local mode stores job records, queue messages and files under the shared gpu-service/.runtime directory.
AWS mode uses S3, SQS and DynamoDB.

Run locally with npm install --package-lock=false and then npm run dev.

Run the complete local stack from the repository root with:

bash api-server/scripts/dev-stack.sh
