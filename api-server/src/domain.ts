export const expressionIds = [
  'unbothered',
  'locked_in',
  'cracking_up',
  'full_panic',
  'big_winner',
  'spectacular_flop',
] as const

export type ExpressionId = (typeof expressionIds)[number]
export type JobStatus = 'queued' | 'processing' | 'retrying' | 'completed' | 'failed'
export type JobStage =
  | 'queued'
  | 'preprocess'
  | 'expressions'
  | 'export'
  | 'uploading'
  | 'retrying'
  | 'completed'
  | 'failed'

export type JobOutput = {
  expression: ExpressionId
  key: string
}

export type GenerationJob = {
  jobId: string
  status: JobStatus
  stage: JobStage
  generator: 'liveportrait'
  expressions: ExpressionId[]
  intensity: number
  inputKey: string
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
}

export type GenerationMessage = {
  version: 1
  jobId: string
  inputKey: string
  expressions: ExpressionId[]
  intensity: number
  generator: 'liveportrait'
}
