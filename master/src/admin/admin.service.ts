import { Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AppConfig } from '../config'
import type { RunnerStore } from '../infrastructure/runner-store'
import { APP_CONFIG, RUNNER_STORE } from '../infrastructure/tokens'
import type { RunnerRecord } from '../infrastructure/runner-store'
import { MasterService } from '../master/master.service'

function hashCode(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(RUNNER_STORE) private readonly runners: RunnerStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly master: MasterService,
  ) {}

  authorize(token?: string) {
    if (!this.config.adminToken || !token || !timingSafeEqual(
      createHash('sha256').update(token).digest(),
      createHash('sha256').update(this.config.adminToken).digest(),
    )) {
      throw new UnauthorizedException('Invalid admin token')
    }
  }

  async createEnrollmentCode(ttlSeconds = 900) {
    const ttl = Number.isFinite(ttlSeconds) ? Math.max(60, Math.min(Math.floor(ttlSeconds), 3600)) : 900
    const code = randomBytes(6).toString('hex').toUpperCase()
    const now = new Date().toISOString()
    const expiresAt = Math.floor(Date.now() / 1000) + ttl
    await this.runners.putEnrollment({
      codeHash: hashCode(code),
      expiresAt,
      usedAt: null,
      createdAt: now,
    })
    return { code, expires_in_seconds: ttl, expires_at: new Date(expiresAt * 1000).toISOString() }
  }

  listRunners() {
    return this.runners.list().then((runners) => runners.map((runner) => this.publicRunner(runner)))
  }

  async getRunner(runnerId: string) {
    const runner = await this.runners.get(runnerId)
    if (!runner) throw new NotFoundException('Runner not found')
    return this.publicRunner(runner)
  }

  private publicRunner(runner: RunnerRecord) {
    const { tokenHash: _tokenHash, ...safe } = runner
    if (safe.status === 'online') {
      const last = safe.lastHeartbeatAt ? Date.parse(safe.lastHeartbeatAt) : 0
      if (!Number.isFinite(last) || last < Date.now() - this.config.runnerHeartbeatTimeoutSeconds * 1000) {
        return { ...safe, status: 'offline' as const }
      }
    }
    return safe
  }

  async revokeRunner(runnerId: string) {
    const runner = await this.runners.get(runnerId)
    if (!runner) throw new NotFoundException('Runner not found')
    runner.status = 'revoked'
    runner.updatedAt = new Date().toISOString()
    await this.runners.put(runner)
    this.master.disconnectRevokedRunner(runnerId)
    return this.publicRunner(runner)
  }

  async metrics() {
    const runners = await this.runners.list()
    const visible = runners.map((runner) => this.publicRunner(runner))
    const online = visible.filter((runner) => runner.status === 'online')
    return {
      master: {
        enabled: this.config.masterEnabled,
        infrastructure_mode: this.config.infrastructureMode,
        runner_ws_path: this.config.runnerWsPath,
        runner_version: this.config.runnerVersion,
        heartbeat_timeout_seconds: this.config.runnerHeartbeatTimeoutSeconds,
      },
      runners: {
        total: visible.length,
        online: online.length,
        enrolled: visible.filter((runner) => runner.status === 'enrolled').length,
        offline: visible.filter((runner) => runner.status === 'offline').length,
        revoked: visible.filter((runner) => runner.status === 'revoked').length,
        active_jobs: online.reduce((total, runner) => total + runner.activeJobs, 0),
      },
      generated_at: new Date().toISOString(),
    }
  }

  static hashEnrollmentCode(code: string) {
    return hashCode(code)
  }
}
