// A finished Reppen workout as an OpenGym history entry (history.js), from what the fake Reppen
// (scripts/reppen-fake.mjs) answers to a real finish.
import { describe, expect, it } from 'vitest'
import { createFakeReppen } from '../../scripts/reppen-fake.mjs'
import { addManaged, hasManaged, managedWorkout } from './history.js'
import { entryExcluded } from '../lib/history.js'
import { queueDone, queueNext } from '../lib/queue.js'

const NAMES = { 'wger:111': 'Barbell Back Squat', 'wger:192': 'Barbell Bench Press' }

// One finished A1 workout: squat work sets logged (one corrected by a clear and a re-log), bench
// untouched but for one set.
function finishedA1() {
  const fake = createFakeReppen()
  const call = (method, path, body) => fake.handle(method, path, body, 'u1').body
  call('PUT', '/v1/enrollments/e1', { artifactId: 'sha256:fake-gzclp', startOn: '2026-11-01', params: { squatStart: { v: 'none' } },
    readings: ['wger:111', 'wger:192'].map(key => ({ fact: 'e1rm', key, value: { n: key === 'wger:111' ? 140 : 100 } })) })
  call('PUT', '/v1/workouts/w1', { enrollmentId: 'e1', enrollmentRevision: 0, localDay: '2026-10-30', day: 'A1' })
  const ev = (id, kind, slot, set, values) => ({ id, kind, slot, step: 'work', set, ...(values ? { values } : {}) })
  const events = [
    ev('a', 'setLogged', 'squat', 0, { load: 100, reps: 5 }), ev('b', 'setLogged', 'squat', 1, { load: 100, reps: 4 }),
    ev('c', 'setCleared', 'squat', 1), ev('d', 'setLogged', 'squat', 1, { load: 100, reps: 5 }),
    ev('e', 'setLogged', 'bench', 0, { load: 60, reps: 10 }),
  ]
  call('POST', '/v1/workouts/w1/events', { expectedRevision: 0, events })
  return call('POST', '/v1/workouts/w1/finish', { expectedRevision: events.length })
}
const made = (result = finishedA1(), unit = 'kg') => managedWorkout(result, { title: 'GZCLP', names: NAMES, unit })

describe('a Reppen workout in OpenGym history', () => {
  it('becomes one managed workout: the logged sets by exercise, on its own day', () => {
    const { workout, exercises } = made()
    expect(workout).toMatchObject({
      id: 'reppen:w1', d: '2026-10-30', name: 'GZCLP · A1', routineIds: [], routineId: null,
      managed: { source: 'reppen', workoutId: 'w1', enrollmentId: 'e1', revision: 5 },
    })
    expect(workout.start).toBe(new Date(2026, 9, 30).getTime())
    expect(workout.end).toBe(workout.start)
    expect(workout.entries).toEqual([
      { id: 'reppen:wger:111', sets: [{ w: 100, r: 5, done: true }, { w: 100, r: 5, done: true }], topW: 100, target: null },
      { id: 'reppen:wger:192', sets: [{ w: 60, r: 10, done: true }], topW: 60, target: null },
    ])
    expect(exercises.map(e => [e.id, e.n, e.custom])).toEqual([['reppen:wger:111', 'Barbell Back Squat', true], ['reppen:wger:192', 'Barbell Bench Press', true]])
  })

  it('is the same entry from a finish answer and from the finished workout fetched later', () => {
    const answer = finishedA1()
    const view = { ...answer.workout, status: 'completed', completed: answer.completed }
    expect(made(view)).toEqual(made(answer))
  })

  it('stores loads in the profile\'s unit', () => {
    expect(made(undefined, 'lb').workout.entries[0].sets[0].w).toBe(220.5)
  })

  it('is added once, never over a deletion, and leaves a renamed exercise alone', () => {
    const S = { workouts: [], customEx: [{ id: 'reppen:wger:111', n: 'Squat (mine)', custom: true }], deleted: {} }
    S.workouts = [{ id: 'old', d: '2026-10-29', start: 1 }, { id: 'new', d: '2026-10-31', start: 2 }]
    expect(addManaged(S, made())).toBe(true)
    expect(addManaged(S, made())).toBe(false)
    // In date order, between the two it falls between.
    expect(S.workouts.map(w => w.id)).toEqual(['old', 'reppen:w1', 'new'])
    expect(S.customEx.map(e => e.n)).toEqual(['Squat (mine)', 'Barbell Bench Press'])
    const gone = { workouts: [], customEx: [], deleted: { workouts: { 'reppen:w1': Date.now() } } }
    expect(hasManaged(gone, 'w1')).toBe(true)
    expect(addManaged(gone, made())).toBe(false)
    // An add-back on record (a negative stamp) is no deletion.
    expect(hasManaged({ workouts: [], deleted: { workouts: { 'reppen:w1': -5 } } }, 'w1')).toBe(false)
  })

  it('is kept out of OpenGym\'s progression, queue and next routine', () => {
    const { workout } = made()
    expect(workout.entries.every(e => entryExcluded(workout, e))).toBe(true)
    // A week whose first session shares the managed workout's name, dated inside it.
    const S = {
      routines: [{ id: 'd1', name: 'GZCLP · A1' }, { id: 'd2', name: 'B' }], workouts: [{ ...workout, d: '2026-10-30', start: Date.parse('2026-10-30T10:00') }],
      queue: { ids: ['d1', 'd2'], since: Date.parse('2026-10-27T00:00'), startsOn: '2026-10-27' },
    }
    expect(queueDone(S)).toEqual([])
    // The same workout on the week's routine would count: the rule above is the one that skips it.
    expect(queueDone({ ...S, workouts: [{ ...S.workouts[0], routineIds: ['d1'] }] })).toEqual(['d1'])
    expect(queueNext(S, '2026-10-31', '2026-10-31')).toBe('d1')
  })
})
