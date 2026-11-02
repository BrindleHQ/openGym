// A Reppen workout in progress (#/reppen/workout): the effective plan Reppen issued, set by set,
// with the targets it calculated, its open questions, and Finish. Every tick is an event the store
// sends (store.js); this screen only reads the workout view back.
import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import Icon from '../components/Icon.jsx'
import { Button, Check, NumberField } from '../components/ui.jsx'
import { reppenAvailable, reppenStore, useReppen } from './connection.js'
import { loggedSets, metricOrder, posKey, startValue, targetText } from './plan.js'
import { errorText } from './messages.js'
import { Held } from './ReppenPrograms.jsx'
import './reppen.css'

const actions = () => reppenStore.getState()

const metricLabel = (m, unit) => (m === 'load' ? (unit || 'kg') : m === 'reps' ? t('Reps') : m)
const roleLabel = role => (role === 'amrap' ? t('AMRAP') : role === 'working' ? null : role)

function SetRow({ slot, step, set, index, number, logged, unit }) {
  const metrics = metricOrder(set.metrics)
  const [draft, setDraft] = useState({})
  const value = m => (m in draft ? draft[m] : startValue(set.metrics[m], logged?.values?.[m]))
  const done = !!logged
  const toggle = () => {
    if (done) return actions().clearSet(slot, step.key, index)
    const values = {}
    for (const m of metrics) { const v = value(m); if (v != null) values[m] = v }
    return actions().logSet(slot, step.key, index, values)
  }
  const role = roleLabel(set.role)
  return <div className={'rp-set' + (done ? ' done' : '') + (logged?.pending ? ' pending' : '')} data-pos={posKey(slot, step.key, index)}>
    <span className="rp-n">{number}{role && <small>{role}</small>}</span>
    {metrics.map(m => <label key={m} className="rp-m">
      <NumberField value={value(m)} nullable disabled={done} aria-label={metricLabel(m, unit)}
        onChange={v => setDraft(d => ({ ...d, [m]: v }))} />
      <span className="rp-t">{targetText(set.metrics[m]) ?? t('calculated')} {metricLabel(m, unit)}</span>
    </label>)}
    <Check checked={done} label={t('Set {0} done', number)} onChange={toggle} />
  </div>
}

function SlotCard({ slot, logged, unit }) {
  // Sets are numbered through the exercise, as on the app's own workout screen; each still logs
  // under its own step key and index.
  let number = 0
  return <div className="card rp-slot" data-slot={slot.slot}>
    <h2>{slot.exercise?.label || slot.slot}</h2>
    {slot.steps.map(step => <div key={step.key} className="rp-step" data-step={step.key}>
      {step.live && <p className="sect-f">{t('Reppen calculated these targets from the sets you logged.')}</p>}
      {step.sets.map((set, i) => <SetRow key={i} slot={slot.slot} step={step} set={set} index={i} number={++number}
        logged={logged.get(posKey(slot.slot, step.key, i))} unit={unit} />)}
    </div>)}
  </div>
}

function Question({ q }) {
  return <div className="card rp-question" data-question={q.id}>
    <h2>{q.text}</h2>
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      {q.choices.map((c, i) => <Button key={i} variant="tinted" onClick={() => actions().answer(q, c)}>{c.label}</Button>)}
    </div>
  </div>
}

function Finished({ result, nextDay, nav }) {
  return <div className="card rp-finished">
    <h2><Icon name="check" /> {t('Workout saved')}</h2>
    <p>{t('Day {0} is in your Reppen history.', result.completed?.day ?? result.workout?.day)}</p>
    {nextDay && <p>{t('Next workout: {0}', nextDay)}</p>}
    <Button variant="filled" onClick={() => nav('/reppen')}>{t('Done')}</Button>
  </div>
}

export default function ReppenWorkout() {
  const nav = useNavigate()
  const config = useStore(s => s.config)
  const user = useStore(s => s.user)
  const workout = useReppen(s => s.workout)
  const outbox = useReppen(s => s.outbox)
  const rejected = useReppen(s => s.rejected)
  const error = useReppen(s => s.error)
  const busy = useReppen(s => s.busy)
  const finished = useReppen(s => s.finished)
  const local = useReppen(s => s.local)
  const held = useReppen(s => s.held)
  const [loaded, setLoaded] = useState(false)
  const ok = reppenAvailable(config, user)

  useEffect(() => {
    if (!ok) return
    actions().hydrate()
    const st = actions()
    if (st.workout && st.workout.workoutId === st.local.workoutId) { setLoaded(true); return }
    st.resume().finally(() => setLoaded(true))
  }, [ok, user?.id])

  if (!config) return null
  if (!ok) return <Navigate to="/plan" replace />
  const head = (title, sub) => <div className="hdr">
    <button className="iconbtn" data-back="/reppen" onClick={() => nav('/reppen')} aria-label={t('Programs')}><Icon name="chevronLeft" /></button>
    <div style={{ flex: 1, marginInlineStart: 12 }}><h1>{title}</h1>{sub && <div className="sub">{sub}</div>}</div>
  </div>
  if (!workout) {
    if (finished) return <div className="narrow reppen">{head(t('Workout'))}<Finished result={finished} nextDay={local.nextDay} nav={nav} /></div>
    if (!loaded) return <div className="narrow reppen">{head(t('Workout'))}</div>
    if (!error) return <Navigate to="/reppen" replace />
  }

  const plan = workout?.effectivePlan || workout?.plan
  const logged = loggedSets(workout, outbox)
  const unit = plan?.stamp?.display?.load
  const questions = workout?.pendingQuestions || []
  return <div className="narrow reppen">
    {head(workout ? t('Day {0}', workout.day) : t('Workout'), local.enrollment?.title)}
    {error && <div className="card reppen-error" role="alert">{errorText(error)}
      {workout && <Button size="sm" onClick={() => actions().flush()}>{t('Try again')}</Button>}</div>}
    {rejected.length > 0 && <div className="card reppen-error" role="alert">
      {t('Reppen did not take {0} of your entries. Log them again if they are still right.', rejected.length)}
      <Button size="sm" onClick={() => actions().dismissRejected()}>{t('OK')}</Button>
    </div>}
    {held && <Held held={held} nav={nav} />}
    {questions.map(q => <Question key={q.occurrence} q={q} />)}
    {(plan?.slots || []).map(slot => <SlotCard key={slot.slot} slot={slot} logged={logged} unit={unit} />)}
    {workout && <div className="rp-finish">
      <Button variant="filled" disabled={busy || questions.length > 0 || outbox.length > 0}
        onClick={async () => { await actions().finish() }}>{t('Finish workout')}</Button>
      {questions.length > 0 && <p className="sect-f">{t('Answer the open questions before finishing.')}</p>}
    </div>}
  </div>
}
