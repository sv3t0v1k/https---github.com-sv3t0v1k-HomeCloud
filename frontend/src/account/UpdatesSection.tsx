import { useEffect, useRef, useState } from 'react'
import { apiRequest } from '../api/client'

type UpdateCheck = {
  channel: 'test' | 'release'
  installed: { version: string; gitSha: string } | null
  available: { version: string; gitSha: string; manifestSha256: string; changes: string; compatibility: string } | null
  status: 'installed_unknown' | 'available' | 'current' | 'check_unavailable'
}

type InstallStatus = {
  status: 'DISABLED' | 'NO_JOB' | 'UNKNOWN_REQUIRES_REVIEW' | 'QUEUED' |
    'VALIDATION_REQUIRED' | 'RUNNING' | 'STOP' | 'MANUAL_RECOVERY_REQUIRED' | 'INSTALLED'
  manifestSha256: string | null
  phase: string | null
  updatedAt: string | null
}

const phases: Record<string, string> = {
  VERIFY_TRUST: 'Проверка сборки', FETCH_MANIFEST: 'Получение манифеста',
  INSTALLER: 'Запуск установщика', CHECKOUT: 'Проверка исходного кода',
  VERIFY_IMAGES: 'Проверка образов', PREBACKUP: 'Проверка резервной копии',
  STOP_SERVICES: 'Остановка сервисов', BACKUP: 'Резервное копирование',
  WRITE_REFS: 'Переключение образов', START_SERVICES: 'Запуск сервисов',
  SMOKE: 'Проверка HTTPS и сервисов', COMMIT_STATE: 'Фиксация результата',
  COMPLETE: 'Проверка результата',
}

function statusText(job: InstallStatus): string {
  const stage = job.phase && phases[job.phase] ? ` Этап: ${phases[job.phase]}.` : ''
  switch (job.status) {
    case 'DISABLED': return 'Установка через интерфейс на этом стенде выключена.'
    case 'NO_JOB': return 'Установка не запущена.'
    case 'QUEUED': return 'Заявка передана хосту.'
    case 'VALIDATION_REQUIRED': return 'Заявка принята; ожидается проверка хостом.'
    case 'RUNNING': return `Выполняется: ${job.phase && phases[job.phase] ? phases[job.phase] : 'проверка состояния'}.`
    case 'INSTALLED': return 'Хост подтвердил успешную установку.'
    case 'STOP': return `Хост отклонил заявку до установки. Нужна проверка оператором.${stage}`
    case 'MANUAL_RECOVERY_REQUIRED': return `Результат установки не подтверждён. Нужна ручная проверка; повторный запуск запрещён.${stage}`
    case 'UNKNOWN_REQUIRES_REVIEW': return 'Статус хоста недостоверен. Нужна проверка оператором.'
  }
}

export function UpdatesSection() {
  const [admin, setAdmin] = useState(false)
  const [result, setResult] = useState<UpdateCheck | null>(null)
  const [job, setJob] = useState<InstallStatus | null>(null)
  const [statusError, setStatusError] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const refreshedInstall = useRef<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void apiRequest<{ admin: boolean }>({ method: 'GET', url: '/updates/access', signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setAdmin(value.admin) })
      .catch(() => { if (!controller.signal.aborted) setAdmin(false) })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (!admin) return
    const controller = new AbortController()
    void apiRequest<UpdateCheck>({ method: 'GET', url: '/updates', signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setResult(value) })
      .catch(() => { if (!controller.signal.aborted) setResult({ channel: 'test', installed: null, available: null, status: 'check_unavailable' }) })
    return () => controller.abort()
  }, [admin, refresh])
  useEffect(() => {
    if (!admin) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const poll = async () => {
      controller = new AbortController()
      try {
        const value = await apiRequest<InstallStatus>({ method: 'GET', url: '/updates/installations/current', signal: controller.signal })
        if (!stopped) {
          // The inbox can exist before admission publishes its durable receipt.
          setJob((previous) => previous?.status === 'QUEUED' && value.status === 'NO_JOB' ? previous : value)
          setStatusError(false)
        }
      } catch {
        if (!stopped) setStatusError(true)
      } finally {
        if (!stopped) timer = setTimeout(() => { void poll() }, 3000)
      }
    }
    void poll()
    return () => { stopped = true; controller?.abort(); if (timer) clearTimeout(timer) }
  }, [admin])
  useEffect(() => {
    if (job?.status === 'INSTALLED' && job.manifestSha256 &&
        refreshedInstall.current !== job.manifestSha256) {
      refreshedInstall.current = job.manifestSha256
      setResult(null)
      setRefresh((value) => value + 1)
    }
  }, [job])

  const available = result?.channel === 'test' && result.status === 'available' ? result.available : null
  const canSubmit = available && /^[a-f0-9]{64}$/.test(available.manifestSha256) && job?.status === 'NO_JOB' && !statusError && !submitting
  const submit = async () => {
    if (!canSubmit || !available) return
    setSubmitting(true); setConfirm(false); setSubmitError(null)
    try {
      const accepted = await apiRequest<InstallStatus>({ method: 'POST', url: '/updates/installations', data: { manifestSha256: available.manifestSha256 } })
      setJob(accepted)
    } catch {
      setSubmitError('Приём заявки не подтверждён. Проверьте статус перед повторной попыткой; предыдущая установка может требовать проверки оператором.')
    } finally { setSubmitting(false) }
  }
  if (!admin) return null
  return <section aria-label="Обновления" className="account-section">
    <h3>Обновления</h3>
    <p>Канал: {result?.channel === 'release' ? 'release' : 'test'}.</p>
    <p>Установленная версия: {result?.installed ? `${result.installed.version} (${result.installed.gitSha.slice(0, 7)})` : 'не определена'}.</p>
    {result?.status === 'available' && result.available ? <>
      <p role="status">Доступна проверенная сборка {result.available.version}.</p>
      {result.available.changes ? <p>{result.available.changes}</p> : null}
    </> : result?.status === 'current' ? <p role="status">Новой проверенной сборки нет.</p>
      : result?.status === 'installed_unknown' ? <p role="status">Нет подтверждённых данных об установленной сборке. Сравнение недоступно.</p>
      : result ? <p role="status">Проверка сейчас недоступна. Наличие обновления неизвестно.</p>
      : <p role="status">Проверяем доступные сборки…</p>}
    <button className="button button--ghost" onClick={() => { setResult(null); setRefresh((value) => value + 1) }} type="button">Проверить снова</button>
    <p role="status">{job ? statusText(job) : 'Получаем статус установки…'}</p>
    {statusError ? <p role="alert">Связь с сервером статуса прервана. Проверка повторится автоматически; не запускайте установку повторно.</p> : null}
    {submitError ? <p role="alert">{submitError}</p> : null}
    {canSubmit && !confirm ? <button className="button button--primary" onClick={() => setConfirm(true)} type="button">Установить {available.version}</button> : null}
    {confirm && available ? <div role="group" aria-label="Подтверждение установки">
      <p>Установить TEST-сборку {available.version}? Во время установки сервис временно недоступен.</p>
      <button className="button button--primary" disabled={!canSubmit} onClick={() => void submit()} type="button">Подтвердить установку</button>
      <button className="button button--ghost" onClick={() => setConfirm(false)} type="button">Отмена</button>
    </div> : null}
  </section>
}
