import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'

type RunnerStatus = 'enrolled' | 'online' | 'offline' | 'revoked'
type RunnerCapabilities = {
  os?: string
  arch?: string
  gpu?: string | null
  backend?: string
  vramMb?: number | null
  modelVersion?: string
  runtimeVersion?: string
  maxDecodeBatch?: number
  generators?: string[]
  [key: string]: unknown
}
type Runner = {
  runnerId: string
  name: string
  status: RunnerStatus
  lastHeartbeatAt: string | null
  capabilities: RunnerCapabilities
  activeJobs: number
  maxInflightJobs: number
  createdAt: string
  currentVersion?: string
}
type Metrics = {
  master: {
    enabled: boolean
    infrastructure_mode: string
    runner_ws_path: string
    runner_version: string
    heartbeat_timeout_seconds: number
  }
  runners: {
    total: number
    online: number
    enrolled: number
    offline: number
    revoked: number
    active_jobs: number
  }
  generated_at: string
}
type ApiError = Error & { status?: number }

const statusLabels: Record<RunnerStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  enrolled: 'Enrolled',
  revoked: 'Revoked',
}

async function request<T>(token: string, route: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1/admin/${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  })
  if (!response.ok) {
    const error = new Error(response.status === 401
      ? 'Admin token không hợp lệ hoặc chưa được cấu hình trên Master.'
      : `Yêu cầu thất bại (HTTP ${response.status}). Vui lòng thử lại.`) as ApiError
    error.status = response.status
    throw error
  }
  return response.json() as Promise<T>
}

async function fetchSnapshot(token: string) {
  const [metrics, runners] = await Promise.all([
    request<Metrics>(token, 'metrics'),
    request<Runner[]>(token, 'runners'),
  ])
  return { metrics, runners }
}

function formatDate(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Chưa có'
  return new Date(value).toLocaleString('vi-VN')
}

function heartbeat(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Chưa có'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds} giây trước`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`
  return `${Math.floor(seconds / 86400)} ngày trước`
}

function copyText(text: string) {
  return navigator.clipboard.writeText(text)
}

function Modal({
  open,
  title,
  eyebrow,
  onClose,
  children,
}: {
  open: boolean
  title: string
  eyebrow?: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  if (!open) return null
  return (
    <dialog ref={ref} aria-labelledby={`${title}-title`} onCancel={(event) => { event.preventDefault(); onClose() }}>
      <div className="dialog-heading">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 id={`${title}-title`}>{title}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Đóng">×</button>
      </div>
      {children}
    </dialog>
  )
}

function LoginScreen({ onLogin, initialError = '' }: { onLogin: (token: string) => Promise<string | null>; initialError?: string }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  useEffect(() => setError(initialError), [initialError])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!token.trim()) return
    setBusy(true)
    setError('')
    const result = await onLogin(token.trim())
    if (result) setError(result)
    setBusy(false)
  }
  return (
    <section className="login-screen" aria-labelledby="login-title">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark" aria-hidden="true">A</span>
        <p className="eyebrow">AVATAR MASTER</p>
        <h1 id="login-title">Quản lý hệ thống</h1>
        <p className="muted">Đăng nhập để theo dõi và kết nối các máy Runner.</p>
        <label htmlFor="admin-token">Admin token</label>
        <input id="admin-token" type="password" required autoComplete="off" spellCheck="false" placeholder="Nhập AVATAR_ADMIN_TOKEN" value={token} onChange={(event) => setToken(event.target.value)} />
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="button primary" type="submit" disabled={busy}>{busy ? 'Đang xác thực…' : 'Đăng nhập'}</button>
        <p className="fine-print">Token chỉ được giữ trong bộ nhớ của tab. Tải lại trang sẽ cần đăng nhập lại.</p>
      </form>
    </section>
  )
}

