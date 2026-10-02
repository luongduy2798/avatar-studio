import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { AppConfig } from '../config'

export type IdempotencyRecord = {
  clientId: string
  key: string
  jobId: string
  createdAt: string
  expiresAt: number
}

export interface IdempotencyStore {
  get(clientId: string, key: string): Promise<IdempotencyRecord | null>
  put(record: IdempotencyRecord): Promise<void>
}

export class LocalIdempotencyStore implements IdempotencyStore {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = path.join(config.runtimeRoot, 'idempotency')
  }

  private file(clientId: string, key: string) {
    return path.join(this.root, encodeURIComponent(clientId + ':' + key) + '.json')
  }

  async get(clientId: string, key: string) {
    try {
      const record = JSON.parse(await fs.readFile(this.file(clientId, key), 'utf8')) as IdempotencyRecord
      if (record.expiresAt <= Math.floor(Date.now() / 1000)) return null
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(record: IdempotencyRecord) {
    await fs.mkdir(this.root, { recursive: true })
    await fs.writeFile(this.file(record.clientId, record.key), JSON.stringify(record), 'utf8')
  }
}

export class DynamoDbIdempotencyStore implements IdempotencyStore {
  private readonly client: DynamoDBDocumentClient
  private readonly tableName: string

  constructor(config: AppConfig) {
    if (!config.awsIdempotencyTable) {
      throw new Error('AVATAR_DYNAMODB_IDEMPOTENCY_TABLE is required in aws mode')
    }
    this.tableName = config.awsIdempotencyTable
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
  }

  private id(clientId: string, key: string) {
    return clientId + ':' + key
  }

  async get(clientId: string, key: string) {
    const response = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { id: this.id(clientId, key) },
      ConsistentRead: true,
    }))
    return (response.Item as IdempotencyRecord | undefined) ?? null
  }

  async put(record: IdempotencyRecord) {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: { ...record, id: this.id(record.clientId, record.key) },
    }))
  }
}
