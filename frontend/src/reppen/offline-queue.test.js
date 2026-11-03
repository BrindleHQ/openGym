import { describe, expect, it, vi } from 'vitest'
import { createReppenStore } from './store.js'
import { ReppenError } from './client.js'
import { evaluateLiveTarget } from './offline-finish.js'
import { readFileSync } from 'node:fs'

const copy = x => structuredClone(x)
const q = n => ({ v: 'q', n, dim: { mass: 1 }, unit: 'kg' })
const plan = i => ({ day: ['A', 'B', 'C', 'D'][i], defaultDay: ['B', 'C', 'D', 'A'][i], slots: [{ slot: 's', exercise: { id: 'squat' }, steps: [{ key: 'work', sets: [{ metrics: { load: { k: 'fixed', v: { b: 'exact', v: 100 + 5 * i } }, reps: { k: 'fixed', v: { b: 'exact', v: 5 } } } }] }] }] })
const pack = () => ({ format: 'reppen.residual/1', nodes: [0, 1, 2, 3].map(i => ({ plan: plan(i), targets: [], occurrences: [],
  finish: { k: 'residual', refuseIf: { op: 'eq', a: { op: 'agg', fn: 'count', sets: { slot: 's', step: 'work' } }, b: { op: 'num', v: 0 } }, slots: [{ slot: 's', state: { load: q(100 + 5 * i) }, branches: [{ k: 'patch', when: { op: 'bool', v: true }, set: { load: { mode: 'commit', value: q(105 + 5 * i) } } }] }] },
  next: i < 3 ? { k: 'workouts', outcomes: [{ slots: [0], node: i + 1 }] } : { k: 'needsConnection', reason: 'depth limit' },
})) })

function world() {
  const kept = new Map(), net = { down: false, drop: null }, records = new Map(), deliveries = []
  let revision = 0, account = 'one'
  const storage = { fail: false, getItem: k => kept.get(k) ?? null, setItem(k, v) { if (this.fail) throw Error('quota'); kept.set(k, v) } }
  const error = (code, body = {}) => new ReppenError(409, { error: code, ...body })
  const run = (kind, fn) => vi.fn(async (...args) => {
    if (net.down) throw new ReppenError(0)
    const result = fn(...args)
    if (net.drop === kind) { net.drop = null; throw new ReppenError(0) }
    return copy(result)
  })
  const client = {
    enrollment: run('enrollment', () => ({ revision })),
    startWorkout: run('start', (id, body) => {
      if (records.has(id)) return records.get(id)
      if (body.enrollmentRevision !== revision) throw error('enrollmentConflict')
      const view = { workoutId: id, enrollmentId: 'e', artifactId: 'a', revision: 0, events: [], status: 'active', active: true, day: body.day, localDay: body.localDay, plan: plan(revision), effectivePlan: plan(revision), pendingQuestions: [] }
      records.set(id, view); return view
    }),
    workout: run('workout', id => { if (!records.has(id)) throw error('workoutNotFound'); return records.get(id) }),
    appendEvents: run('events', (id, expected, events) => {
      const view = records.get(id)
      if (view.revision !== expected) throw error('revisionConflict')
      view.events.push(...copy(events)); view.revision += events.length
      return view
    }),
    offlinePack: run('pack', id => { const view = records.get(id); return { workoutId: id, enrollmentId: 'e', artifactId: 'a', workoutRevision: view.revision, enrollmentRevision: revision, localDay: view.localDay, pack: pack() } }),
    finish: run('finish', (id, expected, state) => {
      const view = records.get(id)
      if (view.status === 'completed') return { workout: view, completed: view.completed }
      if (view.revision !== expected) throw error('revisionConflict')
      if (!view.events.length) throw new ReppenError(422, { error: 'refused', code: 'emptySession' })
      if (state && JSON.stringify(state) !== JSON.stringify({ s: { load: q(105 + 5 * revision) } })) throw error('offlineMismatch')
      revision++; view.status = 'completed'; view.completed = { day: view.day, enrollmentRevision: revision }
      return { workout: view, completed: view.completed }
    }),
  }
  const device = () => {
    const store = createReppenStore({ client, owner: () => account, storage, today: () => '2026-11-02', recordFinished: r => { if (!deliveries.some(x => x.workout.workoutId === r.workout.workoutId)) deliveries.push(r) } })
    store.getState().hydrate()
    if (!store.getState().local.enrollment) store.setState({ local: { enrollment: { enrollmentId: 'e', artifactId: 'a', title: 'Test', days: ['A', 'B', 'C', 'D'] } } })
    return store
  }
  return { device, storage, kept, net, client, records, deliveries, owner: v => { account = v } }
}

