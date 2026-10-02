import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import {
  expressionIds,
  type BenchmarkJobPayload,
  type BenchmarkMetrics,
  type BenchmarkRun,
  type ExpressionId,
  type GenerationJob,
} from '../../master/src/domain'
import type { JobStore } from '../../master/src/infrastructure/job-store'
import type { GenerationQueue } from '../../master/src/infrastructure/queue'
import type { Storage } from '../../master/src/infrastructure/storage'
import { JOB_STORE, QUEUE, STORAGE } from '../../master/src/infrastructure/tokens'

const expressionSet = new Set<string>(expressionIds)

function id() {
  return randomUUID().replaceAll('-', '')
}

function emptyMetrics(): BenchmarkMetrics {
  return {
    totalSeconds: null,
    warmupSeconds: null,
    measuredSeconds: null,
    batchSeconds: null,
    measuredJobs: 0,
    successfulJobs: 0,
    failedJobs: 0,
    jobsPerSecond: null,
    expressionsPerSecond: null,
    latencySeconds: [],
    p50Seconds: null,
    p95Seconds: null,
    device: null,
    gpuName: null,
    peakMemoryMb: null,
  }
}

@Injectable()
export class BenchmarksService {
  constructor(
    @Inject(JOB_STORE) private readonly jobStore: JobStore,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(QUEUE) private readonly queue: GenerationQueue,
  ) {}

