import path from 'node:path'

export type InfrastructureMode = 'local' | 'aws'

export type AppConfig = {
  port: number
  masterEnabled: boolean
  infrastructureMode: InfrastructureMode
  runtimeRoot: string
  corsOrigins: string[]
  awsRegion: string
  awsBucket?: string
  awsQueueUrl?: string
  awsDlqUrl?: string
  awsJobsTable?: string
  awsRunnersTable?: string
  awsEnrollmentsTable?: string
  awsIdempotencyTable?: string
  adminToken?: string
  moodlabApiKeys: string[]
  runnerWsPath: string
  runnerHeartbeatTimeoutSeconds: number
  runnerLeaseSeconds: number
  maxAttempts: number
  runnerVersion: string
  publicUrl: string
}

function envInt(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

function envBool(name: string, fallback: boolean) {
  const value = process.env[name]
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function loadConfig(): AppConfig {
  const infrastructureMode = (process.env.AVATAR_INFRA_MODE ?? 'local').trim().toLowerCase()
  if (infrastructureMode !== 'local' && infrastructureMode !== 'aws') {
    throw new Error('AVATAR_INFRA_MODE must be local or aws')
  }
  return {
    port: envInt('PORT', 8000),
    masterEnabled: envBool('AVATAR_MASTER_ENABLED', infrastructureMode === 'aws'),
    infrastructureMode,
    runtimeRoot: path.resolve(
      process.env.AVATAR_RUNTIME_ROOT ?? path.join(process.cwd(), '.runtime'),
    ),
    corsOrigins: (process.env.AVATAR_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    awsRegion: process.env.AWS_REGION ?? 'ap-southeast-1',
    awsBucket: process.env.AVATAR_S3_BUCKET,
    awsQueueUrl: process.env.AVATAR_SQS_QUEUE_URL,
    awsDlqUrl: process.env.AVATAR_SQS_DLQ_URL,
    awsJobsTable: process.env.AVATAR_DYNAMODB_JOBS_TABLE,
    awsRunnersTable: process.env.AVATAR_DYNAMODB_RUNNERS_TABLE,
    awsEnrollmentsTable: process.env.AVATAR_DYNAMODB_ENROLLMENTS_TABLE,
    awsIdempotencyTable: process.env.AVATAR_DYNAMODB_IDEMPOTENCY_TABLE,
    adminToken: process.env.AVATAR_ADMIN_TOKEN,
    moodlabApiKeys: (process.env.AVATAR_MOODLAB_API_KEYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    runnerWsPath: process.env.AVATAR_RUNNER_WS_PATH ?? '/runner/ws',
    runnerHeartbeatTimeoutSeconds: envInt('AVATAR_RUNNER_HEARTBEAT_TIMEOUT_SECONDS', 30),
    runnerLeaseSeconds: envInt('AVATAR_RUNNER_LEASE_SECONDS', 900),
    maxAttempts: Math.max(1, envInt('AVATAR_MAX_ATTEMPTS', 3)),
    runnerVersion: process.env.AVATAR_RUNNER_VERSION ?? '1.0.0',
    publicUrl: process.env.AVATAR_PUBLIC_URL ?? 'http://127.0.0.1:8000',
  }
}

export const APP_CONFIG = Symbol('APP_CONFIG')
