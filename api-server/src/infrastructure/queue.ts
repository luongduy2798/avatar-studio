import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import type { AppConfig } from '../config'
import type { QueuePayload } from '../domain'

export interface GenerationQueue {
  publish(message: QueuePayload): Promise<void>
}

export class LocalGenerationQueue implements GenerationQueue {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = path.join(config.runtimeRoot, 'queue', 'pending')
  }

  async publish(message: QueuePayload) {
    await fs.mkdir(this.root, { recursive: true })
    const id = message.kind === 'benchmark' ? 'benchmark-' + message.runId : message.jobId
    const target = path.join(this.root, id + '.json')
    const temporary = target + '.' + process.pid + '.tmp'
    await fs.writeFile(
      temporary,
      JSON.stringify({ ...message, receiveCount: 1 }, null, 2),
      'utf8',
    )
    await fs.rename(temporary, target)
  }
}

export class SqsGenerationQueue implements GenerationQueue {
  private readonly client: SQSClient
  private readonly queueUrl: string

  constructor(config: AppConfig) {
    if (!config.awsQueueUrl) throw new Error('AVATAR_SQS_QUEUE_URL is required in aws mode')
    this.queueUrl = config.awsQueueUrl
    this.client = new SQSClient({ region: config.awsRegion })
  }

  async publish(message: QueuePayload) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    )
  }
}
