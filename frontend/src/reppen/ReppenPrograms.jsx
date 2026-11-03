// The Reppen programs screen (#/reppen): the program you are enrolled in and its next workout,
// and the catalog to enroll from. Reachable only where reppenAvailable says so.
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button, NumberField, Row, Section, Segmented, SelectRow } from '../components/ui.jsx'
import { reppenAvailable, reppenStore, useReppen } from './connection.js'
import { exerciseName, massReadings, unaskedParameters } from './store.js'
import { errorText } from './messages.js'
import OfflineStatus from './OfflineStatus.jsx'
import { fmtDate } from '../lib/format.js'
import { massParameters, initialSetup, validSetup, positive } from './setup.js'
import './reppen.css'

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
  const pending = useReppen(s => s.local.pendingEnrollment)
  const retry = pending?.artifactId === entry.artifactId
  const names = useReppen(s => s.exerciseNames)
  const readings = massReadings(entry)
  const [kg, setKg] = useState({})
  const [setup, setSetup] = useState(() => initialSetup(entry))
  const [confirmed, setConfirmed] = useState(false)
  const parameters = massParameters(entry)
  const slots = [...new Set(parameters.map(p => p.slot))]
  const blocked = cannotEnroll(entry)
  const missing = !retry && (readings.some((r, i) => (r.required || kg[i] != null) && !positive(kg[i])) || !validSetup(entry, setup, confirmed))
  const submit = async () => { if (await actions().enroll(entry, kg, setup, confirmed)) onDone() }
  return <div className="card reppen-enroll" data-catalog-id={entry.catalogId}>
    <h2>{entry.title}</h2>
    {readings.length > 0 && <p className="sect-f">{t('Enter your current numbers. The program sets your first weights from them.')}</p>}
    {retry && <p className="sect-f">{t('Retrying confirms the original enrollment request and readings.')}</p>}
    {slots.map(slot => <fieldset key={slot} className="rp-setup">
      <legend>{t('Day {0}', slot.split('_')[0].toUpperCase())} · {parameters.find(p => p.slot === slot).exerciseName}</legend>
      {parameters.filter(p => p.slot === slot).map(p => <label key={p.name} className="measure-field">
        <span>{p.purpose === 'startingLoad' ? t('Weight ({0})', 'lb') : t('Step ({0})', 'lb')}</span>
        <NumberField nullable value={(retry ? pending.setup?.[p.name] : setup[p.name]) ?? null} disabled={retry}
          aria-label={`${p.exerciseName} ${p.purpose === 'startingLoad' ? t('Weight ({0})', 'lb') : t('Step ({0})', 'lb')}`}
          onChange={v => { setSetup(prev => ({ ...prev, [p.name]: v })); setConfirmed(false) }} />
      </label>)}
    </fieldset>)}
    {parameters.length > 0 && <label><input type="checkbox" checked={retry ? !!pending.confirmed : confirmed} disabled={retry}
      onChange={e => setConfirmed(e.target.checked)} />{t('Confirm starting weights and equipment increments in lb (dumbbells per hand).')}</label>}
    {readings.length > 0 && <div className="measure-form rp-readings">
      {readings.map((r, i) => <label key={i} className="measure-field rp-reading" data-key={r.key}>
        <span>{r.key ? exerciseName(names, r.key) : readingLabel(r)}</span>
        <span className="measure-input">
          <NumberField value={(retry ? pending.kgByReading?.[i] : kg[i]) ?? null} disabled={retry} nullable aria-label={readingLabel(r) + (r.key ? ' ' + exerciseName(names, r.key) : '')}
            onChange={v => setKg(prev => ({ ...prev, [i]: v }))} />
          <i>kg</i>
        </span>
        {r.key && <span className="rp-t">{readingLabel(r)}</span>}
      </label>)}
    </div>}
    {blocked && <p className="sect-f" role="alert">{blocked}</p>}
    {replaces && <p className="sect-f">{t('This replaces {0} in this app.', replaces)}</p>}
    <div className="row" style={{ gap: 8, marginTop: 10 }}>
      <Button variant="filled" disabled={!!blocked || missing || busy} onClick={submit}>{retry ? t('Try again') : t('Enroll')}</Button>
      <Button onClick={onDone}>{t('Cancel')}</Button>
    </div>
  </div>
}

