// The Reppen programs screen (#/reppen): the program you are enrolled in and its next workout,
// and the catalog to enroll from. Reachable only where reppenAvailable says so.
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Row, Section, Segmented, SelectRow } from '../components/ui.jsx'
import { reppenAvailable, reppenStore, useReppen } from './connection.js'
import { massReadings, unaskedParameters } from './store.js'
import { errorText } from './messages.js'

const actions = () => reppenStore.getState()

const readingLabel = r => (r.fact === 'e1rm' ? t('Estimated one-rep max') : r.fact)

// Why this form cannot enroll in `entry`, or null when it can.
function cannotEnroll(entry) {
  if (entry.admission?.status && entry.admission.status !== 'supported') return t('This program cannot run here yet.')
  const masses = new Set(massReadings(entry))
  if ((entry.readings || []).some(r => r.required && !masses.has(r))) return t('This program needs readings this app cannot collect yet.')
  if (unaskedParameters(entry).length) return t('This program needs settings this app cannot collect yet.')
  return null
}

function EnrollForm({ entry, replaces, onDone }) {
  const busy = useReppen(s => s.busy)
  const readings = massReadings(entry)
  const [kg, setKg] = useState({})
  const blocked = cannotEnroll(entry)
  const missing = readings.some((r, i) => r.required && !(kg[i] > 0))
  const submit = async () => { if (await actions().enroll(entry, kg)) onDone() }
  return <div className="card reppen-enroll" data-catalog-id={entry.catalogId}>
    <h2>{entry.title}</h2>
    {readings.length > 0 && <p className="sect-f">{t('Enter your current numbers. The program sets your first weights from them.')}</p>}
    {readings.map((r, i) => <label key={i} className="row between reppen-reading">
      <span><span>{readingLabel(r)}</span> <span className="sub">{r.key}</span></span>
      <span className="row"><NumberField value={kg[i] ?? null} nullable aria-label={readingLabel(r) + ' ' + (r.key || '')}
        onChange={v => setKg(prev => ({ ...prev, [i]: v }))} /> kg</span>
    </label>)}
    {blocked && <p className="sect-f" role="alert">{blocked}</p>}
    {replaces && <p className="sect-f">{t('This replaces {0} in this app.', replaces)}</p>}
    <div className="row" style={{ gap: 8, marginTop: 10 }}>
      <Button variant="filled" disabled={!!blocked || missing || busy} onClick={submit}>{t('Enroll')}</Button>
      <Button onClick={onDone}>{t('Cancel')}</Button>
    </div>
  </div>
}

function NextWorkout({ enrollment, nextDay }) {
  const days = enrollment.days || []
  return <Section title={t('Your program')}>
    <Row icon="dumbbell" title={enrollment.title} subtitle={nextDay ? t('Next workout: {0}', nextDay) : null} />
    {days.length > 1 && (days.length <= 4
      ? <div className="reppen-days"><Segmented value={nextDay} onChange={d => actions().chooseDay(d)} options={days.map(d => ({ value: d, label: d }))} /></div>
      : <SelectRow title={t('Day')} value={nextDay} onChange={d => actions().chooseDay(d)} options={days.map(d => ({ value: d, label: d }))} />)}
  </Section>
}

export default function ReppenPrograms() {
  const nav = useNavigate()
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const local = useReppen(s => s.local)
  const catalog = useReppen(s => s.catalog)
  const error = useReppen(s => s.error)
  const [picking, setPicking] = useState(null)
  const ok = reppenAvailable(config, user)

  useEffect(() => {
    if (!ok) return
    actions().hydrate()
    actions().loadCatalog()
    actions().loadEnrollment()
  }, [ok, user?.id])

  if (!config) return null
  if (!ok) return <Navigate to="/plan" replace />
  const enrollment = local.enrollment
  const nextDay = local.nextDay ?? enrollment?.defaultDay ?? null

  return <div className="narrow reppen">
    <div className="hdr">
      <button className="iconbtn" data-back="/plan" onClick={() => nav('/plan')} aria-label={t('Plan')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Programs')}</h1><div className="sub">Reppen</div></div>
    </div>
    {error && <div className="card reppen-error" role="alert">{errorText(error)}</div>}
    {enrollment && <NextWorkout enrollment={enrollment} nextDay={nextDay} />}
    {picking
      ? <EnrollForm entry={picking} replaces={enrollment && enrollment.artifactId !== picking.artifactId ? enrollment.title : null} onDone={() => setPicking(null)} />
      : <Section title={t('Programs')} footer={catalog && !catalog.length ? t('No programs are published yet.') : null}>
        {!catalog && !error && <Row title={t('Loading…')} />}
        {(catalog || []).map(entry => <Row key={entry.artifactId} icon="list" title={entry.title}
          subtitle={t('{0} days', (entry.days || []).length)}
          accessory={enrollment?.artifactId === entry.artifactId ? 'check' : 'chevron'}
          onClick={enrollment?.artifactId === entry.artifactId ? undefined : () => setPicking(entry)} />)}
      </Section>}
  </div>
}
