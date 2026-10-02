export type ExpressionId =
  | 'unbothered'
  | 'locked_in'
  | 'cracking_up'
  | 'full_panic'
  | 'big_winner'
  | 'spectacular_flop'

export type GeneratedExpression = {
  expression: ExpressionId
  url: string
}

type GenerateResponse = {
  job_id: string
  outputs: GeneratedExpression[]
}

type GenerationJobResponse = GenerateResponse & {
  status: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed'
  generator: 'liveportrait'
  stage: 'queued' | 'preprocess' | 'expressions' | 'export' | 'uploading' | 'retrying' | 'completed' | 'failed'
  total: number
  completed: ExpressionId[]
  completed_count: number
  prepared_count: number
  progress: number
  created_at: string
  started_at: string | null
  completed_at: string | null
  queue_wait_seconds: number | null
  processing_seconds: number | null
  timings: Record<string, number>
  error: string | null
}

export type GenerationProgress = {
  completed: number
  prepared: number
  total: number
  percent: number
  stage: GenerationJobResponse['stage']
  queueWaitSeconds?: number | null
  processingSeconds?: number | null
  timings?: Record<string, number>
}

export type BenchmarkOutput = GeneratedExpression

export type BenchmarkJobResult = {
  job_id: string
  job_index: number
  phase: 'warmup' | 'measure'
  repetition: number
  status: 'queued' | 'processing' | 'completed' | 'failed'
  stage: GenerationJobResponse['stage']
  total: number
  completed_count: number
  prepared_count: number
  progress: number
  outputs: BenchmarkOutput[]
  timings: Record<string, number>
  started_at: string | null
  completed_at: string | null
  queue_wait_seconds: number | null
  processing_seconds: number | null
  error: string | null
}