function EnrollmentModal({
  open,
  token,
  metrics,
  onClose,
  onUnauthorized,
}: {
  open: boolean
  token: string
  metrics: Metrics | null
  onClose: () => void
  onUnauthorized: (error: unknown) => boolean
}) {
  const [ttl, setTtl] = useState('900')
  const [code, setCode] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [platform, setPlatform] = useState<'unix' | 'windows'>('unix')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) {
      setCode('')
      setError('')
      setFeedback('')
      return
    }
    setPlatform('unix')
    setTtl('900')
    setNow(Date.now())
  }, [open])
  useEffect(() => {
    if (!open || !code) return
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [code, open])
  const command = useMemo(() => {
    if (!code || !metrics) return ''
    const endpoint = new URL(window.location.origin)
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:'
    endpoint.pathname = metrics.master.runner_ws_path
    endpoint.search = ''
    endpoint.hash = ''
    if (platform === 'windows') {
      const tick = String.fromCharCode(96)
      return `powershell -ExecutionPolicy Bypass -File .\\install-windows.ps1 ${tick}\n  -MasterUrl '${endpoint.href.replaceAll("'", "''")}' ${tick}\n  -EnrollmentCode '${code}'`
    }
    const quotedEndpoint = `'${endpoint.href.replaceAll("'", "'\\''")}'`
    return `AVATAR_MASTER_URL=${quotedEndpoint} \\\nAVATAR_RUNNER_ENROLL_CODE='${code}' \\\nbash install.sh`
  }, [code, metrics, platform])
  const remaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0
  const createCode = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const result = await request<{ code: string; expires_at: string }>(token, 'runners/enrollment-codes', { method: 'POST', body: JSON.stringify({ ttl_seconds: Number(ttl) }) })
      setCode(result.code)
      setExpiresAt(Date.parse(result.expires_at))
    } catch (cause) {
      if (!onUnauthorized(cause)) setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (value: string) => {
    try { await copyText(value); setFeedback('Đã sao chép.') } catch { setFeedback('Clipboard không khả dụng; hãy sao chép thủ công.') }
  }
  return (
    <Modal open={open} title="Kết nối máy mới" eyebrow="RUNNER ENROLLMENT" onClose={onClose}>
      <p className="muted">Mã dùng một lần để đăng ký Runner. Sau kết nối, máy sẽ xuất hiện trong danh sách.</p>
      {!code ? (
        <form onSubmit={createCode}>
          <label htmlFor="enroll-ttl">Thời hạn mã</label>
          <select id="enroll-ttl" value={ttl} onChange={(event) => setTtl(event.target.value)}><option value="300">5 phút</option><option value="900">15 phút</option><option value="1800">30 phút</option><option value="3600">60 phút</option></select>
          {error && <p className="error-text" role="alert">{error}</p>}
          <button className="button primary full-width" type="submit" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo mã enrollment'}</button>
        </form>
      ) : (
        <section aria-label="Mã enrollment mới">
          <div className="code-box"><code>{code}</code><button className="button" type="button" onClick={() => void copy(code)}>Sao chép mã</button></div>
          <p className={`fine-print ${remaining === 0 ? 'expired' : ''}`}>{remaining ? `Mã dùng một lần · Còn ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}.` : 'Mã đã hết hạn. Đóng cửa sổ và tạo mã mới.'}</p>
          <label htmlFor="install-platform">Lệnh cài trên máy Runner</label>
          <select id="install-platform" value={platform} onChange={(event) => setPlatform(event.target.value as 'unix' | 'windows')}><option value="unix">Ubuntu / macOS</option><option value="windows">Windows PowerShell</option></select>
          <p className="fine-print">Chạy lệnh trong thư mục chứa bộ cài Runner.</p>
          <pre className="command-box">{command}</pre>
          <button className="button full-width" type="button" disabled={!remaining} onClick={() => void copy(command)}>Sao chép lệnh cài</button>
          {feedback && <p className="fine-print" role="status">{feedback}</p>}
        </section>
      )}
    </Modal>
  )
}

