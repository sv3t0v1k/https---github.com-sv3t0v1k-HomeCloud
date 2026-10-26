import { useEffect, useState } from 'react'
import { apiRequest } from '../api/client'

type UpdateCheck = {
  channel: 'test'
  installed: { version: string; gitSha: string } | null
  available: { version: string; gitSha: string; changes: string; compatibility: string } | null
  status: 'installed_unknown' | 'available' | 'current' | 'check_unavailable'
}

export function UpdatesSection() {
  const [admin, setAdmin] = useState(false)
  const [result, setResult] = useState<UpdateCheck | null>(null)
  const [refresh, setRefresh] = useState(0)
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
  if (!admin) return null
  return <section aria-label="Обновления" className="account-section">
    <h3>Обновления</h3>
    <p>Канал: test. Установка через интерфейс пока недоступна.</p>
    <p>Установленная версия: {result?.installed ? `${result.installed.version} (${result.installed.gitSha.slice(0, 7)})` : 'не определена'}.</p>
    {result?.status === 'available' && result.available ? <>
      <p role="status">Доступна проверенная сборка {result.available.version}.</p>
      {result.available.changes ? <p>{result.available.changes}</p> : null}
    </> : result?.status === 'current' ? <p role="status">Новой проверенной сборки нет.</p>
      : result?.status === 'installed_unknown' ? <p role="status">Нет подтверждённых данных об установленной сборке. Сравнение недоступно.</p>
      : result ? <p role="status">Проверка сейчас недоступна. Наличие обновления неизвестно.</p>
      : <p role="status">Проверяем доступные сборки…</p>}
    <button className="button button--ghost" onClick={() => { setResult(null); setRefresh((value) => value + 1) }} type="button">Проверить снова</button>
  </section>
}
