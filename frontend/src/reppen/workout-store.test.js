// The workout half of the Reppen store, against the fake Reppen (scripts/reppen-fake.mjs) through
// the real client: what goes over the wire is what the store sends.
import { describe, expect, it, vi } from 'vitest'
import { createFakeReppen } from '../../scripts/reppen-fake.mjs'
import { reppenClient } from './client.js'
import { createReppenStore } from './store.js'

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }
}

// One fake server; each device is its own store and storage, signed in to the same account.
function world() {
  const fake = createFakeReppen()
  const sent = []
  let drop = null   // which request's answer to lose, after the server applied it
  const fetch = vi.fn(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    sent.push({ method: init.method, path: url.replace(/^\/reppen/, ''), body })
    const { status, body: out } = fake.handle(init.method, url.replace(/^\/reppen/, ''), body, 'u1')
    if (drop && drop(init.method, url)) { drop = null; throw new TypeError('Failed to fetch') }
    return new Response(JSON.stringify(out), { status })
  })
  const client = reppenClient({ base: () => '/reppen/', token: async () => 't', fetch })
  const device = () => {
    const store = createReppenStore({ client, owner: () => 'u1', storage: memoryStorage(), today: () => '2026-11-01' })
    store.getState().hydrate()
    return store
  }
  return { device, sent, loseAnswer: (method, suffix) => { drop = (m, url) => m === method && url.split('/').at(-1).startsWith(suffix) }, client }
}

async function enrolled(w, store = w.device()) {
  await store.getState().loadCatalog()
  expect(await store.getState().enroll(store.getState().catalog[0], { 0: 140, 1: 100 })).toBe(true)
  return store
}
const logWork = async (s, slot, n, values) => { for (let i = 0; i < n; i++) await s.getState().logSet(slot, 'work', i, values) }

describe('Reppen store: a workout', () => {
  it('starts, logs sets by their issued keys with fresh event ids, answers, and finishes', async () => {
    const w = world()
    const s = await enrolled(w)
    expect(await s.getState().start('A1')).toBe(true)
    const { workout } = s.getState()
    expect(workout.day).toBe('A1')
    expect(s.getState().local.workoutId).toBe(workout.workoutId)
    await logWork(s, 'squat', 3, { load: 102.5, reps: 5 })
    const batches = w.sent.filter(r => r.path.endsWith('/events'))
    expect(batches.map(b => b.body.expectedRevision)).toEqual([0, 1, 2])
    expect(batches[0].body.events[0]).toMatchObject({ kind: 'setLogged', slot: 'squat', step: 'work', set: 0, values: { load: 102.5, reps: 5 } })
    expect(new Set(batches.map(b => b.body.events[0].id)).size).toBe(3)
    // The question opened by those sets; finishing waits for its answer.
    const [q] = s.getState().workout.pendingQuestions
    expect(q.text).toBe('Add a back-off set?')
    expect(await s.getState().finish()).toBe(false)
    expect(s.getState().error.body.code).toBe('questionsPending')
    await s.getState().answer(q, q.choices[0])
    const answered = w.sent.at(-1).body.events[0]
    expect(answered).toMatchObject({ kind: 'questionAnswered', question: 'backoff', occurrence: q.occurrence, value: { v: 'bool', b: true } })
    // The answer added a set with a target Reppen calculated from the logged ones.
    const squat = s.getState().workout.effectivePlan.slots.find(x => x.slot === 'squat')
    expect(squat.steps.at(-1)).toMatchObject({ key: 'backoff', sets: [{ metrics: { load: { v: { v: 92.5 } } } }] })
    expect(await s.getState().finish()).toBe(true)
    expect(s.getState().finished.completed.day).toBe('A1')
    expect(s.getState().workout).toBe(null)
    expect(s.getState().local).toMatchObject({ workoutId: null, nextDay: 'B1' })
    await s.getState().loadHistory()
    expect(s.getState().history.map(h => h.workoutId)).toEqual([workout.workoutId])
  })

  it('repeats a start whose answer was lost with the same workout id', async () => {
    const w = world()
    const s = await enrolled(w)
    w.loseAnswer('PUT', '')
    expect(await s.getState().start('A1')).toBe(false)
    expect(s.getState().error.code).toBe('offline')
    expect(await s.getState().start('A1')).toBe(true)
    const puts = w.sent.filter(r => r.method === 'PUT' && r.path.includes('/workouts/'))
    expect(puts).toHaveLength(2)
    expect(puts[1].path).toBe(puts[0].path)
  })

  it('keeps a batch whose answer was lost and sends it again as the same events', async () => {
    const w = world()
    const s = await enrolled(w)
    await s.getState().start('A1')
    w.loseAnswer('POST', 'events')
    await s.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    expect(s.getState().outbox).toHaveLength(1)
    expect(s.getState().error.code).toBe('offline')
    await s.getState().flush()
    expect(s.getState().outbox).toHaveLength(0)
    expect(s.getState().workout.revision).toBe(1)   // applied once, not twice
  })

  it('catches up with another device, then sends what is still its own', async () => {
    const w = world()
    const phone = await enrolled(w)
    await phone.getState().start('A1')
    const laptop = w.device()
    laptop.setState({ local: { ...phone.getState().local } })
    await laptop.getState().resume()
    await phone.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    // The laptop still holds revision 0: its event is refused, it refetches and resends at 1.
    await laptop.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    expect(laptop.getState().outbox).toHaveLength(0)
    expect(laptop.getState().workout.revision).toBe(2)
    expect(laptop.getState().workout.events.map(e => e.slot)).toEqual(['squat', 'bench'])
  })

  it('turns an event Reppen will not take into a rejected draft and sends the rest', async () => {
    const w = world()
    const s = await enrolled(w)
    await s.getState().start('A1')
    await s.getState().logSet('squat', 'work', 9, { load: 100, reps: 5 })   // no such set
    expect(s.getState().rejected).toHaveLength(1)
    expect(s.getState().rejected[0]).toMatchObject({ code: 'invalidEvent', event: { set: 9 } })
    await s.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    expect(s.getState().workout.revision).toBe(1)
  })

  it('offers both ways out when another workout is already active', async () => {
    const w = world()
    const phone = await enrolled(w)
    await phone.getState().start('A1')
    const first = phone.getState().workout.workoutId
    const laptop = w.device()
    laptop.setState({ local: { ...phone.getState().local, workoutId: null } })
    expect(await laptop.getState().start('B1')).toBe(false)
    expect(laptop.getState().held.active.workoutId).toBe(first)
    await laptop.getState().continueHeld()
    expect(laptop.getState().workout).toMatchObject({ day: 'B1', active: true })
    // The phone's workout is held now; it can take the active place back the same way.
    expect(await phone.getState().start('A1')).toBe(false)   // a new id, so a new start, refused
    await phone.getState().continueActive()
    expect(phone.getState().workout.day).toBe('B1')
  })
})
