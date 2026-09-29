import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  downloadExpression,
  generateExpressions,
  getBackendHealth,
  type ExpressionId,
  type GeneratedExpression,
  type GenerationProgress,
} from './lib/api'

const expressionOptions: Array<{ id: ExpressionId; label: string; glyph: string; detail: string }> = [
  { id: 'unbothered', label: 'Unbothered', glyph: '😐', detail: 'Bình thản, môi khép' },
  { id: 'locked_in', label: 'Locked in', glyph: '😤', detail: 'Cau mày, mắt căng, chu môi' },
  { id: 'cracking_up', label: 'Cracking up', glyph: '😂', detail: 'Cười lớn, mắt híp' },
  { id: 'full_panic', label: 'Full panic', glyph: '😱', detail: 'Mắt trợn, miệng há hoảng hốt' },
  { id: 'big_winner', label: 'Big winner', glyph: '😏', detail: 'Cười nhếch mép đắc ý' },
  { id: 'spectacular_flop', label: 'Spectacular flop', glyph: '☹', detail: 'Mếu, khóe miệng trễ xuống' },
]

type Status = 'idle' | 'ready' | 'generating' | 'error'

function App() {
  const [sourceUrl, setSourceUrl] = useState<string | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [message, setMessage] = useState('Upload một selfie rõ mặt để bắt đầu.')
  const [selected, setSelected] = useState<ExpressionId[]>(expressionOptions.map((item) => item.id))
  const [intensity, setIntensity] = useState(1)
  const [outputs, setOutputs] = useState<GeneratedExpression[]>([])
  const [generationProgress, setGenerationProgress] = useState<GenerationProgress | null>(null)
  const [backendHealth, setBackendHealth] = useState<Awaited<ReturnType<typeof getBackendHealth>>>(null)
  const [backendChecked, setBackendChecked] = useState(false)
  const [showTransparency, setShowTransparency] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const busy = status === 'generating'

  useEffect(() => () => { if (sourceUrl) URL.revokeObjectURL(sourceUrl) }, [sourceUrl])

  useEffect(() => {
    void getBackendHealth()
      .then(setBackendHealth)
      .catch(() => setBackendHealth(null))
      .finally(() => setBackendChecked(true))
  }, [])

  const generatorLabel = 'LivePortrait'
  const apiReady = backendHealth?.status === 'ready'
  const canGenerate = status === 'ready' && sourceFile !== null && selected.length > 0 && apiReady
  const statusLabel = useMemo(() => {
    if (!backendChecked) return 'Checking backend'
    if (backendHealth === null) return 'Backend unavailable'
    return `API ready · ${backendHealth.infrastructure}`
  }, [backendChecked, backendHealth])

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || busy) return

    setGenerationProgress(null)
    setOutputs([])
    setSourceFile(file)

    const nextSourceUrl = URL.createObjectURL(file)
    setSourceUrl(nextSourceUrl)
    setStatus('ready')
    setMessage('Đã nhận ảnh. Chọn biểu cảm rồi bấm Generate.')
  }

  function toggleExpression(expression: ExpressionId) {
    setSelected((current) =>
      current.includes(expression)
        ? current.filter((item) => item !== expression)
        : [...current, expression],
    )
  }

  async function handleGenerate() {
    if (!sourceFile || !canGenerate) return
    setStatus('generating')
    setMessage('Đang chỉnh đầu nhìn thẳng, tạo biểu cảm và làm matte tóc…')
    setOutputs([])
    setGenerationProgress({ completed: 0, prepared: 0, total: selected.length, percent: 0, stage: 'expressions' })

    try {
      const result = await generateExpressions(sourceFile, selected, intensity, setGenerationProgress)
      setOutputs(result.outputs)
      setStatus('ready')
      setMessage(`Đã tạo ${result.outputs.length} PNG bằng ${generatorLabel}, nền trong suốt, cùng kích thước và vị trí.`)
      setGenerationProgress(null)
    } catch (error) {
      setStatus('ready')
      setGenerationProgress(null)
      setMessage(error instanceof Error ? error.message : 'Generate thất bại.')
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <div>
            <strong>Avatar Studio</strong>
            <span>game avatar studio</span>
          </div>
        </div>
        <div className={`provider-pill ${apiReady ? 'is-ready' : ''}`}>
          <span className="provider-dot" />
          {statusLabel}
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">SELFIE → EXPRESSIONS</p>
        <h1>Một selfie. Cả bộ biểu cảm game.</h1>
        <p className="hero-copy">
          LivePortrait giữ nhận diện từ selfie gốc, căn mặt, tạo biểu cảm và xuất sprite đầu PNG nền trong suốt.
        </p>
      </section>

      <section className="workspace-grid">
        <article className="panel upload-panel">
          <div className="panel-heading">
            <div>
              <span className="step">01</span>
              <h2>Selfie input</h2>
            </div>
            <button className="text-button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              Replace
            </button>
          </div>

          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={handleFile}
          />

          <button className="dropzone" disabled={busy} onClick={() => fileInputRef.current?.click()}>
            {sourceUrl ? (
              <img src={sourceUrl} alt="Uploaded selfie" />
            ) : (
              <div className="dropzone-empty">
                <span className="upload-icon">↥</span>
                <strong>Choose selfie</strong>
                <span>JPG, PNG hoặc WebP</span>
              </div>
            )}
          </button>

          <div className={`analysis-status status-${status}`} role="status">
            <span className="status-dot" />
            <span>{message}</span>
          </div>
        </article>

      </section>

      <section className="panel controls-panel">
        <div className="panel-heading controls-heading">
          <div>
            <span className="step">02</span>
            <h2>Generation setup</h2>
          </div>
          <label className="intensity-control">
            <span>Độ cường điệu {intensity.toFixed(1)}×</span>
            <input
              type="range"
              min="0.6"
              max="1.4"
              step="0.1"
              value={intensity}
              disabled={busy}
              onChange={(event) => setIntensity(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="control-label expression-label">
          <strong>Expression set</strong>
          <span>Chọn các sprite cần xuất.</span>
        </div>
        <div className="expression-grid">
          {expressionOptions.map((expression) => {
            const active = selected.includes(expression.id)
            return (
              <button
                key={expression.id}
                className={`expression-button ${active ? 'is-active' : ''}`}
                aria-pressed={active}
                disabled={busy}
                onClick={() => toggleExpression(expression.id)}
              >
                <span>{expression.glyph}</span>
                <strong>{expression.label}</strong>
                <small>{expression.detail}</small>
              </button>
            )
          })}
        </div>

        <button className="generate-button" disabled={!canGenerate} onClick={handleGenerate}>
          {status === 'generating' && generationProgress
            ? generationProgress.prepared < generationProgress.total
              ? `Đang tạo ${generationProgress.prepared}/${generationProgress.total} biểu cảm · ${generationProgress.percent}%`
              : `Đang xuất ${generationProgress.completed}/${generationProgress.total} PNG · ${generationProgress.percent}%`
            : `Tạo ${selected.length} biểu cảm · PNG trong suốt`}
        </button>
        {status === 'generating' && generationProgress && (
          <div className="generation-progress" aria-label="Generation progress">
            <div style={{ width: `${generationProgress.percent}%` }} />
          </div>
        )}
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div>
            <p className="eyebrow">OUTPUT</p>
            <h2>Expression gallery</h2>
          </div>
          {outputs.length > 0 && (
            <button
              className="text-button"
              aria-pressed={showTransparency}
              onClick={() => setShowTransparency((current) => !current)}
            >
              {showTransparency ? 'Hiện nền game' : 'Xem nền trong suốt'}
            </button>
          )}
        </div>

        <div className="results-grid">
          {outputs.length > 0
            ? outputs.map((output) => (
                <article className="result-card" key={output.expression}>
                  <div className={`result-artwork ${showTransparency ? 'show-transparency' : ''}`}>
                    <img src={output.url} alt={`${output.expression} expression`} />
                  </div>
                  <div>
                    <strong>{expressionOptions.find((item) => item.id === output.expression)?.label}</strong>
                    <button
                      className="text-button"
                      aria-label={`Tải ${output.expression} PNG`}
                      onClick={() => {
                        void downloadExpression(output).catch((error: unknown) => {
                          setMessage(error instanceof Error ? error.message : 'Không tải được PNG.')
                        })
                      }}
                    >
                      PNG ↗
                    </button>
                  </div>
                </article>
              ))
            : expressionOptions.map((item) => (
                <article className="result-card result-placeholder" key={item.id}>
                  <div className="placeholder-glyph">{item.glyph}</div>
                  <div>
                    <strong>{item.label}</strong>
                    <span>waiting</span>
                  </div>
                </article>
              ))}
        </div>
      </section>
    </main>
  )
}

export default App
