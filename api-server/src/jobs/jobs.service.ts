import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { expressionIds, type ExpressionId, type GenerationJob } from '../domain'
import type { JobStore } from '../infrastructure/job-store'
import type { GenerationQueue } from '../infrastructure/queue'
import type { Storage } from '../infrastructure/storage'
import { JOB_STORE, QUEUE, STORAGE } from '../infrastructure/tokens'

const expressionSet = new Set<string>(expressionIds)

@Injectable()
export class JobsService {
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
      throw new Error('expressions must be a JSON array')
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Choose at least one expression')
    }
    const values = [...new Set(parsed.map(String))]
    const unsupported = values.filter((value) => !expressionSet.has(value))
    if (unsupported.length) throw new Error('Unsupported expressions: ' + unsupported.join(', '))
    return values as ExpressionId[]
  }

  async create(
    file: Express.Multer.File,
    expressions: ExpressionId[],
    intensity: number,
  ) {
    const now = new Date().toISOString()
    const jobId = randomUUID().replaceAll('-', '')
    const extension =
      file.mimetype === 'image/png' ? '.png' : file.mimetype === 'image/webp' ? '.webp' : '.jpg'
    const inputKey = await this.storage.putInput(
      jobId,
      extension,
      file.buffer,
      file.mimetype,
    )
    const job: GenerationJob = {
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
    }
    await this.jobStore.put(job)
    try {
      await this.queue.publish({
        version: 1,
        jobId,
        inputKey,
        expressions,
        intensity,
        generator: 'liveportrait',
      })
    } catch (error) {
      job.status = 'failed'
      job.stage = 'failed'
      job.error = error instanceof Error ? error.message : 'Failed to enqueue generation job'
      job.updatedAt = new Date().toISOString()
      await this.jobStore.put(job)
      throw error
    }
    return this.toResponse(job)
  }

  async get(jobId: string) {
    const job = await this.jobStore.get(jobId)
    if (!job) throw new NotFoundException('Generation job not found')
    return this.toResponse(job)
  }

  async readLocalResult(jobId: string, fileName: string) {
    return this.storage.readLocalResult(jobId, fileName)
  }

  private async toResponse(job: GenerationJob) {
    return {
      job_id: job.jobId,
      status: job.status,
      generator: job.generator,
      stage: job.stage,
      total: job.progress.total,
      completed: job.expressions.slice(0, job.progress.completed),
      completed_count: job.progress.completed,
      prepared_count: job.progress.prepared,
      progress: job.progress.percent / 100,
      outputs: await Promise.all(
        job.outputs.map(async (output) => ({
          expression: output.expression,
          url: await this.storage.resultUrl(output.key),
        })),
      ),
      error: job.error,
    }
  }
}
