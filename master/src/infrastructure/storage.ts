import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { AppConfig } from '../config'

export interface Storage {
  putInput(jobId: string, extension: string, payload: Buffer, contentType: string): Promise<string>
  createUpload(uploadId: string, extension: string, contentType: string): Promise<{
    key: string
    uploadUrl: string
  }>
  inputUrl(key: string): Promise<string>
  outputUploadUrl(key: string): Promise<string>
  objectExists(key: string): Promise<boolean>
  objectInfo(key: string): Promise<{ size: number; contentType?: string } | null>
  resultUrl(key: string): Promise<string>
  readLocalResult(jobId: string, fileName: string): Promise<Buffer | null>
}

export class LocalStorage implements Storage {
  private readonly root: string

  constructor(config: AppConfig) {
    this.root = path.join(config.runtimeRoot, 'storage')
  }

  private resolveKey(key: string) {
    const candidate = path.resolve(this.root, key)
    const root = path.resolve(this.root) + path.sep
    if (!candidate.startsWith(root)) throw new Error('Storage key escapes the configured root')
    return candidate
  }

  async putInput(jobId: string, extension: string, payload: Buffer) {
    const key = 'jobs/' + jobId + '/input/source' + extension
    const target = this.resolveKey(key)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, payload)
    return key
  }

  async createUpload(uploadId: string, extension: string) {
    const key = 'inputs/' + uploadId + '/source'
    return { key, uploadUrl: 'local://' + key }
  }

  async inputUrl(key: string) {
    return 'local://' + key
  }

  async outputUploadUrl(key: string) {
    return 'local://' + key
  }

  async objectExists(key: string) {
    try {
      await fs.access(this.resolveKey(key))
      return true
    } catch {
      return false
    }
  }

  async objectInfo(key: string) {
    try {
      const stat = await fs.stat(this.resolveKey(key))
      return { size: stat.size }
    } catch {
      return null
    }
  }

  async resultUrl(key: string) {
    const parts = key.split('/')
    const jobId = parts[1]
    const fileName = parts.at(-1)
    if (!jobId || !fileName) throw new Error('Invalid output key')
    return '/api/v1/files/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(fileName)
  }

  async readLocalResult(jobId: string, fileName: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(jobId) || !/^[a-zA-Z0-9_.-]+$/.test(fileName)) return null
    try {
      return await fs.readFile(this.resolveKey('jobs/' + jobId + '/outputs/' + fileName))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
}

export class S3Storage implements Storage {
  private readonly client: S3Client
  private readonly bucket: string

  constructor(config: AppConfig) {
    if (!config.awsBucket) throw new Error('AVATAR_S3_BUCKET is required in aws mode')
    this.bucket = config.awsBucket
    this.client = new S3Client({ region: config.awsRegion })
  }

  async putInput(jobId: string, extension: string, payload: Buffer, contentType: string) {
    const key = 'jobs/' + jobId + '/input/source' + extension
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: payload, ContentType: contentType }),
    )
    return key
  }

  async createUpload(uploadId: string, extension: string, contentType: string) {
    const key = 'inputs/' + uploadId + '/source'
    return {
      key,
      uploadUrl: await getSignedUrl(
        this.client,
        new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
        { expiresIn: 900 },
      ),
    }
  }

  async inputUrl(key: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 900 },
    )
  }

  async outputUploadUrl(key: string) {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: 'image/png' }),
      { expiresIn: 900 },
    )
  }

  async objectExists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404) return false
      throw error
    }
  }

  async objectInfo(key: string) {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return {
        size: Number(response.ContentLength ?? 0),
        contentType: response.ContentType,
      }
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 404) return null
      throw error
    }
  }

  async resultUrl(key: string) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: 900 },
    )
  }

  async readLocalResult() {
    return null
  }
}
