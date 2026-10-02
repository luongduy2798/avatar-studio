import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Server as HttpServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import type { AppConfig } from '../config'
import type { GenerationJob } from '../domain'
import type { JobStore } from '../infrastructure/job-store'
import type { GenerationQueue, QueueMessage } from '../infrastructure/queue'
import type { Storage } from '../infrastructure/storage'
import type { RunnerCapabilities, RunnerRecord, RunnerStore } from '../infrastructure/runner-store'
import { APP_CONFIG, JOB_STORE, QUEUE, RUNNER_STORE, STORAGE } from '../infrastructure/tokens'

type RunnerSocket = {
  socket: WebSocket
  runner: RunnerRecord
}

type Assignment = {
  jobId: string
  message: QueueMessage
  runnerId: string
  leaseId: string
  expiresAt: number
  outputKeys: string[]
  attempt: number
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function nowIso() {
  return new Date().toISOString()
}

@Injectable()
export class MasterService implements OnModuleDestroy {
  private server: WebSocketServer | null = null
  private readonly sockets = new Map<string, RunnerSocket>()
  private readonly assignments = new Map<string, Assignment>()
  private stopped = false
  private receiveRunning = false
  private monitorTimer: NodeJS.Timeout | null = null

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JOB_STORE) private readonly jobs: JobStore,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(QUEUE) private readonly queue: GenerationQueue,
    @Inject(RUNNER_STORE) private readonly runners: RunnerStore,
  ) {}

  start(httpServer: HttpServer) {
    if (this.server) return
    this.server = new WebSocketServer({ server: httpServer, path: this.config.runnerWsPath })
    this.server.on('connection', (socket) => this.handleConnection(socket))
    this.monitorTimer = setInterval(() => void this.monitor(), 5000)
    void this.receiveLoop()
    console.log(`Avatar Master WSS endpoint ready at ${this.config.runnerWsPath}`)
  }

  disconnectRevokedRunner(runnerId: string) {
    const connection = this.sockets.get(runnerId)
    if (!connection) return
    connection.runner.status = 'revoked'
    this.sockets.delete(runnerId)
    connection.socket.close(1008, 'Runner revoked')
  }

  async onModuleDestroy() {
    this.stopped = true
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
    this.server = null
  }

  private handleConnection(socket: WebSocket) {
    let runnerId: string | null = null
    const close = () => {
      if (!runnerId) return
      const current = this.sockets.get(runnerId)
      if (current?.socket === socket) {
        this.sockets.delete(runnerId)
        void this.markOffline(runnerId)
      }
    }
    socket.on('message', (raw) => {
      void this.handleMessage(socket, raw.toString(), (value) => { runnerId = value })
    })
    socket.on('close', close)
    socket.on('error', close)
  }

  private async handleMessage(socket: WebSocket, raw: string, setRunnerId: (value: string) => void) {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(raw) as Record<string, unknown>
    } catch {
      socket.close(1003, 'Invalid JSON')
      return
    }
    const type = String(message.type ?? '')
    if (type === 'runner.enroll') {
      await this.enroll(socket, message, setRunnerId)
      return
    }
    const runner = await this.authenticate(socket, message, setRunnerId)
    if (!runner) return
    if (type === 'runner.heartbeat' || type === 'runner.capabilities') {
      runner.lastHeartbeatAt = nowIso()
      runner.status = 'online'
      runner.capabilities = this.capabilities(message.capabilities) ?? runner.capabilities
      runner.maxInflightJobs = Math.max(1, Number(runner.capabilities.maxInflightJobs ?? runner.maxInflightJobs ?? 1))
      runner.currentVersion = String(message.runtimeVersion ?? runner.currentVersion ?? '') || undefined
      runner.updatedAt = nowIso()
      await this.runners.put(runner)
      socket.send(JSON.stringify({ type: 'runner.heartbeat_ack', server_time: nowIso() }))
      return
    }
    if (type.startsWith('job.')) {
      await this.handleJobEvent(runner, message)
    }
  }

  private async enroll(socket: WebSocket, message: Record<string, unknown>, setRunnerId: (value: string) => void) {
    const code = String(message.code ?? '').trim()
    const name = String(message.name ?? 'runner').trim().slice(0, 120) || 'runner'
    const codeHash = hashToken(code)
    if (!code || !(await this.runners.consumeEnrollment(codeHash))) {
      socket.close(1008, 'Enrollment code is invalid or expired')
      return
    }
    const runnerId = 'runner_' + randomUUID().replaceAll('-', '')
    const token = randomBytes(32).toString('base64url')
    const now = nowIso()
    const capabilities = this.capabilities(message.capabilities) ?? {}
    const runner: RunnerRecord = {
      runnerId,
      name,
      tokenHash: hashToken(token),
      tokenIssuedAt: now,
      status: 'online',
      lastHeartbeatAt: now,
      capabilities,
      activeJobs: 0,
      maxInflightJobs: Math.max(1, Number(capabilities.maxInflightJobs ?? 1)),
      createdAt: now,
      updatedAt: now,
      currentVersion: String(message.runtimeVersion ?? '') || undefined,
    }
    await this.runners.put(runner)
    this.sockets.set(runnerId, { socket, runner })
    setRunnerId(runnerId)
    socket.send(JSON.stringify({
      type: 'runner.enrolled',
      runner_id: runnerId,
      token,
      server_time: now,
      minimum_version: this.config.runnerVersion,
    }))
  }

  private async authenticate(socket: WebSocket, message: Record<string, unknown>, setRunnerId: (value: string) => void) {
    const runnerId = String(message.runner_id ?? '')
    const token = String(message.token ?? '')
    const runner = await this.runners.get(runnerId)
    if (!runner || runner.status === 'revoked' || hashToken(token) !== runner.tokenHash) {
      socket.close(1008, 'Runner authentication failed')
      return null
    }
    runner.status = 'online'
    runner.lastHeartbeatAt = nowIso()
    runner.updatedAt = nowIso()
    await this.runners.put(runner)
    this.sockets.set(runnerId, { socket, runner })
    setRunnerId(runnerId)
    socket.send(JSON.stringify({
      type: 'runner.authenticated',
      runner_id: runnerId,
      minimum_version: this.config.runnerVersion,
      server_time: nowIso(),
    }))
    return runner
  }

  private capabilities(value: unknown): RunnerCapabilities | null {
    return value && typeof value === 'object' ? value as RunnerCapabilities : null
  }

  private async receiveLoop() {
    if (this.receiveRunning) return
    this.receiveRunning = true
    try {
      while (!this.stopped) {
        const messages = await this.queue.receive(5, 20)
        if (!messages.length) continue
        for (const message of messages) await this.dispatch(message)
      }
    } catch (error) {
      if (!this.stopped) {
        console.error('Avatar Master queue loop failed:', error)
        setTimeout(() => void this.receiveLoop(), 1000)
      }
    } finally {
      this.receiveRunning = false
    }
  }

  private async dispatch(message: QueueMessage) {
    if (message.body.kind === 'benchmark') {
      await this.queue.ack(message)
      return
    }
    const job = await this.jobs.get(message.body.jobId)
    if (!job || job.kind === 'benchmark' || job.status === 'completed' || job.status === 'cancelled') {
      await this.queue.ack(message)
      return
    }
    if (this.assignments.has(job.jobId)) {
      await this.queue.retry(message, 5)
      return
    }
    const runner = this.selectRunner(job.generator)
    if (!runner) {
      await this.queue.retry(message, 5)
      return
    }
    const connection = this.sockets.get(runner.runnerId)
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      await this.queue.retry(message, 5)
      return
    }
    const attempt = Math.max(1, Number(job.attempt ?? 0) + 1)
    const leaseId = randomUUID()
    const outputKeys = job.expressions.map((expression) => `outputs/${job.jobId}/${expression}.png`)
    let registered = false
    try {
      const inputUrl = await this.storage.inputUrl(job.inputKey)
      const outputUrls = await Promise.all(outputKeys.map((key) => this.storage.outputUploadUrl(key)))
      const now = nowIso()
      const nextJob: GenerationJob = {
        ...job,
        status: 'assigned',
        stage: 'assigned',
        attempt,
        runnerId: runner.runnerId,
        leaseId,
        leaseExpiresAt: new Date(Date.now() + this.config.runnerLeaseSeconds * 1000).toISOString(),
        assignedAt: now,
        updatedAt: now,
        version: Number(job.version ?? 0) + 1,
        outputs: job.expressions.map((expression, index) => ({ expression, key: outputKeys[index] })),
      }
      await this.jobs.put(nextJob)
      this.assignments.set(job.jobId, {
        jobId: job.jobId,
        message,
        runnerId: runner.runnerId,
        leaseId,
        expiresAt: Date.now() + this.config.runnerLeaseSeconds * 1000,
        outputKeys,
        attempt,
      })
      registered = true
      runner.activeJobs += 1
      runner.updatedAt = now
      await this.runners.put(runner)
      connection.socket.send(JSON.stringify({
        type: 'job.assign',
        job_id: job.jobId,
        attempt,
        lease_id: leaseId,
        input_url: inputUrl,
        output_urls: outputUrls,
        output_keys: outputKeys,
        expressions: job.expressions,
        intensity: job.intensity,
        generator: job.generator,
        runtime_version: this.config.runnerVersion,
      }))
    } catch (error) {
      console.error(`Could not assign job ${job.jobId}:`, error)
      if (registered) {
        this.assignments.delete(job.jobId)
        runner.activeJobs = Math.max(0, runner.activeJobs - 1)
        runner.updatedAt = nowIso()
        await this.runners.put(runner)
        const queuedJob: GenerationJob = {
          ...job,
          status: 'queued',
          stage: 'queued',
          runnerId: null,
          leaseId: null,
          leaseExpiresAt: null,
          updatedAt: nowIso(),
        }
        await this.jobs.put(queuedJob)
      }
      await this.queue.retry(message, 5)
    }
  }

  private selectRunner(generator: string) {
    const candidates = [...this.sockets.values()]
      .map((value) => value.runner)
      .filter((runner) => runner.status === 'online')
      .filter((runner) => !runner.currentVersion || runner.currentVersion === this.config.runnerVersion)
      .filter((runner) => runner.activeJobs < Math.max(1, runner.maxInflightJobs))
      .filter((runner) => !runner.capabilities.generators || (runner.capabilities.generators as unknown[]).includes(generator))
      .sort((a, b) => a.activeJobs - b.activeJobs || a.updatedAt.localeCompare(b.updatedAt))
    return candidates[0] ?? null
  }

  private async handleJobEvent(runner: RunnerRecord, message: Record<string, unknown>) {
    const jobId = String(message.job_id ?? '')
    const assignment = this.assignments.get(jobId)
    if (!assignment || assignment.runnerId !== runner.runnerId || assignment.leaseId !== String(message.lease_id ?? '')) return
    const job = await this.jobs.get(jobId)
    if (!job) return
    const type = String(message.type)
    if (job.status === 'cancelled') {
      if (type === 'job.completed' || type === 'job.failed') {
        await this.queue.ack(assignment.message)
        await this.finishAssignment(assignment)
      }
      return
    }
    if (type === 'job.started') {
      job.status = 'processing'
      job.stage = 'preprocess'
      job.startedAt = job.startedAt ?? nowIso()
      job.updatedAt = nowIso()
      await this.jobs.put(job)
      return
    }
    if (type === 'job.progress') {
      job.status = 'processing'
      job.stage = String(message.stage ?? job.stage) as GenerationJob['stage']
      if (message.progress && typeof message.progress === 'object') job.progress = message.progress as GenerationJob['progress']
      if (message.timings && typeof message.timings === 'object') job.timings = message.timings as GenerationJob['timings']
      job.updatedAt = nowIso()
      await this.jobs.put(job)
      return
    }
    if (type === 'job.completed') {
      const complete = await Promise.all(assignment.outputKeys.map((key) => this.storage.objectExists(key)))
      if (complete.some((value) => !value)) {
        await this.failAssignment(assignment, job, 'Runner completed without all output objects')
        return
      }
      job.status = 'completed'
      job.stage = 'completed'
      job.progress = { prepared: job.expressions.length, completed: job.expressions.length, total: job.expressions.length, percent: 100 }
      job.timings = message.timings && typeof message.timings === 'object' ? message.timings as GenerationJob['timings'] : job.timings
      job.completedAt = nowIso()
      job.updatedAt = nowIso()
      job.leaseId = null
      job.leaseExpiresAt = null
      await this.jobs.put(job)
      await this.queue.ack(assignment.message)
      await this.finishAssignment(assignment)
      return
    }
    if (type === 'job.failed') await this.failAssignment(assignment, job, String(message.error ?? 'Runner failed'))
  }

  private async failAssignment(assignment: Assignment, job: GenerationJob, error: string) {
    job.error = error
    job.updatedAt = nowIso()
    job.leaseId = null
    job.leaseExpiresAt = null
    if (assignment.attempt >= this.config.maxAttempts) {
      job.status = 'failed'
      job.stage = 'failed'
      job.completedAt = nowIso()
      await this.jobs.put(job)
      await this.queue.deadLetter(assignment.message)
    } else {
      job.status = 'retrying'
      job.stage = 'retrying'
      await this.jobs.put(job)
      await this.queue.retry(assignment.message, 1)
    }
    await this.finishAssignment(assignment)
  }

  private async finishAssignment(assignment: Assignment) {
    this.assignments.delete(assignment.jobId)
    const runner = await this.runners.get(assignment.runnerId)
    if (runner) {
      runner.activeJobs = Math.max(0, runner.activeJobs - 1)
      runner.updatedAt = nowIso()
      await this.runners.put(runner)
    }
  }

  private async markOffline(runnerId: string) {
    const runner = await this.runners.get(runnerId)
    if (!runner || runner.status === 'revoked') return
    runner.status = 'offline'
    runner.updatedAt = nowIso()
    await this.runners.put(runner)
  }

  private async monitor() {
    const cutoff = Date.now() - this.config.runnerHeartbeatTimeoutSeconds * 1000
    for (const [runnerId, connection] of this.sockets) {
      const heartbeat = connection.runner.lastHeartbeatAt ? Date.parse(connection.runner.lastHeartbeatAt) : 0
      if (heartbeat < cutoff) {
        connection.runner.status = 'offline'
        connection.socket.close(1011, 'Heartbeat timeout')
        this.sockets.delete(runnerId)
        await this.runners.put(connection.runner)
      }
    }
    for (const assignment of [...this.assignments.values()]) {
      const connection = this.sockets.get(assignment.runnerId)
      if (!connection || connection.runner.status !== 'online' || connection.socket.readyState !== WebSocket.OPEN) {
        const job = await this.jobs.get(assignment.jobId)
        if (job) await this.failAssignment(assignment, job, 'Runner disconnected or revoked')
        continue
      }
      if (assignment.expiresAt > Date.now()) {
        await this.queue.heartbeat(assignment.message, this.config.runnerLeaseSeconds)
        assignment.expiresAt = Date.now() + this.config.runnerLeaseSeconds * 1000
        continue
      }
      const job = await this.jobs.get(assignment.jobId)
      if (job) await this.failAssignment(assignment, job, 'Runner lease expired')
    }
  }
}