function NextWorkout({ enrollment, nextDay, workoutId, nav }) {
  const days = enrollment.days || []
  const busy = useReppen(s => s.busy)
  const start = async () => { if (await actions().start(nextDay)) nav('/reppen/workout') }
  return <Section title={t('Your program')}>
    <Row icon="dumbbell" title={enrollment.title} subtitle={nextDay ? t('Next workout: {0}', nextDay) : null} />
    {days.length > 1 && (days.length <= 4
      ? <div className="reppen-days"><Segmented value={nextDay} onChange={d => actions().chooseDay(d)} options={days.map(d => ({ value: d, label: d }))} /></div>
      : <SelectRow title={t('Day')} value={nextDay} onChange={d => actions().chooseDay(d)} options={days.map(d => ({ value: d, label: d }))} />)}
    <div className="reppen-days">
      {workoutId
        ? <Button variant="filled" icon="play" onClick={() => nav('/reppen/workout')}>{t('Resume workout')}</Button>
        : <Button variant="filled" icon="play" disabled={!nextDay || busy} onClick={start}>{t('Start {0}', nextDay || '')}</Button>}
    </div>
  </Section>
}

// A start found another workout active (another device, or one this browser lost track of).
export function Held({ held, nav }) {
  const go = async fn => { if (await fn()) nav('/reppen/workout') }
  return <div className="card rp-held" role="alert">
    <p>{t('Another workout is already in progress: {0}, {1} entries logged.', held.active?.day ?? '?', held.active?.eventCount ?? 0)}</p>
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <Button variant="filled" onClick={() => go(actions().continueActive)}>{t('Continue that workout')}</Button>
      <Button onClick={() => go(actions().continueHeld)}>{t('Start this one instead')}</Button>
    </div>
  </div>
}

function History({ items, catalog }) {
  const titleOf = artifactId => catalog?.find(e => e.artifactId === artifactId)?.title
  return <Section title={t('Reppen history')} footer={items && !items.length ? t('Finished workouts show here.') : null}>
    {(items || []).map(h => <Row key={h.workoutId} icon="history" title={fmtDate(h.localDay || h.date, true, true)}
      subtitle={titleOf(h.artifactId) || (h.source === 'manual' ? t('Logged by hand') : null)} />)}
  </Section>
}

export default function ReppenPrograms() {
  const nav = useNavigate()
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const local = useReppen(s => s.local)
  const catalog = useReppen(s => s.catalog)
  const error = useReppen(s => s.error)
  const catalogError = useReppen(s => s.catalogError)
  const enrollmentError = useReppen(s => s.enrollmentError)
  const held = useReppen(s => s.held)
  const history = useReppen(s => s.history)
  const [picking, setPicking] = useState(null)
  const ok = reppenAvailable(config, user)

  useEffect(() => {
    if (!ok) return
    actions().hydrate()
    actions().loadExerciseNames()
    actions().loadCatalog()
    actions().loadEnrollment()
    actions().loadHistory()
    // A workout in progress may be held back by another one active elsewhere: resume says so.
    actions().resume()
  }, [ok, user?.id])

  if (!config && !ok) return null
  if (!ok) return <Navigate to="/plan" replace />
  const enrollment = local.enrollment
  const nextDay = local.nextDay ?? enrollment?.defaultDay ?? null

  return <div className="narrow reppen">
    <div className="hdr">
      <button className="iconbtn" data-back="/plan" onClick={() => nav('/plan')} aria-label={t('Plan')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{t('Programs')}</h1><div className="sub">Reppen</div></div>
    </div>
    {[error, catalogError, enrollmentError].filter(Boolean).map((e, i) => <div key={i} className="card reppen-error" role="alert">{errorText(e)}</div>)}
    <OfflineStatus />
    {held && <Held held={held} nav={nav} />}
    {enrollment && <NextWorkout enrollment={enrollment} nextDay={nextDay} workoutId={local.workoutId} nav={nav} />}
    {picking
      ? <EnrollForm entry={picking} replaces={enrollment && enrollment.artifactId !== picking.artifactId ? enrollment.title : null} onDone={() => setPicking(null)} />
      : <Section title={t('Programs')} footer={catalog && !catalog.length ? t('No programs are published yet.') : null}>
        {!catalog && !catalogError && <Row title={t('Loading…')} />}
        {(catalog || []).map(entry => <Row key={entry.artifactId} icon="list" title={entry.title}
          subtitle={t('{0} days', (entry.days || []).length)}
          accessory={enrollment?.artifactId === entry.artifactId ? 'check' : 'chevron'}
          onClick={enrollment?.artifactId === entry.artifactId ? undefined : () => setPicking(entry)} />)}
      </Section>}
    <History items={history} catalog={catalog} />
  </div>
}
