import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { AppConfig } from '../config'

export type RunnerCapabilities = {
  os?: string
  arch?: string
  gpu?: string | null
  backend?: string
  vramMb?: number | null
  modelVersion?: string
  runtimeVersion?: string
  maxInflightJobs?: number
  maxDecodeBatch?: number
  [key: string]: unknown
}

export type RunnerRecord = {
  runnerId: string
  name: string
  tokenHash: string
  tokenIssuedAt: string
  status: 'enrolled' | 'online' | 'offline' | 'revoked'
  lastHeartbeatAt: string | null
  capabilities: RunnerCapabilities
  activeJobs: number
  maxInflightJobs: number
  createdAt: string
  updatedAt: string
  currentVersion?: string
}

export type EnrollmentRecord = {
  codeHash: string
  expiresAt: number
  usedAt: string | null
  createdAt: string
}

export interface RunnerStore {
  list(): Promise<RunnerRecord[]>
  get(runnerId: string): Promise<RunnerRecord | null>
  put(runner: RunnerRecord): Promise<void>
  remove(runnerId: string): Promise<void>
  putEnrollment(record: EnrollmentRecord): Promise<void>
  consumeEnrollment(codeHash: string): Promise<boolean>
}

export class LocalRunnerStore implements RunnerStore {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = path.join(config.runtimeRoot, 'runners')
  }

  private runnerFile(runnerId: string) {
    return path.join(this.root, 'records', encodeURIComponent(runnerId) + '.json')
  }

  private enrollmentFile(codeHash: string) {
    return path.join(this.root, 'enrollments', encodeURIComponent(codeHash) + '.json')
  }

  async list() {
    try {
      const files = await fs.readdir(path.join(this.root, 'records'))
      const values: RunnerRecord[] = []
      for (const file of files.filter((value) => value.endsWith('.json'))) {
        try {
          values.push(JSON.parse(await fs.readFile(path.join(this.root, 'records', file), 'utf8')))
        } catch {
          // Ignore a partially written local record.
        }
      }
      return values
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async get(runnerId: string) {
    try {
      return JSON.parse(await fs.readFile(this.runnerFile(runnerId), 'utf8')) as RunnerRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(runner: RunnerRecord) {
    await fs.mkdir(path.dirname(this.runnerFile(runner.runnerId)), { recursive: true })
    await fs.writeFile(this.runnerFile(runner.runnerId), JSON.stringify(runner, null, 2), 'utf8')
  }

  async remove(runnerId: string) {
    await fs.rm(this.runnerFile(runnerId), { force: true })
  }

  async putEnrollment(record: EnrollmentRecord) {
    await fs.mkdir(path.dirname(this.enrollmentFile(record.codeHash)), { recursive: true })
    await fs.writeFile(this.enrollmentFile(record.codeHash), JSON.stringify(record), 'utf8')
  }

  async consumeEnrollment(codeHash: string) {
    try {
      const file = this.enrollmentFile(codeHash)
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as EnrollmentRecord
      if (record.usedAt || record.expiresAt <= Math.floor(Date.now() / 1000)) return false
      record.usedAt = new Date().toISOString()
      await fs.writeFile(file, JSON.stringify(record), 'utf8')
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}

export class DynamoDbRunnerStore implements RunnerStore {
  private readonly client: DynamoDBDocumentClient
  private readonly runnersTable: string
  private readonly enrollmentsTable: string

  constructor(config: AppConfig) {
    if (!config.awsRunnersTable || !config.awsEnrollmentsTable) {
      throw new Error('AVATAR_DYNAMODB_RUNNERS_TABLE and AVATAR_DYNAMODB_ENROLLMENTS_TABLE are required')
    }
    this.runnersTable = config.awsRunnersTable
    this.enrollmentsTable = config.awsEnrollmentsTable
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
  }

  async list() {
    const response = await this.client.send(new ScanCommand({ TableName: this.runnersTable }))
    return (response.Items ?? []) as RunnerRecord[]
  }

  async get(runnerId: string) {
    const response = await this.client.send(new GetCommand({
      TableName: this.runnersTable,
      Key: { runnerId },
      ConsistentRead: true,
    }))
    return (response.Item as RunnerRecord | undefined) ?? null
  }

  async put(runner: RunnerRecord) {
    await this.client.send(new PutCommand({ TableName: this.runnersTable, Item: runner }))
  }

  async remove(runnerId: string) {
    await this.client.send(new DeleteCommand({ TableName: this.runnersTable, Key: { runnerId } }))
  }

  async putEnrollment(record: EnrollmentRecord) {
    await this.client.send(new PutCommand({
      TableName: this.enrollmentsTable,
      Item: { ...record, codeHash: record.codeHash },
    }))
  }

  async consumeEnrollment(codeHash: string) {
    const response = await this.client.send(new GetCommand({
      TableName: this.enrollmentsTable,
      Key: { codeHash },
      ConsistentRead: true,
    }))
    const record = response.Item as EnrollmentRecord | undefined
    if (!record || record.usedAt || record.expiresAt <= Math.floor(Date.now() / 1000)) return false
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.enrollmentsTable,
        Key: { codeHash },
        UpdateExpression: 'SET usedAt = :usedAt',
        ConditionExpression: 'attribute_not_exists(usedAt) OR usedAt = :empty',
        ExpressionAttributeValues: { ':usedAt': new Date().toISOString(), ':empty': null },
      }))
      return true
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }
}