  parseExpressions(raw: string): ExpressionId[] {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new BadRequestException('expressions must be a JSON array')
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new BadRequestException('Choose at least one expression')
    }
    const values = [...new Set(parsed.map(String))]
    const unsupported = values.filter((value) => !expressionSet.has(value))
    if (unsupported.length) {
      throw new BadRequestException('Unsupported expressions: ' + unsupported.join(', '))
    }
    return values as ExpressionId[]
  }

  async create(
    file: Express.Multer.File,
    expressions: ExpressionId[],
    intensity: number,
    batchSize: number,
    warmupRuns: number,
    measuredRuns: number,
  ) {
    const now = new Date().toISOString()
    const runId = id()
    const extension = file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg'
    const inputKey = await this.storage.putInput(runId, extension, file.buffer, file.mimetype)
    const childJobIds: string[] = []
    const groups: Array<{
      phase: 'warmup' | 'measure'
      repetition: number
      jobs: BenchmarkJobPayload[]
    }> = []

    const run: BenchmarkRun = {
      kind: 'benchmark',
      runId,
      status: 'queued',
      batchSize,
      warmupRuns,
      measuredRuns,
      expressions,
      intensity,
      inputKey,
      childJobIds,
      progress: {
        totalJobs: warmupRuns + measuredRuns * batchSize,
        completedJobs: 0,
        failedJobs: 0,
        totalExpressions: (warmupRuns + measuredRuns * batchSize) * expressions.length,
        completedExpressions: 0,
        percent: 0,
      },
      metrics: emptyMetrics(),
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    }
    await this.jobStore.put(run)

    const createGroup = async (phase: 'warmup' | 'measure', repetition: number) => {
      const jobs: BenchmarkJobPayload[] = []
      const groupSize = phase === 'warmup' ? 1 : batchSize
      for (let index = 0; index < groupSize; index += 1) {
        const jobId = id()
        const job: GenerationJob = {
          kind: 'benchmark-job',
          jobId,
          status: 'queued',
          stage: 'queued',
          generator: 'liveportrait',
          expressions,
          intensity,
          inputKey,
          outputs: [],
          progress: { prepared: 0, completed: 0, total: expressions.length, percent: 0 },
          attempt: 0,
          error: null,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          completedAt: null,
          runId,
          jobIndex: index + 1,
          phase,
          repetition,
        }
        await this.jobStore.put(job)
        childJobIds.push(jobId)
        jobs.push({
          jobId,
          inputKey,
          expressions,
          intensity,
          generator: 'liveportrait',
          phase,
          repetition,
          jobIndex: index + 1,
        })
      }
      groups.push({ phase, repetition, jobs })
    }

    for (let repetition = 1; repetition <= warmupRuns; repetition += 1) {
      await createGroup('warmup', repetition)
    }
    for (let repetition = 1; repetition <= measuredRuns; repetition += 1) {
      await createGroup('measure', repetition)
    }

    run.childJobIds = childJobIds
    await this.jobStore.put(run)
    try {
      await this.queue.publish({ version: 1, kind: 'benchmark', runId, groups })
    } catch (error) {
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : 'Failed to enqueue benchmark run'
      run.updatedAt = new Date().toISOString()
      await this.jobStore.put(run)
      throw error
    }
    return this.toResponse(run)
  }

  async get(runId: string) {
    const record = await this.jobStore.get(runId)
    if (!record || record.kind !== 'benchmark') {
      throw new NotFoundException('Benchmark run not found')
    }
    return this.toResponse(record)
  }

  async exportJson(runId: string) {
    return this.get(runId)
  }

  async exportCsv(runId: string) {
    const payload = await this.get(runId)
    const header = [
      'run_id', 'phase', 'repetition', 'job_index', 'status', 'stage',
      'progress', 'started_at', 'completed_at', 'queue_wait_seconds',
      'processing_seconds', 'elapsed_seconds', 'error',
      'device', 'gpu_name', 'total_seconds', 'warmup_seconds', 'measured_seconds',
      'batch_seconds', 'jobs_per_second', 'p50_seconds', 'p95_seconds',
    ]
    const rows = payload.jobs.map((job) => [
      payload.run_id,
      job.phase ?? '',
      job.repetition ?? '',
      job.job_index ?? '',
      job.status,
      job.stage,
      job.progress,
      job.started_at ?? '',
      job.completed_at ?? '',
      job.queue_wait_seconds ?? '',
      job.processing_seconds ?? '',
      job.timings?.total ?? '',
      job.error ?? '',
      payload.metrics.device ?? '',
      payload.metrics.gpuName ?? '',
      payload.metrics.totalSeconds ?? '',
      payload.metrics.warmupSeconds ?? '',
      payload.metrics.measuredSeconds ?? '',
      payload.metrics.batchSeconds ?? '',
      payload.metrics.jobsPerSecond ?? '',
      payload.metrics.p50Seconds ?? '',
      payload.metrics.p95Seconds ?? '',
    ])
    return [header, ...rows]
      .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
      .join('\n')
  }

  private async toResponse(run: BenchmarkRun) {
    const childRecords = await Promise.all(
      run.childJobIds.map((jobId) => this.jobStore.get(jobId)),
    )
    const jobs = await Promise.all(
      childRecords
        .filter((job): job is GenerationJob => Boolean(job && job.kind !== 'benchmark'))
        .map(async (job) => {
          const createdMs = Date.parse(job.createdAt)
          const startedMs = job.startedAt ? Date.parse(job.startedAt) : NaN
          const completedMs = job.completedAt ? Date.parse(job.completedAt) : NaN
          const queueWaitSeconds = Number.isFinite(createdMs) && Number.isFinite(startedMs)
            ? Math.max(0, (startedMs - createdMs) / 1000)
            : null
          const processingSeconds = Number.isFinite(startedMs) && Number.isFinite(completedMs)
            ? Math.max(0, (completedMs - startedMs) / 1000)
            : null
          return {
            job_id: job.jobId,
            job_index: job.jobIndex,
            phase: job.phase,
            repetition: job.repetition,
            status: job.status,
            stage: job.stage,
            total: job.progress.total,
            completed_count: job.progress.completed,
            prepared_count: job.progress.prepared,
            progress: job.progress.percent / 100,
            outputs: await Promise.all(job.outputs.map(async (output) => ({
              expression: output.expression,
              url: await this.storage.resultUrl(output.key),
            }))),
            timings: job.timings ?? {},
            started_at: job.startedAt,
            completed_at: job.completedAt,
            queue_wait_seconds: queueWaitSeconds,
            processing_seconds: processingSeconds,
            error: job.error,
          }
        }),
    )
    return {
      run_id: run.runId,
      status: run.status,
      batch_size: run.batchSize,
      warmup_runs: run.warmupRuns,
      measured_runs: run.measuredRuns,
      expressions: run.expressions,
      intensity: run.intensity,
      progress: run.progress,
      metrics: run.metrics,
      created_at: run.createdAt,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      error: run.error,
      jobs,
    }
  }
}
