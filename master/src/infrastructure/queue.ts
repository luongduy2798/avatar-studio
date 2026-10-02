import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import type { AppConfig } from '../config'
import type { QueuePayload } from '../domain'

export interface GenerationQueue {
  publish(message: QueuePayload): Promise<void>
  receive(maxMessages: number, waitSeconds: number): Promise<QueueMessage[]>
  ack(message: QueueMessage): Promise<void>
  retry(message: QueueMessage, delaySeconds?: number): Promise<void>
  deadLetter(message: QueueMessage): Promise<void>
  heartbeat(message: QueueMessage, visibilitySeconds: number): Promise<void>
}

export type QueueMessage = {
  id: string
  body: QueuePayload
  receipt: string
  receiveCount: number
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

  async receive(maxMessages: number, waitSeconds: number) {
    await fs.mkdir(this.root, { recursive: true })
    const processing = path.join(path.dirname(this.root), 'processing')
    await fs.mkdir(processing, { recursive: true })
    const messages: QueueMessage[] = []
    const deadline = Date.now() + Math.max(0, waitSeconds * 1000)
    while (messages.length < Math.max(1, maxMessages)) {
      const files = (await fs.readdir(this.root)).filter((file) => file.endsWith('.json')).sort()
      if (!files.length) {
        if (Date.now() >= deadline || messages.length > 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }
      for (const file of files) {
        if (messages.length >= Math.max(1, maxMessages)) break
        const source = path.join(this.root, file)
        const target = path.join(processing, file)
        try {
          await fs.rename(source, target)
          const body = JSON.parse(await fs.readFile(target, 'utf8')) as QueuePayload & { receiveCount?: number }
          messages.push({
            id: file.replace(/\.json$/, ''),
            body,
            receipt: target,
            receiveCount: Number(body.receiveCount ?? 1),
          })
        } catch {
          // Another local process claimed this message.
        }
      }
      if (messages.length > 0) break
    }
    return messages
  }

  async ack(message: QueueMessage) {
    await fs.rm(message.receipt, { force: true })
  }

  async retry(message: QueueMessage) {
    const body = { ...message.body, receiveCount: message.receiveCount + 1 }
    await fs.writeFile(message.receipt, JSON.stringify(body, null, 2), 'utf8')
    await fs.rename(message.receipt, path.join(this.root, path.basename(message.receipt)))
  }

  async deadLetter(message: QueueMessage) {
    const dlq = path.join(path.dirname(this.root), 'dlq')
    await fs.mkdir(dlq, { recursive: true })
    await fs.rename(message.receipt, path.join(dlq, path.basename(message.receipt)))
  }

  async heartbeat(message: QueueMessage) {
    await fs.utimes(message.receipt, new Date(), new Date())
  }
}

export class SqsGenerationQueue implements GenerationQueue {
  private readonly client: SQSClient
  private readonly queueUrl: string
  private readonly dlqUrl?: string

  constructor(config: AppConfig) {
    if (!config.awsQueueUrl) throw new Error('AVATAR_SQS_QUEUE_URL is required in aws mode')
    this.queueUrl = config.awsQueueUrl
    this.dlqUrl = config.awsDlqUrl
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

  async receive(maxMessages: number, waitSeconds: number) {
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: Math.min(Math.max(1, maxMessages), 10),
      WaitTimeSeconds: Math.min(Math.max(0, Math.floor(waitSeconds)), 20),
      VisibilityTimeout: 60,
      AttributeNames: ['ApproximateReceiveCount'],
    }))
    return (response.Messages ?? []).flatMap((message) => {
      if (!message.ReceiptHandle || !message.MessageId || !message.Body) return []
      try {
        return [{
          id: message.MessageId,
          body: JSON.parse(message.Body) as QueuePayload,
          receipt: message.ReceiptHandle,
          receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        }]
      } catch {
        return []
      }
    })
  }

  async ack(message: QueueMessage) {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.receipt }))
  }

  async retry(message: QueueMessage, delaySeconds = 0) {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receipt,
      VisibilityTimeout: Math.max(0, Math.min(900, delaySeconds)),
    }))
  }

  async deadLetter(message: QueueMessage) {
    if (!this.dlqUrl) {
      await this.ack(message)
      return
    }
    await this.client.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: JSON.stringify(message.body) }))
    await this.ack(message)
  }

  async heartbeat(message: QueueMessage, visibilitySeconds: number) {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.queueUrl,
      ReceiptHandle: message.receipt,
      VisibilityTimeout: Math.max(30, Math.min(43200, visibilitySeconds)),
    }))
  }
}
