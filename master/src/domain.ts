export const expressionIds = [
  'unbothered',
  'locked_in',
  'cracking_up',
  'full_panic',
  'big_winner',
  'spectacular_flop',
] as const

export type ExpressionId = (typeof expressionIds)[number]
export type JobStatus =
  | 'queued'
  | 'assigned'
  | 'processing'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled'
export type JobStage =
  | 'queued'
  | 'assigned'
  | 'preprocess'
  | 'materialize'
  | 'crop'
  | 'matte'
  | 'feature'
  | 'decode'
  | 'expressions'
  | 'export'
  | 'uploading'
  | 'finalize'
  | 'retrying'
  | 'completed'
  | 'failed'

export type JobOutput = {
  expression: ExpressionId
  key: string
}

export type JobPhase = 'warmup' | 'measure'

export type JobTimings = Record<string, number>

export type GenerationJob = {
  kind?: 'generation' | 'benchmark-job'
  jobId: string
  status: JobStatus
  stage: JobStage
  generator: 'liveportrait'
  expressions: ExpressionId[]
  intensity: number
  inputKey: string
  uploadId?: string
  clientId?: string
  idempotencyKey?: string
  runnerId?: string | null
  leaseId?: string | null
  leaseExpiresAt?: string | null
  version?: number
  assignedAt?: string | null
  outputs: JobOutput[]
  progress: {
    prepared: number
    completed: number
    total: number
    percent: number
  }
  attempt: number
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
  runId?: string
  jobIndex?: number
  phase?: JobPhase
  repetition?: number
  timings?: JobTimings
}

export type GenerationMessage = {
  version: 1
  kind?: 'generation'
  jobId: string
  inputKey: string
  expressions: ExpressionId[]
  intensity: number
  generator: 'liveportrait'
  clientId?: string
  idempotencyKey?: string
}

export type BenchmarkRunStatus = 'queued' | 'processing' | 'completed' | 'failed'

export type BenchmarkProgress = {
  totalJobs: number
  completedJobs: number
  failedJobs: number
  totalExpressions: number
  completedExpressions: number
  percent: number
}

export type BenchmarkMetrics = {
  totalSeconds: number | null
  warmupSeconds: number | null
  measuredSeconds: number | null
  batchSeconds: number | null
  measuredJobs: number
  successfulJobs: number
  failedJobs: number
  jobsPerSecond: number | null
  expressionsPerSecond: number | null
  latencySeconds: number[]
  p50Seconds: number | null
  p95Seconds: number | null
  device: string | null
  gpuName: string | null
  peakMemoryMb: number | null
}

export type BenchmarkRun = {
  kind: 'benchmark'
  runId: string
  status: BenchmarkRunStatus
  batchSize: number
  warmupRuns: number
  measuredRuns: number
  expressions: ExpressionId[]
  intensity: number
  inputKey: string
  childJobIds: string[]
  progress: BenchmarkProgress
  metrics: BenchmarkMetrics
  error: string | null
  createdAt: string
  updatedAt: string
  startedAt: string | null
  completedAt: string | null
}

export type JobRecord = GenerationJob | BenchmarkRun

export type BenchmarkJobPayload = {
  jobId: string
  inputKey: string
  expressions: ExpressionId[]
  intensity: number
  generator: 'liveportrait'
  phase: JobPhase
  repetition: number
  jobIndex: number
}

export type BenchmarkMessage = {
  version: 1
  kind: 'benchmark'
  runId: string
  groups: Array<{
    phase: JobPhase
    repetition: number
    jobs: BenchmarkJobPayload[]
  }>
}

export type QueuePayload = GenerationMessage | BenchmarkMessage
