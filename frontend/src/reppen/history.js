/* A finished Reppen workout in OpenGym's own history, so the app's history list, statistics and
 * records count it. Reppen stays the authority; this is a copy made once per Reppen workout.
 *
 * Exactly once: the entry's id is made from the Reppen workout id (`reppen:<workoutId>`), and the
 * profile sync merges workouts by id (lib/sync-merge.js unionById; the server stores the list as
 * sent). A second delivery, after a reload or from another device, finds the entry and leaves it;
 * two devices that each add it before they sync end up with one. A workout the person deleted
 * here is not added again: the removal on record (deleted.workouts) stands.
 *
 * Managed: the entry carries `managed: { source: 'reppen', workoutId, enrollmentId, revision }`.
 * OpenGym's progression skips it (lib/history.js entryExcluded). It names no routine, so the
 * week's queue, the rotation and the next-routine choice, which count a workout by its routine
 * ids, never count it. The workout sheet shows it read-only.
 *
 * Exercises: Reppen's ids (`wger:111`) are not OpenGym catalogue ids, so each lift is stored under
 * a custom exercise `reppen:<exercise id>`, named from Reppen's catalogue, added once and never
 * renamed from here.
 */
import { convertWeight } from '../lib/units.js'
import { insertChronological } from '../lib/backfill.js'
import { loggedSets, posKey } from './plan.js'
import { exerciseName } from './store.js'

export const managedId = workoutId => 'reppen:' + workoutId
export const managedExerciseId = id => 'reppen:' + id

// The start of the workout's own day, where this device is. Reppen records the day a program
// workout belongs to, not when it was done, and every device has to write the same entry: a
// device that adds it late (it never synced the first copy) must not outrank a deletion made
// since, which the sync compares against the entry's time (sync-merge.js applyDeletions).
const dayStart = day => new Date(day + 'T00:00:00').getTime()

/**
 * The OpenGym workout for a finished Reppen workout: the sets logged, by the plan's slots in order,
 * in the profile's unit. `result` is a finish answer ({ workout, completed }) or a completed view.
 * @returns {{ workout: object, exercises: object[] } | null} null when nothing was logged
 */
export function managedWorkout(result, { title, names, unit }) {
  const view = result?.workout || result
  const completed = result?.completed || view?.completed
  if (!view?.workoutId || !completed) return null
  const plan = view.effectivePlan || view.plan
  const from = plan?.stamp?.display?.load || 'kg'
  const logged = loggedSets({ events: completed.events || view.events })
  const entries = [], exercises = []
  for (const slot of plan?.slots || []) {
    const sets = []
    for (const step of slot.steps || []) {
      (step.sets || []).forEach((_, i) => {
        const v = logged.get(posKey(slot.slot, step.key, i))?.values
        if (v) sets.push({ w: Number(convertWeight(v.load ?? 0, from, unit)) || 0, r: Number(v.reps) || 0, done: true })
      })
    }
    if (!sets.length) continue
    const exerciseId = slot.exercise?.id || slot.slot
    const id = managedExerciseId(exerciseId)
    entries.push({ id, sets, topW: Math.max(...sets.map(s => s.w)) || null, target: null })
    exercises.push({ id, n: slot.exercise?.label || exerciseName(names, exerciseId), custom: true, eq: '', bp: '', tg: '' })
  }
  if (!entries.length) return null
  const day = completed.localDay || view.localDay
  const at = dayStart(day)
  return {
    exercises,
    workout: {
      id: managedId(view.workoutId), d: day, start: at, end: at, routineIds: [], routineId: null,
      name: [title, completed.day || view.day].filter(Boolean).join(' · '), entries, prs: [],
      managed: { source: 'reppen', workoutId: view.workoutId, enrollmentId: completed.enrollmentId || view.enrollmentId, revision: completed.revision ?? view.revision },
    },
  }
}

/** Whether the profile `S` already has the Reppen workout `workoutId`, or had it and the person deleted it. */
export function hasManaged(S, workoutId) {
  const id = managedId(workoutId)
  return (S?.workouts || []).some(w => w?.id === id) || Number(S?.deleted?.workouts?.[id]) > 0
}

/** Adds a managedWorkout() to the profile draft `S`, unless it is already there or was deleted. */
export function addManaged(S, made) {
  if (!made || hasManaged(S, made.workout.managed.workoutId)) return false
  const known = new Set((S.customEx || []).map(e => e?.id))
  const missing = made.exercises.filter(e => !known.has(e.id))
  if (missing.length) S.customEx = [...(S.customEx || []), ...missing]
  // The list is kept in date order (History and Stats read it so); a workout delivered late goes
  // where its day puts it.
  S.workouts = insertChronological(S.workouts || [], made.workout)
  return true
}
