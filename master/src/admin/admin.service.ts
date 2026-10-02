import { Inject, Injectable, UnauthorizedException } from '@nestjs/common'
import { createHash, randomBytes } from 'node:crypto'
import type { AppConfig } from '../config'
import type { RunnerStore } from '../infrastructure/runner-store'
import { APP_CONFIG, RUNNER_STORE } from '../infrastructure/tokens'
import type { RunnerRecord } from '../infrastructure/runner-store'

function hashCode(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(RUNNER_STORE) private readonly runners: RunnerStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  authorize(token?: string) {
    if (!this.config.adminToken || token !== this.config.adminToken) {
      throw new UnauthorizedException('Invalid admin token')
    }
  }

  async createEnrollmentCode(ttlSeconds = 900) {
    const ttl = Number.isFinite(ttlSeconds) ? Math.max(60, Math.min(ttlSeconds, 3600)) : 900
    const code = randomBytes(6).toString('hex').toUpperCase()
    const now = new Date().toISOString()
    await this.runners.putEnrollment({
      codeHash: hashCode(code),
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
      usedAt: null,
      createdAt: now,
    })
    return { code, expires_in_seconds: ttl }
  }

  listRunners() {
    return this.runners.list().then((runners) => runners.map((runner) => this.publicRunner(runner)))
  }

  async getRunner(runnerId: string) {
    const runner = await this.runners.get(runnerId)
    return runner ? this.publicRunner(runner) : null
  }

  private publicRunner(runner: RunnerRecord) {
    const { tokenHash: _tokenHash, ...safe } = runner
    if (safe.status === 'online') {
      const last = safe.lastHeartbeatAt ? Date.parse(safe.lastHeartbeatAt) : 0
      if (last < Date.now() - this.config.runnerHeartbeatTimeoutSeconds * 1000) {
        return { ...safe, status: 'offline' as const }
      }
    }
    return safe
  }

  async revokeRunner(runnerId: string) {
    const runner = await this.runners.get(runnerId)
    if (!runner) return null
    runner.status = 'revoked'
    runner.updatedAt = new Date().toISOString()
    await this.runners.put(runner)
    return this.publicRunner(runner)
  }

  async metrics() {
    const runners = await this.runners.list()
    const visible = runners.map((runner) => this.publicRunner(runner))
    return {
      runners: {
        total: visible.length,
        online: visible.filter((runner) => runner.status === 'online').length,
        offline: visible.filter((runner) => runner.status === 'offline').length,
        revoked: visible.filter((runner) => runner.status === 'revoked').length,
      },
      generated_at: new Date().toISOString(),
    }
  }

  static hashEnrollmentCode(code: string) {
    return hashCode(code)
  }
}
