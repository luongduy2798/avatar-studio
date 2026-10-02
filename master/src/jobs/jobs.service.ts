import { Inject, Injectable, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { expressionIds, type ExpressionId, type GenerationJob } from '../domain'
import type { IdempotencyStore } from '../infrastructure/idempotency'
import type { JobStore } from '../infrastructure/job-store'
import type { GenerationQueue } from '../infrastructure/queue'
import type { Storage } from '../infrastructure/storage'
import { IDEMPOTENCY, JOB_STORE, QUEUE, STORAGE } from '../infrastructure/tokens'

const expressionSet = new Set<string>(expressionIds)

@Injectable()
export class JobsService {
  constructor(
    @Inject(JOB_STORE) private readonly jobStore: JobStore,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(QUEUE) private readonly queue: GenerationQueue,
    @Inject(IDEMPOTENCY) private readonly idempotency: IdempotencyStore,
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
      kind: 'generation',
      jobId,
      status: 'queued',
      stage: 'queued',
      generator: 'liveportrait',
      expressions,
      intensity,
      inputKey,
      clientId: 'local-benchmark',
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
        kind: 'generation',
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

  async initUpload(contentType: string, extension = '') {
    const uploadId = 'upload_' + randomUUID().replaceAll('-', '')
    return {
      uploadId,
      ...(await this.storage.createUpload(uploadId, extension, contentType)),
      expiresInSeconds: 900,
    }
  }

  async createFromUpload(
    uploadId: string,
    expressions: ExpressionId[],
    intensity: number,
    clientId: string,
    idempotencyKey: string,
  ) {
    if (!/^upload_[a-zA-Z0-9]+$/.test(uploadId)) {
      throw new Error('upload_id is invalid')
    }
    const existing = await this.idempotency.get(clientId, idempotencyKey)
    if (existing) {
      const job = await this.jobStore.get(existing.jobId)
      if (job) return this.toResponse(job)
    }
    const inputKey = 'inputs/' + uploadId + '/source'
    const inputInfo = await this.storage.objectInfo(inputKey)
    if (!inputInfo) {
      throw new Error('Uploaded input is not ready')
    }
    if (inputInfo.size <= 0 || inputInfo.size > 25 * 1024 * 1024) {
      throw new Error('Uploaded input must be between 1 byte and 25 MB')
    }
    if (inputInfo.contentType && !['image/jpeg', 'image/png', 'image/webp'].includes(inputInfo.contentType)) {
      throw new Error('Uploaded input must be JPEG, PNG or WebP')
    }
    const now = new Date().toISOString()
    const jobId = 'job_' + randomUUID().replaceAll('-', '')
    const job: GenerationJob = {
      kind: 'generation',
      jobId,
      status: 'queued',
      stage: 'queued',
      generator: 'liveportrait',
      expressions,
      intensity,
      inputKey,
      uploadId,
      clientId,
      idempotencyKey,
      runnerId: null,
      leaseId: null,
      leaseExpiresAt: null,
      version: 1,
      assignedAt: null,
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
    await this.idempotency.put({
      clientId,
      key: idempotencyKey,
      jobId,
      createdAt: now,
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    })
    try {
      await this.queue.publish({
        version: 1,
        kind: 'generation',
        jobId,
        inputKey,
        expressions,
        intensity,
        generator: 'liveportrait',
        clientId,
        idempotencyKey,
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

  async get(jobId: string, clientId?: string) {
    const job = await this.jobStore.get(jobId)
    if (!job) throw new NotFoundException('Generation job not found')
    if (job.kind === 'benchmark') throw new NotFoundException('Generation job not found')
    if (clientId && job.clientId && job.clientId !== clientId) {
      throw new NotFoundException('Generation job not found')
    }
    return this.toResponse(job)
  }

  async cancel(jobId: string, clientId: string) {
    const job = await this.jobStore.get(jobId)
    if (!job || job.kind === 'benchmark' || (job.clientId && job.clientId !== clientId)) {
      throw new NotFoundException('Generation job not found')
    }
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return this.toResponse(job)
    job.status = 'cancelled'
    job.stage = 'failed'
    job.error = 'Cancelled by client'
    job.updatedAt = new Date().toISOString()
    await this.jobStore.put(job)
    return this.toResponse(job)
  }

  async readLocalResult(jobId: string, fileName: string) {
    return this.storage.readLocalResult(jobId, fileName)
  }

  private async toResponse(job: GenerationJob) {
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
      status: job.status,
      generator: job.generator,
      stage: job.stage,
      total: job.progress.total,
      completed: job.expressions.slice(0, job.progress.completed),
      completed_count: job.progress.completed,
      prepared_count: job.progress.prepared,
      progress: job.progress.percent / 100,
      created_at: job.createdAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      queue_wait_seconds: queueWaitSeconds,
      processing_seconds: processingSeconds,
      timings: job.timings ?? {},
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