function RunnerDetailsModal({
  runner,
  open,
  onClose,
  onRevoke,
}: { runner: Runner | null; open: boolean; onClose: () => void; onRevoke: () => void }) {
  if (!runner) return null
  const capability = runner.capabilities
  const rows: Array<[string, string | number | undefined | null]> = [
    ['Runner ID', runner.runnerId], ['Trạng thái', statusLabels[runner.status]], ['Hệ điều hành', [capability.os, capability.arch].filter(Boolean).join(' / ')],
    ['GPU', capability.gpu], ['Backend', capability.backend], ['VRAM báo cáo', capability.vramMb == null ? '—' : `${capability.vramMb.toLocaleString('vi-VN')} MB`],
    ['Job đang xử lý', `${runner.activeJobs} / ${runner.maxInflightJobs}`], ['Decode batch tối đa', capability.maxDecodeBatch], ['Runtime version', runner.currentVersion || capability.runtimeVersion],
    ['Model version', capability.modelVersion], ['Generator', capability.generators?.join(', ')], ['Đăng ký lúc', formatDate(runner.createdAt)], ['Heartbeat cuối', formatDate(runner.lastHeartbeatAt)],
  ]
  return (
    <Modal open={open} title="Thông tin Runner" eyebrow="RUNNER DETAILS" onClose={onClose}>
      <dl className="details-list">{rows.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd>{value ?? '—'}</dd></Fragment>)}</dl>
      {runner.status !== 'revoked' && <button className="button destructive full-width" type="button" onClick={onRevoke}>Thu hồi quyền kết nối</button>}
    </Modal>
  )
}

