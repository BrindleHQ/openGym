import { useState } from 'react'
import { Button, NumberField } from '../components/ui.jsx'
import { t } from '../lib/i18n.js'
import { EXIDX } from '../lib/exercises.js'
import { reppenStore, useReppen } from './connection.js'
import { LB_KG, positive } from './setup.js'

const setupKinds = new Set(['loadTrial', 'startingLoadConfirmed', 'equipmentConfirmed'])
export const pendingSetup = (outbox, slot) => outbox.some(e => e.slot === slot && setupKinds.has(e.kind))
const shown = (kg, unit) => kg == null ? null : Number((kg / (unit === 'lb' ? LB_KG : 1)).toFixed(8))
const feedbackLabel = feedback => feedback === 'easy' ? t('Too easy') : feedback === 'hard' ? t('Too hard') : t('Manageable')

// These IDs carry an explicit OpenGym catalogue mapping. Never pick an exercise
// demonstration by a fuzzy name match, which could show the wrong movement.
export const guidanceExercise = slot => EXIDX[/^custom:opengym-(.+)$/.exec(slot.exercise?.id)?.[1]]

export function ExerciseGuidance({ slot }) {
  const exercise = guidanceExercise(slot)
  if (!exercise) return null
  return <Button size="sm" onClick={async () => {
    const { exerciseDetailSheet } = await import('../sheets.jsx')
    exerciseDetailSheet(exercise)
  }}>{t('How to do it')}</Button>
}