export type BenchmarkResponse = {
  run_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  batch_size: number
  warmup_runs: number
  measured_runs: number
  expressions: ExpressionId[]
  intensity: number
  progress: {
    totalJobs: number
    completedJobs: number
    failedJobs: number
    totalExpressions: number
    completedExpressions: number
    percent: number
  }
  metrics: {
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
  created_at: string
  started_at: string | null
  completed_at: string | null
  error: string | null
  jobs: BenchmarkJobResult[]
}

export type BackendHealth = {
  status: 'ready'
  service: 'avatar-master'
  infrastructure: 'local' | 'aws'
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

export async function generateExpressions(
  image: Blob,
  expressions: ExpressionId[],
  intensity: number,
  onProgress?: (progress: GenerationProgress) => void,
) {
  const form = new FormData()
  const uploadName = image instanceof File ? image.name : (image.type === 'image/png' ? 'source.png' : 'source.jpg')
  form.append('image', image, uploadName)
  form.append('expressions', JSON.stringify(expressions))
  form.append('intensity', intensity.toString())

  const response = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    let message = 'Generate thất bại.'
    try {
      const payload = (await response.json()) as { detail?: string; message?: string | string[] }
      message = payload.detail
        ?? (Array.isArray(payload.message) ? payload.message.join(', ') : payload.message)
        ?? message
    } catch {
      // Keep the generic message for non-JSON errors.
    }
    throw new Error(message)
  }

  let payload = (await response.json()) as GenerationJobResponse
  onProgress?.({
    completed: payload.completed_count,
    prepared: payload.prepared_count,
    total: payload.total,
    percent: Math.round(payload.progress * 100),
    stage: payload.stage,
    queueWaitSeconds: payload.queue_wait_seconds,
    processingSeconds: payload.processing_seconds,
    timings: payload.timings,
  })

  while (payload.status === 'queued' || payload.status === 'processing' || payload.status === 'retrying') {
    await new Promise((resolve) => window.setTimeout(resolve, 750))
    const statusResponse = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs/${payload.job_id}`)
    if (!statusResponse.ok) {
      throw new Error('Không đọc được tiến độ generate.')
    }
    payload = (await statusResponse.json()) as GenerationJobResponse
    onProgress?.({
      completed: payload.completed_count,
      prepared: payload.prepared_count,
      total: payload.total,
      percent: Math.round(payload.progress * 100),
      stage: payload.stage,
      queueWaitSeconds: payload.queue_wait_seconds,
      processingSeconds: payload.processing_seconds,
      timings: payload.timings,
    })
  }

  if (payload.status === 'failed') {
    throw new Error(payload.error ?? 'Generate thất bại.')
  }

  return normalizeGenerateResponse(payload)
}

export type StaggeredJobResult = {
  jobId: string
  status: GenerationJobResponse['status']
  queueWaitSeconds: number | null
  processingSeconds: number | null
  latencySeconds: number | null
  error: string | null
}

export type StaggeredLoadTestResult = {
  submittedJobs: number
  completedJobs: number
  failedJobs: number
  totalSeconds: number
  jobsPerSecond: number | null
  queueWaitP50: number | null
  queueWaitP95: number | null
  processingP50: number | null
  processingP95: number | null
  latencyP50: number | null
  latencyP95: number | null
  jobs: StaggeredJobResult[]
}

export async function runStaggeredLoadTest(
  image: File,
  expressions: ExpressionId[],
  intensity: number,
  jobCount: number,
  gapMs: number,
  onSubmitted?: (count: number, total: number) => void,
): Promise<StaggeredLoadTestResult> {
  const runStarted = performance.now()
  const polling: Array<Promise<StaggeredJobResult>> = []
  let nextSubmission = runStarted

  for (let index = 0; index < jobCount; index += 1) {
    const waitMs = Math.max(0, nextSubmission - performance.now())
    if (waitMs > 0) await new Promise((resolve) => window.setTimeout(resolve, waitMs))
    const form = new FormData()
    form.append('image', image, image.name)
    form.append('expressions', JSON.stringify(expressions))
    form.append('intensity', intensity.toString())
    const response = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs`, {
      method: 'POST',
      body: form,
    })
    if (!response.ok) throw new Error(await response.text() || 'Load test submit thất bại.')
    const initial = await response.json() as GenerationJobResponse
    onSubmitted?.(index + 1, jobCount)
    nextSubmission = Math.max(nextSubmission + gapMs, performance.now())

    polling.push((async () => {
      let payload = initial
      while (payload.status === 'queued' || payload.status === 'processing' || payload.status === 'retrying') {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
        const statusResponse = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs/${payload.job_id}`)
        if (!statusResponse.ok) throw new Error('Không đọc được trạng thái load test.')
        payload = await statusResponse.json() as GenerationJobResponse
      }
      const completedAt = payload.completed_at ? Date.parse(payload.completed_at) : NaN
      const latencySeconds = Number.isFinite(completedAt)
        ? Math.max(0, (completedAt - Date.parse(initial.created_at)) / 1000)
        : null
      return {
        jobId: payload.job_id,
        status: payload.status,
        queueWaitSeconds: payload.queue_wait_seconds,
        processingSeconds: payload.processing_seconds,
        latencySeconds,
        error: payload.error,
      }
    })())
  }

  const jobs = await Promise.all(polling)
  const totalSeconds = Math.max(0.001, (performance.now() - runStarted) / 1000)
  const percentile = (values: Array<number | null>, fraction: number) => {
    const ordered = values.filter((value): value is number => value !== null).sort((a, b) => a - b)
    if (!ordered.length) return null
    const position = (ordered.length - 1) * fraction
    const lower = Math.floor(position)
    const upper = Math.min(lower + 1, ordered.length - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)
  }
  const completedJobs = jobs.filter((job) => job.status === 'completed').length
  return {
    submittedJobs: jobs.length,
    completedJobs,
    failedJobs: jobs.length - completedJobs,
    totalSeconds,
    jobsPerSecond: completedJobs / totalSeconds,
    queueWaitP50: percentile(jobs.map((job) => job.queueWaitSeconds), 0.5),
    queueWaitP95: percentile(jobs.map((job) => job.queueWaitSeconds), 0.95),
    processingP50: percentile(jobs.map((job) => job.processingSeconds), 0.5),
    processingP95: percentile(jobs.map((job) => job.processingSeconds), 0.95),
    latencyP50: percentile(jobs.map((job) => job.latencySeconds), 0.5),
    latencyP95: percentile(jobs.map((job) => job.latencySeconds), 0.95),
    jobs,
  }
}

function normalizeGenerateResponse(payload: GenerateResponse) {
  return {
    ...payload,
    outputs: payload.outputs.map((item) => ({
      ...item,
      url: item.url.startsWith('http') ? item.url : `${apiBaseUrl}${item.url}`,
    })),
  }
}

export async function downloadExpression(output: GeneratedExpression) {
  // The API can use another origin, where an <a download> alone is ignored.
  const response = await fetch(output.url)
  if (!response.ok) throw new Error('Không tải được PNG. Hãy thử lại.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${output.expression}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function runBenchmark(
  image: File,
  expressions: ExpressionId[],
  intensity: number,
  batchSize: number,
  warmupRuns: number,
  measuredRuns: number,
  onUpdate?: (payload: BenchmarkResponse) => void,
) {
  const form = new FormData()
  form.append('image', image, image.name)
  form.append('expressions', JSON.stringify(expressions))
  form.append('intensity', intensity.toString())
  form.append('batchSize', batchSize.toString())
  form.append('warmupRuns', warmupRuns.toString())
  form.append('measuredRuns', measuredRuns.toString())

  const response = await fetch(`${apiBaseUrl}/api/v1/benchmarks`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) throw new Error(await response.text() || 'Benchmark thất bại.')

  let payload = normalizeBenchmarkResponse(await response.json() as BenchmarkResponse)
  onUpdate?.(payload)
  while (payload.status === 'queued' || payload.status === 'processing') {
    await new Promise((resolve) => window.setTimeout(resolve, 750))
    const statusResponse = await fetch(`${apiBaseUrl}/api/v1/benchmarks/${payload.run_id}`)
    if (!statusResponse.ok) throw new Error('Không đọc được tiến độ benchmark.')
    payload = normalizeBenchmarkResponse(await statusResponse.json() as BenchmarkResponse)
    onUpdate?.(payload)
  }
  if (payload.status === 'failed' && payload.error) throw new Error(payload.error)
  return payload
}

export async function downloadBenchmarkReport(runId: string, format: 'json' | 'csv') {
  const response = await fetch(`${apiBaseUrl}/api/v1/benchmarks/${runId}/export?format=${format}`)
  if (!response.ok) throw new Error('Không tải được báo cáo benchmark.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${runId}.${format}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function normalizeBenchmarkResponse(payload: BenchmarkResponse): BenchmarkResponse {
  return {
    ...payload,
    jobs: payload.jobs.map((job) => ({
      ...job,
      outputs: job.outputs.map((output) => ({
        ...output,
        url: output.url.startsWith('http') ? output.url : `${apiBaseUrl}${output.url}`,
      })),
    })),
  }
}

export async function getBackendHealth() {
  const response = await fetch(`${apiBaseUrl}/api/v1/health`)
  if (!response.ok) return null
  return response.json() as Promise<BackendHealth>
}