function RevokeModal({ runner, open, busy, error, onClose, onConfirm }: { runner: Runner | null; open: boolean; busy: boolean; error: string; onClose: () => void; onConfirm: () => void }) {
  if (!runner) return null
  return (
    <Modal open={open} title="Thu hồi Runner?" onClose={onClose}>
      <p>Thu hồi quyền kết nối của “{runner.name || runner.runnerId}”?</p>
      <p className="muted">Runner sẽ bị ngắt kết nối và không nhận thêm job. Job chưa hoàn tất sẽ đi qua cơ chế retry. Để sử dụng lại máy này, cần enrollment mới.</p>
      {error && <p className="error-text" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button" type="button" onClick={onClose}>Hủy</button><button className="button destructive" type="button" onClick={onConfirm} disabled={busy}>{busy ? 'Đang thu hồi…' : 'Thu hồi Runner'}</button></div>
    </Modal>
  )
}

function Dashboard({
  metrics,
  runners,
  loading,
  error,
  onRefresh,
  onLogout,
  onEnrollment,
  onSelectRunner,
}: {
  metrics: Metrics
  runners: Runner[]
  loading: boolean
  error: string
  onRefresh: () => void
  onLogout: () => void
  onEnrollment: () => void
  onSelectRunner: (runner: Runner) => void
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const visible = useMemo(() => runners.filter((runner) => {
    const values = [runner.name, runner.runnerId, runner.capabilities.gpu, runner.capabilities.backend, runner.capabilities.os, runner.currentVersion]
    return (filter === 'all' || runner.status === filter) && values.some((value) => String(value ?? '').toLowerCase().includes(query.toLowerCase()))
  }), [filter, query, runners])
  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Điều hướng quản trị">
        <a className="brand" href="/admin"><span className="brand-mark" aria-hidden="true">A</span><span>Avatar<span className="brand-subtitle">Master console</span></span></a>
        <p className="sidebar-label">WORKSPACE</p>
        <nav><a className="nav-link" href="#overview">Tổng quan</a><a className="nav-link" href="#runners">Runner</a><button className="nav-link" type="button" onClick={onEnrollment}>Kết nối máy mới</button></nav>
        <div className="sidebar-footer"><span className="sidebar-label">ENDPOINT</span><span className="host-label">{window.location.host}</span><span className="fine-print">Public API · Scheduler · WSS</span></div>
      </aside>
      <main className="main-content">
        <header className="topbar"><span className="breadcrumb">Master <span>/</span> Quản trị</span><button className="button subtle" type="button" onClick={onLogout}>Đăng xuất</button></header>
        <section id="overview" className="overview" aria-labelledby="overview-title">
          <div className="section-heading"><div><p className="eyebrow">HẠ TẦNG INFERENCE</p><h1 id="overview-title">Tổng quan hệ thống</h1><p className="muted">Theo dõi Runner và điều phối kết nối tới Master.</p></div><button className="button primary" type="button" onClick={onEnrollment}>+ Kết nối Runner</button></div>
          <div className="sync-line"><span className={`sync-indicator ${error ? 'error' : 'connected'}`} aria-hidden="true" /><span role="status">{loading ? 'Đang tải dữ liệu…' : error ? 'Mất kết nối · dữ liệu có thể đã cũ' : `Cập nhật lúc ${new Date(metrics.generated_at).toLocaleTimeString('vi-VN')}`}</span><span className="muted">Tự cập nhật mỗi 10 giây</span></div>
          {error && <div className="notice danger" role="alert">{error}</div>}
          {!metrics.master.enabled && <div className="notice">Scheduler đang tắt. Runner chưa thể kết nối hoặc nhận job. Bật AVATAR_MASTER_ENABLED=1 khi khởi động Master.</div>}
          <div className="stats-grid"><article className="stat-card"><span>Tổng Runner</span><strong>{metrics.runners.total}</strong><small>Máy đã đăng ký</small></article><article className="stat-card"><span><i className="status-dot online" aria-hidden="true" /> Online</span><strong>{metrics.runners.online}</strong><small>Sẵn sàng kết nối</small></article><article className="stat-card"><span><i className="status-dot offline" aria-hidden="true" /> Offline</span><strong>{metrics.runners.offline}</strong><small>Không còn heartbeat</small></article><article className="stat-card"><span>Job đang xử lý</span><strong>{metrics.runners.active_jobs}</strong><small>Do Runner online báo cáo</small></article></div>
          <div className="master-info"><span>Storage · {metrics.master.infrastructure_mode === 'aws' ? 'AWS' : 'Local'}</span><span>Runtime yêu cầu · {metrics.master.runner_version}</span><span>WSS · {metrics.master.runner_ws_path}</span><span>{metrics.runners.revoked} Runner đã thu hồi</span></div>
        </section>
        <section id="runners" className="panel" aria-labelledby="runners-title">
          <div className="panel-heading"><div><h2 id="runners-title">Danh sách Runner</h2><p className="muted">Thông tin máy, tải hiện tại và lần kết nối gần nhất.</p></div><button className="button" type="button" onClick={onRefresh} disabled={loading}>Làm mới</button></div>
          <div className="table-toolbar"><div className="search-field"><label className="sr-only" htmlFor="runner-search">Tìm Runner</label><input id="runner-search" type="search" placeholder="Tìm tên, ID hoặc GPU…" autoComplete="off" value={query} onChange={(event) => setQuery(event.target.value)} /></div><label className="sr-only" htmlFor="runner-status">Lọc trạng thái</label><select id="runner-status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Tất cả trạng thái</option><option value="online">Online</option><option value="offline">Offline</option><option value="enrolled">Enrolled</option><option value="revoked">Revoked</option></select><span className="muted">{visible.length} / {runners.length} Runner</span></div>
          {visible.length ? <div className="table-scroll"><table><caption className="sr-only">Runner đã đăng ký với Avatar Master</caption><thead><tr><th>Runner</th><th>Trạng thái</th><th>GPU / Backend</th><th>Job / Capacity</th><th>Phiên bản</th><th>Heartbeat</th><th><span className="sr-only">Thao tác</span></th></tr></thead><tbody>{visible.map((runner) => <tr key={runner.runnerId}><td><span className="runner-name">{runner.name || 'Runner'}</span><span className="cell-secondary runner-id" title={runner.runnerId}>{runner.runnerId}</span></td><td><span className={`badge ${runner.status}`}>{statusLabels[runner.status]}</span></td><td><span className="hardware-name">{runner.capabilities.gpu || 'Chưa có thông tin GPU'}</span><span className="cell-secondary">{[runner.capabilities.os, runner.capabilities.arch, runner.capabilities.backend].filter(Boolean).join(' · ') || '—'}</span></td><td>{runner.activeJobs} / {runner.maxInflightJobs}<span className="cell-secondary">Job đang xử lý</span></td><td>{runner.currentVersion || runner.capabilities.runtimeVersion || '—'}<span className="cell-secondary">{runner.capabilities.modelVersion || '—'}</span></td><td title={formatDate(runner.lastHeartbeatAt)}>{heartbeat(runner.lastHeartbeatAt)}</td><td><button className="row-action" type="button" onClick={() => onSelectRunner(runner)}>Chi tiết →</button></td></tr>)}</tbody></table></div> : <div className="empty-state"><span className="empty-symbol" aria-hidden="true">⌘</span><h3>{runners.length ? 'Không tìm thấy Runner' : 'Chưa có Runner'}</h3><p className="muted">{runners.length ? 'Thử đổi từ khóa hoặc bộ lọc trạng thái.' : 'Tạo mã enrollment, rồi chạy installer trên máy inference để kết nối.'}</p>{!runners.length && <button className="button" type="button" onClick={onEnrollment}>Kết nối Runner đầu tiên</button>}</div>}
          <div className="panel-footer"><span>Offline sau {metrics.master.heartbeat_timeout_seconds}s không có heartbeat.</span><span>Mỗi Runner giữ một LivePortrait runtime.</span></div>
        </section>
      </main>
    </div>
  )
}

export default function App() {
  const [token, setToken] = useState('')
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [runners, setRunners] = useState<Runner[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [enrollmentOpen, setEnrollmentOpen] = useState(false)
  const [selectedRunner, setSelectedRunner] = useState<Runner | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState('')

  const logout = useCallback((reason = '') => {
    setToken('')
    setMetrics(null)
    setRunners([])
    setError(reason)
    setSelectedRunner(null)
    setEnrollmentOpen(false)
    setRevokeOpen(false)
  }, [])
  const unauthorized = useCallback((cause: unknown) => {
    if ((cause as ApiError).status !== 401) return false
    logout('Phiên đã hết hiệu lực. Vui lòng đăng nhập lại.')
    return true
  }, [logout])
  const refresh = useCallback(async (currentToken = token) => {
    if (!currentToken) return
    setLoading(true)
    try {
      const snapshot = await fetchSnapshot(currentToken)
      setMetrics(snapshot.metrics)
      setRunners(snapshot.runners)
      setError('')
    } catch (cause) {
      if (!unauthorized(cause)) setError((cause as Error).message)
    } finally {
      setLoading(false)
    }
  }, [token, unauthorized])
  const login = useCallback(async (candidate: string) => {
    try {
      const snapshot = await fetchSnapshot(candidate)
      setToken(candidate)
      setMetrics(snapshot.metrics)
      setRunners(snapshot.runners)
      setError('')
      return null
    } catch (cause) {
      return (cause as Error).message
    }
  }, [])
  useEffect(() => {
    if (!token) return
    const interval = window.setInterval(() => { if (!document.hidden) void refresh() }, 10000)
    const visible = () => { if (!document.hidden) void refresh() }
    document.addEventListener('visibilitychange', visible)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', visible) }
  }, [refresh, token])
  const revoke = async () => {
    if (!selectedRunner) return
    setRevokeBusy(true)
    setRevokeError('')
    try {
      const result = await request<Runner>(token, `runners/${encodeURIComponent(selectedRunner.runnerId)}/revoke`, { method: 'POST' })
      setRunners((current) => current.map((runner) => runner.runnerId === result.runnerId ? result : runner))
      setSelectedRunner(null)
      setRevokeOpen(false)
      await refresh()
    } catch (cause) {
      if (!unauthorized(cause)) setRevokeError((cause as Error).message)
    } finally {
      setRevokeBusy(false)
    }
  }
  if (!metrics || !token) return <LoginScreen onLogin={login} initialError={error} />
  return <>
    <Dashboard metrics={metrics} runners={runners} loading={loading} error={error} onRefresh={() => void refresh()} onLogout={() => logout()} onEnrollment={() => setEnrollmentOpen(true)} onSelectRunner={setSelectedRunner} />
    <EnrollmentModal open={enrollmentOpen} token={token} metrics={metrics} onClose={() => setEnrollmentOpen(false)} onUnauthorized={unauthorized} />
    <RunnerDetailsModal runner={selectedRunner} open={Boolean(selectedRunner)} onClose={() => setSelectedRunner(null)} onRevoke={() => { setRevokeError(''); setRevokeOpen(true) }} />
    <RevokeModal runner={selectedRunner} open={revokeOpen} busy={revokeBusy} error={revokeError} onClose={() => setRevokeOpen(false)} onConfirm={() => void revoke()} />
  </>
}
