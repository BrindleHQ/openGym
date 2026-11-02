import { useEffect } from 'react'
import { Button } from '../components/ui.jsx'
import { t } from '../lib/i18n.js'
import { reppenStore, useReppen } from './connection.js'

export default function OfflineStatus() {
  const blocked = useReppen(s => s.offlineBlocked)
  const queued = useReppen(s => s.outbox.length + s.offlineJournal.length + (s.offlineStart ? 1 : 0))
  const recovered = useReppen(s => s.offlineRecovery?.length || 0)
  const actions = () => reppenStore.getState()
  useEffect(() => {
    if (!queued || blocked) return
    const sync = () => { if (navigator.onLine) actions().flush() }
    window.addEventListener('online', sync); window.addEventListener('focus', sync)
    sync()
    return () => { window.removeEventListener('online', sync); window.removeEventListener('focus', sync) }
  }, [queued, blocked])
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(actions().offlineRecoveryData(), null, 2)], { type: 'application/json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'reppen-offline-recovery.json'; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  if (!blocked && !queued && !recovered) return null
  return <div className="card" role="status">
    {blocked ? <>
      <p>{t('The server result differs. Your offline entries are kept on this device.')}</p>
      <Button size="sm" onClick={download}>{t('Download saved offline entries')}</Button>
      <Button size="sm" onClick={() => actions().reconcileOffline()}>{t('Use server workout and keep a recovery copy')}</Button>
    </> : queued ? <>
      <p>{t('Saved on this device. Waiting to sync.')}</p>
      <Button size="sm" onClick={() => actions().flush()}>{t('Sync now')}</Button>
    </> : <Button size="sm" onClick={download}>{t('Download saved offline entries')}</Button>}
  </div>
}
