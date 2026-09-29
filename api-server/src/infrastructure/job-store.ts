import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import type { AppConfig } from '../config'
import type { GenerationJob } from '../domain'

export interface JobStore {
  get(jobId: string): Promise<GenerationJob | null>
  put(job: GenerationJob): Promise<void>
}

export class LocalJobStore implements JobStore {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = path.join(config.runtimeRoot, 'jobs')
  }

  private file(jobId: string) {
    return path.join(this.root, jobId + '.json')
  }

  async get(jobId: string) {
    try {
      return JSON.parse(await fs.readFile(this.file(jobId), 'utf8')) as GenerationJob
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async put(job: GenerationJob) {
    await fs.mkdir(this.root, { recursive: true })
    const target = this.file(job.jobId)
    const temporary = target + '.' + process.pid + '.tmp'
    await fs.writeFile(temporary, JSON.stringify(job, null, 2), 'utf8')
    await fs.rename(temporary, target)
  }
}

export class DynamoDbJobStore implements JobStore {
  private readonly client: DynamoDBDocumentClient
  private readonly tableName: string

  constructor(config: AppConfig) {
    if (!config.awsJobsTable) throw new Error('AVATAR_DYNAMODB_JOBS_TABLE is required in aws mode')
    this.tableName = config.awsJobsTable
    this.client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.awsRegion }))
  }

  async get(jobId: string) {
    const response = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { jobId }, ConsistentRead: true }),
    )
    if (!response.Item) return null
    return JSON.parse(String(response.Item.payload)) as GenerationJob
  }

  async put(job: GenerationJob) {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          jobId: job.jobId,
          payload: JSON.stringify(job),
          updatedAt: job.updatedAt,
        },
      }),
    )
  }
}
