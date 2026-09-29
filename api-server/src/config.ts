import path from 'node:path'

export type InfrastructureMode = 'local' | 'aws'

export type AppConfig = {
  port: number
  infrastructureMode: InfrastructureMode
  runtimeRoot: string
  corsOrigins: string[]
  awsRegion: string
  awsBucket?: string
  awsQueueUrl?: string
  awsJobsTable?: string
}

function envInt(name: string, fallback: number) {
  const value = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(value) ? value : fallback
}

export function loadConfig(): AppConfig {
  const infrastructureMode = (process.env.AVATAR_INFRA_MODE ?? 'local').trim().toLowerCase()
  if (infrastructureMode !== 'local' && infrastructureMode !== 'aws') {
    throw new Error('AVATAR_INFRA_MODE must be local or aws')
  }
  return {
    port: envInt('PORT', 8000),
    infrastructureMode,
    runtimeRoot: path.resolve(
      process.env.AVATAR_RUNTIME_ROOT ?? path.join(process.cwd(), '..', 'gpu-service', '.runtime'),
    ),
    corsOrigins: (process.env.AVATAR_CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    awsRegion: process.env.AWS_REGION ?? 'ap-southeast-1',
    awsBucket: process.env.AVATAR_S3_BUCKET,
    awsQueueUrl: process.env.AVATAR_SQS_QUEUE_URL,
    awsJobsTable: process.env.AVATAR_DYNAMODB_JOBS_TABLE,
  }
}

export const APP_CONFIG = Symbol('APP_CONFIG')
