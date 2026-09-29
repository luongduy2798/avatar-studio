export type ExpressionId =
  | 'unbothered'
  | 'locked_in'
  | 'cracking_up'
  | 'full_panic'
  | 'big_winner'
  | 'spectacular_flop'

export type GeneratedExpression = {
  expression: ExpressionId
  url: string
}

type GenerateResponse = {
  job_id: string
  outputs: GeneratedExpression[]
}

type GenerationJobResponse = GenerateResponse & {
  status: 'queued' | 'processing' | 'retrying' | 'completed' | 'failed'
  generator: 'liveportrait'
  stage: 'queued' | 'preprocess' | 'expressions' | 'export' | 'uploading' | 'retrying' | 'completed' | 'failed'
  total: number
  completed: ExpressionId[]
  completed_count: number
  prepared_count: number
  progress: number
  error: string | null
}

export type GenerationProgress = {
  completed: number
  prepared: number
  total: number
  percent: number
  stage: GenerationJobResponse['stage']
}

export type BackendHealth = {
  status: 'ready'
  service: 'api-server'
  infrastructure: 'local' | 'aws'
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '')

export async function generateExpressions(
  image: Blob,
  expressions: ExpressionId[],
  intensity: number,
  onProgress?: (progress: GenerationProgress) => void,
) {
  const form = new FormData()
  const uploadName = image instanceof File ? image.name : (image.type === 'image/png' ? 'source.png' : 'source.jpg')
  form.append('image', image, uploadName)
  form.append('expressions', JSON.stringify(expressions))
  form.append('intensity', intensity.toString())

  const response = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs`, {
    method: 'POST',
    body: form,
  })

  if (!response.ok) {
    let message = 'Generate thất bại.'
    try {
      const payload = (await response.json()) as { detail?: string; message?: string | string[] }
      message = payload.detail
        ?? (Array.isArray(payload.message) ? payload.message.join(', ') : payload.message)
        ?? message
    } catch {
      // Keep the generic message for non-JSON errors.
    }
    throw new Error(message)
  }

  let payload = (await response.json()) as GenerationJobResponse
  onProgress?.({
    completed: payload.completed_count,
    prepared: payload.prepared_count,
    total: payload.total,
    percent: Math.round(payload.progress * 100),
    stage: payload.stage,
  })

  while (payload.status === 'queued' || payload.status === 'processing' || payload.status === 'retrying') {
    await new Promise((resolve) => window.setTimeout(resolve, 750))
    const statusResponse = await fetch(`${apiBaseUrl}/api/v1/avatar/expression-jobs/${payload.job_id}`)
    if (!statusResponse.ok) {
      throw new Error('Không đọc được tiến độ generate.')
    }
    payload = (await statusResponse.json()) as GenerationJobResponse
    onProgress?.({
      completed: payload.completed_count,
      prepared: payload.prepared_count,
      total: payload.total,
      percent: Math.round(payload.progress * 100),
      stage: payload.stage,
    })
  }

  if (payload.status === 'failed') {
    throw new Error(payload.error ?? 'Generate thất bại.')
  }

  return normalizeGenerateResponse(payload)
}

function normalizeGenerateResponse(payload: GenerateResponse) {
  return {
    ...payload,
    outputs: payload.outputs.map((item) => ({
      ...item,
      url: item.url.startsWith('http') ? item.url : `${apiBaseUrl}${item.url}`,
    })),
  }
}

export async function downloadExpression(output: GeneratedExpression) {
  // The API can use another origin, where an <a download> alone is ignored.
  const response = await fetch(output.url)
  if (!response.ok) throw new Error('Không tải được PNG. Hãy thử lại.')
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${output.expression}.png`
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function getBackendHealth() {
  const response = await fetch(`${apiBaseUrl}/api/v1/health`)
  if (!response.ok) return null
  return response.json() as Promise<BackendHealth>
}
