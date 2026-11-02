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
  const net = { down: false }   // no request gets through at all
  const fetch = vi.fn(async (url, init) => {
    if (net.down) throw new TypeError('Failed to fetch')
    const body = init.body ? JSON.parse(init.body) : undefined
    sent.push({ method: init.method, path: url.replace(/^\/reppen/, ''), body })
    const { status, body: out } = fake.handle(init.method, url.replace(/^\/reppen/, ''), body, 'u1')
    if (drop && drop(init.method, url)) { drop = null; throw new TypeError('Failed to fetch') }
    return new Response(JSON.stringify(out), { status })
  })
  const client = reppenClient({ base: () => '/reppen/', token: async () => 't', fetch })
  const device = (opts = {}) => {
    const store = createReppenStore({ client, owner: () => 'u1', storage: memoryStorage(), today: () => '2026-11-01', ...opts })
    store.getState().hydrate()
    return store
  }
  return { device, sent, net, loseAnswer: (method, suffix) => { drop = (m, url) => m === method && url.split('/').at(-1).startsWith(suffix) }, client }
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

  it('tells OpenGym history of a finished workout: its own finish, and one found finished on resuming', async () => {
    const w = world()
    const recordFinished = vi.fn()
    const phone = await enrolled(w, w.device({ recordFinished }))
    await phone.getState().start('A1')
    await phone.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    // The laptop opened the same workout; the phone's finish answer is lost after Reppen applied it.
    const laptopRecord = vi.fn()
    const laptop = w.device({ recordFinished: laptopRecord })
    laptop.setState({ local: { ...phone.getState().local } })
    w.loseAnswer('POST', 'finish')
    expect(await phone.getState().finish()).toBe(false)
    expect(recordFinished).not.toHaveBeenCalled()
    // A reload finds it finished: delivered then, with the completed record.
    await phone.getState().resume()
    expect(recordFinished).toHaveBeenCalledTimes(1)
    expect(recordFinished.mock.calls[0][0]).toMatchObject({ workoutId: expect.any(String), status: 'completed', completed: { day: 'A1' } })
    expect(recordFinished.mock.calls[0][1]).toMatchObject({ title: 'GZCLP (test program)' })
    await laptop.getState().resume()
    expect(laptopRecord).toHaveBeenCalledTimes(1)
    // And a finish that is answered delivers the answer itself.
    const other = vi.fn()
    const s = await enrolled(w, w.device({ recordFinished: other }))
    await s.getState().start('B1')
    await s.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    expect(await s.getState().finish()).toBe(true)
    expect(other).toHaveBeenCalledWith(s.getState().finished, expect.objectContaining({ title: 'GZCLP (test program)' }))
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

// Two devices on one workout: the phone and the laptop, the laptop opened on the phone's workout.
async function twoDevices() {
  const w = world()
  const phone = await enrolled(w)
  await phone.getState().start('A1')
  const recordFinished = vi.fn()
  const laptop = w.device({ recordFinished })
  laptop.setState({ local: { ...phone.getState().local } })
  await laptop.getState().resume()
  return { w, phone, laptop, recordFinished }
}
const values = s => s.getState().workout.events.filter(e => e.kind === 'setLogged').map(e => e.values.load)

describe('Reppen store: two devices on one workout', () => {
  it('keeps the first value saved for a set; the other device holds its own as a draft', async () => {
    const { w, phone, laptop } = await twoDevices()
    await phone.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    await laptop.getState().logSet('squat', 'work', 0, { load: 105, reps: 5 })
    // Refused at revision 0, the laptop refetched and found the set taken: it did not send over it.
    expect(values(laptop)).toEqual([100])
    expect(laptop.getState().outbox).toEqual([])
    expect(laptop.getState().rejected).toMatchObject([{ code: 'setTaken', event: { slot: 'squat', step: 'work', set: 0, values: { load: 105 } } }])
    expect(w.sent.filter(r => r.path.endsWith('/events') && r.body.events.some(e => e.values?.load === 105) && r.body.expectedRevision === 1)).toEqual([])
    // Saving it anyway is a new event over the phone's.
    await laptop.getState().relogDraft(laptop.getState().rejected[0])
    expect(values(laptop)).toEqual([100, 105])
    expect(laptop.getState().rejected).toEqual([])
  })

  it('catches up before sending what waited offline, so a set taken meanwhile is not overwritten', async () => {
    const { w, phone, laptop } = await twoDevices()
    w.net.down = true
    await laptop.getState().logSet('squat', 'work', 0, { load: 105, reps: 5 })
    await laptop.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    expect(laptop.getState().outbox).toHaveLength(2)
    w.net.down = false
    await phone.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    await laptop.getState().catchUp()
    // The other set goes after the phone's; the taken one waits as a draft the person can discard.
    expect(laptop.getState().workout.events.map(e => [e.slot, e.values.load])).toEqual([['squat', 100], ['bench', 50]])
    expect(laptop.getState().outbox).toEqual([])
    const [draft] = laptop.getState().rejected
    expect(draft).toMatchObject({ code: 'setTaken', event: { slot: 'squat', values: { load: 105 } } })
    laptop.getState().discardDraft(draft)
    expect(laptop.getState().rejected).toEqual([])
    // The phone sees the laptop's bench set on its next catch-up.
    await phone.getState().catchUp()
    expect(phone.getState().workout.revision).toBe(2)
  })

  it('merges a resume the same way, so a waiting entry is not sent over a set taken meanwhile', async () => {
    const { w, phone, laptop } = await twoDevices()
    w.net.down = true
    await laptop.getState().logSet('squat', 'work', 0, { load: 105, reps: 5 })
    w.net.down = false
    await phone.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    await laptop.getState().resume()    // the Programs screen, opened while the entry waited
    await laptop.getState().flush()
    expect(values(laptop)).toEqual([100])
    expect(laptop.getState().rejected).toMatchObject([{ code: 'setTaken' }])
  })

  it('does not treat its own earlier events as another device taking the set', async () => {
    const { laptop } = await twoDevices()
    await laptop.getState().logSet('squat', 'work', 0, { load: 100, reps: 5 })
    await laptop.getState().clearSet('squat', 'work', 0)
    await laptop.getState().logSet('squat', 'work', 0, { load: 102.5, reps: 5 })
    await laptop.getState().catchUp()
    expect(laptop.getState().rejected).toEqual([])
    expect(laptop.getState().workout.revision).toBe(3)
  })

  it('moves the other device to the finished state without finishing again', async () => {
    const { w, phone, laptop, recordFinished } = await twoDevices()
    await phone.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    expect(await phone.getState().finish()).toBe(true)
    await laptop.getState().catchUp()
    expect(laptop.getState().workout).toBe(null)
    expect(laptop.getState().finished.completed).toMatchObject({ day: 'A1', workoutId: phone.getState().finished.completed.workoutId })
    expect(laptop.getState().local).toMatchObject({ workoutId: null, nextDay: 'B1' })
    expect(w.sent.filter(r => r.path.endsWith('/finish'))).toHaveLength(1)
    // OpenGym history hears of it from this device too; history.js keeps one copy.
    expect(recordFinished).toHaveBeenCalledTimes(1)
    expect(recordFinished.mock.calls[0][0]).toMatchObject({ status: 'completed', completed: { day: 'A1' } })
  })

  it('takes the other device\'s finish when its own Finish loses the race', async () => {
    const { w, phone, laptop } = await twoDevices()
    await phone.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    await laptop.getState().catchUp()
    await phone.getState().logSet('bench', 'work', 1, { load: 50, reps: 10 })
    expect(await phone.getState().finish()).toBe(true)
    // The laptop still holds revision 1 and the active workout.
    expect(await laptop.getState().finish()).toBe(true)
    expect(laptop.getState().finished.completed.revision).toBe(2)
    expect(w.sent.filter(r => r.path.endsWith('/finish')).map(r => r.body.expectedRevision)).toEqual([2, 1])
  })

  it('keeps an entry that was still waiting when the other device finished, as a rejected one', async () => {
    const { w, phone, laptop } = await twoDevices()
    await phone.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    await phone.getState().finish()
    w.net.down = true
    await laptop.getState().logSet('bench', 'work', 1, { load: 50, reps: 10 })
    w.net.down = false
    await laptop.getState().catchUp()
    expect(laptop.getState().finished).not.toBe(null)
    expect(laptop.getState().rejected).toMatchObject([{ code: 'workoutFinished', event: { set: 1 } }])
  })

  it('does not reopen a workout a catch-up found finished when an older resume answers late', async () => {
    const { w, phone, laptop } = await twoDevices()
    let release
    const gate = new Promise(r => { release = r })
    const real = w.client.workout
    w.client.workout = async id => { const view = await real(id); await gate; return view }
    const late = laptop.getState().resume()
    w.client.workout = real
    await phone.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    await phone.getState().finish()
    await laptop.getState().catchUp()
    release()
    await late
    expect(laptop.getState().workout).toBe(null)
    expect(laptop.getState().finished).not.toBe(null)
  })

  it('ignores a catch-up answer older than what it already holds', async () => {
    const { w, laptop } = await twoDevices()
    // The catch-up's answer is held back until a send has moved the workout past it.
    let release
    const gate = new Promise(r => { release = r })
    const real = w.client.workout
    w.client.workout = async id => { const view = await real(id); await gate; return view }
    const late = laptop.getState().catchUp()
    w.client.workout = real
    await laptop.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    release()
    await late
    expect(laptop.getState().workout.revision).toBe(1)
  })
})