describe('durable offline workout chain', () => {
  it('retains and replays logs when coaching refuses an offline pack and finish', async () => {
    const w = world(); let s = w.device()
    w.client.offlinePack.mockRejectedValue(new ReppenError(409, { error: 'needsConnection' }))
    await s.getState().start('A')
    await expect(s.getState().loadOfflinePack()).rejects.toMatchObject({ code: 'needsConnection' })
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    expect(await s.getState().finish()).toBe(false)
    expect(s.getState().error.code).toBe('needsConnection')
    expect(s.getState().outbox).toHaveLength(1)
    expect(s.getState().offlineJournal).toHaveLength(0)
    s = w.device(); expect(s.getState().outbox).toHaveLength(1)
    w.net.down = false
    expect(await s.getState().flush()).toBe(true)
    expect(w.records.values().next().value.events).toHaveLength(1)
  })
  it.each([false, true])('queues a connection-only question for the server, offline=%s', async offline => {
    const w = world(); let s = w.device()
    const original = w.client.offlinePack.getMockImplementation()
    const question = { key: 'q', question: 'q', occurrence: 'occ', trigger: { op: 'bool', v: true }, choices: [
      { value: { v: 'bool', b: true }, patch: { k: 'needsConnection', reason: 'server rule' } },
    ] }
    w.client.offlinePack.mockImplementation(async id => {
      const envelope = await original(id); envelope.pack.nodes[0].occurrences = [question]; return envelope
    })
    await s.getState().start('A'); await s.getState().loadOfflinePack()
    w.net.down = offline
    await s.getState().answer(question, question.choices[0])
    if (offline) {
      expect(s.getState().outbox).toHaveLength(1)
      expect(s.getState().previewOfflineFinish().finish.k).toBe('needsConnection')
      expect(w.records.values().next().value.events).toHaveLength(0)
      s = w.device(); w.net.down = false
      expect(await s.getState().flush()).toBe(true)
    }
    expect(w.records.values().next().value.events).toMatchObject([{ kind: 'questionAnswered', question: 'q', occurrence: 'occ' }])
    expect(s.getState().outbox).toEqual([])
    expect(s.getState().error).toBe(null)
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    if (offline) {
      w.net.down = true
      expect(await s.getState().finish()).toBe(false)
      expect(s.getState().error.code).toBe('needsConnection')
      expect(s.getState().offlineJournal).toEqual([])
      w.net.down = false
    }
    w.client.finish.mockClear()
    expect(await s.getState().finish()).toBe(true)
    expect(w.client.finish).toHaveBeenCalledTimes(1)
    expect(w.records.values().next().value.status).toBe('completed')
  })
  it('shares overlapping reconciliation and retains the original recovery entries after reload', async () => {
    const w = world(), s = w.device()
    await s.getState().start('A'); await s.getState().loadOfflinePack()
    const id = s.getState().workout.workoutId
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 }); await s.getState().finish()
    w.records.get(id).events.push({ id: 'other', kind: 'setLogged', slot: 's', step: 'work', set: 0, values: { load: 115 } })
    w.records.get(id).revision++; w.net.down = false
    await s.getState().flush()
    const replies = []
    w.client.workout.mockImplementation(() => new Promise(resolve => replies.push(resolve)))
    const first = s.getState().reconcileOffline(), second = s.getState().reconcileOffline()
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
    replies[0](copy(w.records.get(id))); await first
    if (replies[1]) replies[1](copy(w.records.get(id)))
    await second
    expect(replies).toHaveLength(1)
    const recovered = w.device().getState().offlineRecovery
    expect(recovered).toHaveLength(1)
    expect(recovered[0].offlineJournal[0].events[0].values.load).toBe(100)
  })
  it('shares preparation and keeps rules valid when logs arrive during preparation', async () => {
    const w = world(), s = w.device()
    await s.getState().start('A')
    const view = s.getState().workout
    let resolve
    w.client.offlinePack.mockImplementation(() => new Promise(done => { resolve = done }))
    const first = s.getState().loadOfflinePack(), second = s.getState().loadOfflinePack()
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    resolve({ workoutId: view.workoutId, artifactId: 'a', enrollmentId: 'e', workoutRevision: 0, enrollmentRevision: 0, pack: pack() })
    await Promise.all([first, second])
    expect(w.client.offlinePack).toHaveBeenCalledTimes(1)
    expect(s.getState().offlinePack.workoutRevision).toBe(0)
    expect(s.getState().previewOfflineFinish().finish.k).toBe('finished')
  })
  it('clears the provisional start after a closed chain before starting online again', async () => {
    const w = world(), s = w.device()
    await s.getState().start('A'); await s.getState().loadOfflinePack(); w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 }); await s.getState().finish()
    await s.getState().start('B'); await s.getState().logSet('s', 'work', 0, { load: 105, reps: 5 })
    await s.getState().finish()
    expect(s.getState().offlineStart).toBe(null)
    w.net.down = false; expect(await s.getState().flush()).toBe(true)
    expect(await s.getState().start('C')).toBe(true)
    expect(s.getState().offlineStart).toBe(null)
    expect(s.getState().offlinePack).toBe(null)
    expect(s.getState().workout.plan.day).toBe('C')
  })
  it('retains the calculated target used by an event across reload and sends it for verification', async () => {
    const w = world(); let s = w.device()
    const original = w.client.offlinePack.getMockImplementation()
    w.client.offlinePack.mockImplementation(async id => {
      const envelope = await original(id)
      envelope.pack.nodes[0].targets = [{ slot: 's', step: 'work', set: 0, metric: 'load', rule: {
        k: 'residual', ready: [], field: { bound: { b: 'exact', v: { op: 'num', v: 95 } }, grid: 2.5, ties: 'up' },
      } }]
      return envelope
    })
    await s.getState().start('A'); await s.getState().loadOfflinePack()
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 95, reps: 5 })
    const claim = { eventId: s.getState().outbox[0].id, metric: 'load', value: { k: 'fixed', v: { b: 'exact', v: 95 } } }
    expect(s.getState().offlineComputed).toEqual([claim])
    s = w.device(); w.net.down = false
    expect(await s.getState().flush()).toBe(true)
    expect(w.client.appendEvents.mock.calls.at(-1)[3]).toEqual([claim])
  })
  it('records one local finish when Finish is pressed twice', async () => {
    const w = world(), s = w.device()
    await s.getState().start('A'); await s.getState().loadOfflinePack()
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    expect(await Promise.all([s.getState().finish(), s.getState().finish()])).toEqual([true, true])
    expect(s.getState().offlineJournal).toHaveLength(1)
  })
  it('survives reload through two finishes and the next workout, then verifies and delivers history once', async () => {
    const w = world(); let s = w.device()
    expect(await s.getState().start('A')).toBe(true)
    await s.getState().loadOfflinePack()
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    expect(await s.getState().finish()).toBe(true)
    expect(w.deliveries).toHaveLength(0)
    expect(await s.getState().start('B')).toBe(true)
    expect(s.getState().workout.plan.slots[0].steps[0].sets[0].metrics.load.v.v).toBe(105)
    s = w.device()
    expect(s.getState().workout.day).toBe('B')
    await s.getState().logSet('s', 'work', 0, { load: 105, reps: 5 })
    expect(await s.getState().finish()).toBe(true)
    expect(s.getState().offlineJournal).toHaveLength(2)
    s = w.device()
    expect(await s.getState().start('C')).toBe(true)
    await s.getState().logSet('s', 'work', 0, { load: 110, reps: 5 })
    const ids = s.getState().outbox.map(e => e.id)
    w.net.down = false
    expect(await s.getState().flush()).toBe(true)
    expect(s.getState().offlineJournal).toEqual([])
    expect(w.deliveries).toHaveLength(2)
    expect(s.getState().workout.events.map(e => e.id)).toEqual(ids)
    expect(await s.getState().finish()).toBe(true)
    expect(w.deliveries).toHaveLength(3)
    await s.getState().flush()
    expect(w.deliveries).toHaveLength(3)
  })
  it.each(['events', 'finish', 'start'])('repeats stable commands after a lost %s response and reload', async lost => {
    const w = world(); let s = w.device()
    await s.getState().start('A'); await s.getState().loadOfflinePack()
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    await s.getState().finish(); await s.getState().start('B')
    w.net.down = false; w.net.drop = lost
    await s.getState().flush()
    s = w.device()
    expect(await s.getState().flush()).toBe(true)
    expect(w.records.size).toBe(2)
    expect(w.deliveries).toHaveLength(1)
    expect(w.records.values().next().value.events).toHaveLength(1)
  })
  it('does not acknowledge edits when durable storage fails', async () => {
    const w = world(), s = w.device(); await s.getState().start('A')
    w.storage.fail = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    expect(s.getState().outbox).toEqual([])
    expect(s.getState().error.code).toBe('offlineStorage')
    expect(w.client.appendEvents).not.toHaveBeenCalled()
    const draft = { code: 'setTaken', event: { id: 'draft', kind: 'setLogged', slot: 's', step: 'work', set: 0, values: { load: 105, reps: 5 } } }
    s.setState({ rejected: [draft] })
    await s.getState().relogDraft(draft)
    expect(s.getState().rejected).toEqual([draft])
    expect(s.getState().outbox).toEqual([])
    s.getState().discardDraft(draft)
    expect(s.getState().rejected).toEqual([draft])
    expect(w.client.appendEvents).not.toHaveBeenCalled()
  })
  it('keeps conflicting offline work without overwriting another device or publishing unverified history', async () => {
    const w = world(), s = w.device(); await s.getState().start('A'); await s.getState().loadOfflinePack()
    const id = s.getState().workout.workoutId
    w.net.down = true
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 }); await s.getState().finish()
    w.records.get(id).events.push({ id: 'other', kind: 'setLogged', slot: 's', step: 'work', set: 0, values: { load: 115 } }); w.records.get(id).revision++
    w.net.down = false
    expect(await s.getState().flush()).toBe(false)
    expect(s.getState().offlineJournal).toHaveLength(1)
    expect(s.getState().error.code).toBe('offlineConflict')
    expect(w.deliveries).toHaveLength(0)
    expect(w.records.get(id).events).toHaveLength(1)
    expect(await s.getState().reconcileOffline()).toBe(true)
    expect(s.getState().offlineJournal).toEqual([])
    expect(s.getState().workout.events[0].id).toBe('other')
    expect(s.getState().offlineRecovery[0].offlineJournal[0].events[0].values.load).toBe(100)
    expect(s.getState().offlineBlocked).toBe(null)
    const recovered = w.device()
    expect(recovered.getState().offlineRecoveryData().recovered).toHaveLength(1)
  })
  it('keeps saved work separate when the account changes', async () => {
    const w = world(), s = w.device(); await s.getState().start('A'); await s.getState().loadOfflinePack()
    w.net.down = true; await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 }); await s.getState().finish()
    w.owner('two'); s.getState().hydrate()
    expect(s.getState().offlineJournal).toEqual([])
    expect(s.getState().workout).toBe(null)
    w.owner('one'); s.getState().hydrate()
    expect(s.getState().offlineJournal).toHaveLength(1)
  })
  it('can finish after changing accounts while an older Finish is in flight', async () => {
    const w = world(), s = w.device()
    const enrollment = copy(s.getState().local.enrollment)
    await s.getState().start('A')
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    const oldWorkout = copy(s.getState().workout)
    let resolveOld
    w.client.finish.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
    const oldFinish = s.getState().finish()
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'))

    w.owner('two'); s.getState().hydrate()
    s.setState({ local: { enrollment } })
    await s.getState().start('A')
    await s.getState().logSet('s', 'work', 0, { load: 100, reps: 5 })
    const newId = s.getState().workout.workoutId
    const newFinish = s.getState().finish()
    expect(newFinish).not.toBe(oldFinish)
    resolveOld({ workout: { ...oldWorkout, status: 'completed' }, completed: { enrollmentRevision: 1 } })
    expect(await newFinish).toBe(true)
    expect(w.deliveries).toHaveLength(1)
    expect(w.deliveries[0].workout.workoutId).toBe(newId)
    expect(s.getState().localOwner).toBe('two')
    w.owner('one'); s.getState().hydrate()
    const resumedFinish = s.getState().finish()
    expect(resumedFinish).not.toBe(oldFinish)
    expect(await resumedFinish).toBe(true)
    expect(w.deliveries).toHaveLength(2)
    expect(w.deliveries[1].workout.workoutId).toBe(oldWorkout.workoutId)
  })
})

it('matches every authoritative C1 live-target vector', () => {
  const doc = JSON.parse(readFileSync(process.env.C1_VECTOR_PATH || new URL('./fixtures/live-targets.json', import.meta.url), 'utf8'))
  for (const c of doc.cases) for (const state of c.states) {
    const events = []
    for (const [slot, steps] of Object.entries(state.logged)) for (const [step, sets] of Object.entries(steps)) for (const [set, values] of Object.entries(sets)) events.push({ kind: 'setLogged', slot, step, set: Number(set), values })
    expect(c.residual.targets.map(t => evaluateLiveTarget(t, events)), c.name).toEqual(state.expected)
  }
})