export default function StartingWeight({ slot, unit, disabled, started }) {
  const setup = slot.setup
  const outbox = useReppen(s => s.outbox)
  const waiting = pendingSetup(outbox, slot.slot)
  const trials = setup?.trials || []
  const last = trials.at(-1)
  const [mode, setMode] = useState(() => last ? 'trial' : null)
  const [load, setLoad] = useState(null)
  const [reps, setReps] = useState(null)
  const [saving, setSaving] = useState(false)
  const [kept, setKept] = useState(false)
  const [regularStep, setRegularStep] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const canCorrect = setup?.confirmedThisWorkout && !started
  if (!setup || !setup.loadRequired && !setup.progressionPending && !waiting && !canCorrect) return null
  const locked = disabled || waiting || saving
  const kg = load == null ? null : load * (unit === 'lb' ? LB_KG : 1)
  const validLoad = positive(kg)
  const validReps = Number.isSafeInteger(reps) && reps > 0
  const act = async run => { setSaving(true); try { await run(reppenStore.getState()) } finally { setSaving(false) } }
  const weightField = label => <label className="measure-field">
    <span>{label} ({unit})</span>
    <NumberField nullable value={load} disabled={locked} aria-label={`${label} (${unit})`} onChange={value => { setLoad(value); setRegularStep(false) }} />
  </label>
  const body = setup.loadRequired || correcting && canCorrect ? <>
    <h3>{setup.loadRequired ? t('Find your starting weight') : t('Starting weight')}</h3>
    {setup.loadRequired && <p>{t('Your starting weight is not set. Practice first, then confirm a weight for your working sets.')}</p>}
    {setup.loadRequired && <div className="rp-setup-actions">
      <Button disabled={locked} variant={mode === 'known' ? 'tinted' : undefined} onClick={() => { setMode('known'); setLoad(null) }}>{t('I know my weight')}</Button>
      <Button disabled={locked} variant={mode === 'trial' ? 'tinted' : undefined} onClick={() => { setMode('trial'); setLoad(null) }}>{t('Help me find it')}</Button>
    </div>}
    {mode === 'known' && <>
      {weightField(t('Starting weight'))}
      <Button disabled={locked || !validLoad} variant="filled" onClick={() => act(async a => { await a.confirmStartingLoad(slot.slot, kg, 'known'); setCorrecting(false) })}>{t('Use this starting weight')}</Button>
    </>}
    {mode === 'trial' && <>
      <p>{t('Check the exercise instructions and begin with a light weight you can control. Try the planned rep range without struggling to finish. You should feel able to do a few more reps with the same form.')}</p>
      <p className="sect-f">{t('These are practice sets. They will not count as working sets or change your progression.')}</p>
      {last && <p className="rp-trial-feedback" role="status">{last.feedback === 'easy'
        ? t('Try the next small weight available if you feel ready, then check again.')
        : last.feedback === 'hard' ? t('Choose a lighter weight and try again after resting. Stop if the movement hurts.')
          : t('If that felt controlled and you could do a few more reps, you can use it as your starting weight.')}</p>}
      <div className="rp-setup-inputs">
        {weightField(t('Practice weight'))}
        <label className="measure-field"><span>{t('Practice reps')}</span><NumberField nullable value={reps} disabled={locked} aria-label={t('Practice reps')} onChange={setReps} /></label>
      </div>
      <div className="rp-setup-actions">
        {['easy', 'manageable', 'hard'].map(feedback => <Button key={feedback} disabled={locked || !validLoad || !validReps}
          onClick={() => act(a => a.logLoadTrial(slot.slot, kg, reps, feedback))}>{feedbackLabel(feedback)}</Button>)}
      </div>
      {trials.length > 0 && <ol className="rp-trials" aria-label={t('Practice sets')}>
        {trials.map((trial, i) => <li key={i}>{shown(trial.loadKg, unit)} {unit} × {trial.reps} · {feedbackLabel(trial.feedback)}</li>)}
      </ol>}
      {last?.feedback === 'manageable' && <Button disabled={locked} variant="filled"
        onClick={() => act(a => a.confirmStartingLoad(slot.slot, last.loadKg, 'trial'))}>{t('Use {0} {1} as my starting weight', shown(last.loadKg, unit), unit)}</Button>}
    </>}
  </> : setup.progressionPending && !kept && !started ? <>
    <h3>{t('Ready for a heavier weight')}</h3>
    <p>{t('You earned an increase. What is the next heavier weight available for this exercise?')}</p>
    <p className="sect-f">{t('Current weight: {0} {1}. Choose the next weight you can actually use.', shown(setup.workingLoadKg, unit), unit)}</p>
    {weightField(t('Next available weight'))}
    {validLoad && kg > setup.workingLoadKg && <label className="rp-regular-step"><input type="checkbox" checked={regularStep} disabled={locked}
      onChange={e => setRegularStep(e.target.checked)} />{t('Available weights use this same step ({0} {1}).', shown(kg - setup.workingLoadKg, unit), unit)}</label>}
    <div className="rp-setup-actions">
      <Button disabled={locked || !validLoad || kg <= setup.workingLoadKg} variant="filled" onClick={() => act(a => regularStep ? a.confirmEquipment(slot.slot, kg, kg - setup.workingLoadKg) : a.confirmEquipment(slot.slot, kg))}>{t('Use the heavier weight')}</Button>
      <Button disabled={locked} onClick={() => setKept(true)}>{t('Keep my current weight today')}</Button>
    </div>
  </> : null
  return <div className="rp-starting-weight">
    {body}
    {canCorrect && !correcting && !setup.loadRequired && <div className="rp-setup-actions"><span>{t('Starting weight')}: {shown(setup.workingLoadKg, unit)} {unit}</span>
      <Button size="sm" disabled={locked} onClick={() => { setCorrecting(true); setMode('known'); setLoad(shown(setup.workingLoadKg, unit)) }}>{t('Edit')}</Button>
    </div>}
    {setup.loadRequired && <p className="sect-f">{t('Dumbbell weights are per hand. For barbells and EZ bars, include the bar. Use the same machine and weight convention each time.')}</p>}
    {waiting && <p role="status">{t('Setup saved on this device. Connect to confirm it before logging working sets.')}</p>}
    {!setup.loadRequired && (kept || started) && <p className="sect-f">{t('Keep your current weight for this workout. We will ask about the increase next time.')}</p>}
  </div>
}
