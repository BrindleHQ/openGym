import { describe, it, expect, vi } from 'vitest'
import entry from './dorito-fixture.json'
import { initialSetup, setupParams, validSetup, LB_KG } from './setup.js'
import { createReppenStore } from './store.js'
import { fakeClient } from './test-fixtures.js'
import { ReppenError } from './client.js'
import { loggedSets } from './plan.js'

export const guided = { ...entry, artifactId: 'sha256:guided', parameters: entry.parameters.map(p => ({ ...p, required: false, deferred: true, type: { t: 'opt', of: p.type } })) }
const none = { v: 'none', cause: { k: 'declaredNone' } }

function world() {
  const kept = new Map(), client = fakeClient(), account = { id: 'one' }
  const storage = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }
  const device = () => {
    const s = createReppenStore({ client, storage, owner: () => account.id, today: () => '2026-11-03' })
    s.getState().hydrate(); return s
  }
  return { kept, client, account, device }
}

describe('guided enrollment', () => {
  it('enrolls with every load explicitly unknown; historical program targets are not novice defaults', async () => {
    const w = world(), s = w.device()
    const values = initialSetup(guided)
    expect(Object.values(values)).toEqual(Array(44).fill(null))
    expect(validSetup(guided, values, false)).toBe(true)
    expect(await s.getState().enroll(guided)).toBe(true)
    expect(Object.values(w.client.enroll.mock.calls[0][1].params)).toEqual(Array(44).fill(none))
  })
  it('requires explicit confirmation of optional known weights and leaves missing values unknown', () => {
    const known = { a_bench_starting_load: 65 }
    expect(known.a_bench_starting_load).toBe(65)
    expect(validSetup(guided, known, false)).toBe(false)
    expect(validSetup(guided, known, true)).toBe(true)
    expect(setupParams(guided, known).a_bench_starting_load.n).toBe(65 * LB_KG)
    expect(setupParams(guided, known).b_press_starting_load).toEqual(none)
    expect(setupParams(guided, known).a_bench_increment).toEqual(none)
  })
  it.each([0, -1, Infinity, NaN, '5'])('does not treat invalid optional input %s as unknown', bad => {
    expect(validSetup(guided, { a_bench_starting_load: bad }, true)).toBe(false)
  })
  it('retries the exact unknown enrollment after reload, even when later inputs differ', async () => {
    const w = world(); let s = w.device()
    w.client.enroll.mockRejectedValueOnce(new ReppenError(0))
    expect(await s.getState().enroll(guided)).toBe(false)
    const original = structuredClone(w.client.enroll.mock.calls[0])
    s.getState()._disposeOffline(); s = w.device()
    expect(await s.getState().enroll(guided, {}, { a_bench_starting_load: 65 }, true)).toBe(true)
    expect(w.client.enroll.mock.calls[1]).toEqual(original)
  })
})

describe('guided events use the durable workout queue', () => {
  it.each([
    ['logLoadTrial', ['b_press', 20, 10, 'manageable'], { kind: 'loadTrial', slot: 'b_press', loadKg: 20, reps: 10, feedback: 'manageable' }],
    ['confirmStartingLoad', ['b_press', 20, 'trial'], { kind: 'startingLoadConfirmed', slot: 'b_press', loadKg: 20, source: 'trial' }],
    ['confirmEquipment', ['b_press', 25], { kind: 'equipmentConfirmed', slot: 'b_press', nextLoadKg: 25 }],
    ['confirmEquipment', ['b_press', 25, 5], { kind: 'equipmentConfirmed', slot: 'b_press', nextLoadKg: 25, incrementKg: 5 }],
  ])('%s survives offline reload, replays the exact ID and never becomes a working set', async (method, args, event) => {
    const w = world(); let s = w.device()
    const view = { workoutId: 'w', enrollmentId: 'e', artifactId: guided.artifactId, revision: 0, status: 'active', events: [], plan: { slots: [] } }
    s.setState({ workout: view, local: { workoutId: 'w' } })
    w.client.appendEvents = vi.fn().mockRejectedValueOnce(new ReppenError(0))
      .mockImplementation(async (_id, _revision, events) => ({ ...view, revision: 1, events }))
    await s.getState()[method](...args)
    const queued = structuredClone(s.getState().outbox)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject(event)
    expect(loggedSets(s.getState().workout, queued).size).toBe(0)
    s.getState()._disposeOffline(); s = w.device()
    expect(s.getState().outbox).toEqual(queued)
    await s.getState().flush()
    expect(w.client.appendEvents.mock.calls[1][2]).toEqual(queued)
    expect(s.getState().outbox).toEqual([])
    expect(loggedSets(s.getState().workout).size).toBe(0)
  })
  it('keeps queued practice in its original account across account changes', async () => {
    const w = world(), s = w.device()
    const view = { workoutId: 'w', enrollmentId: 'e', artifactId: guided.artifactId, revision: 0, status: 'active', events: [], plan: { slots: [] } }
    s.setState({ workout: view, local: { workoutId: 'w' } })
    w.client.appendEvents = vi.fn().mockRejectedValue(new ReppenError(0))
    await s.getState().logLoadTrial('b_press', 20, 10, 'manageable')
    const queued = structuredClone(s.getState().outbox)
    w.account.id = 'two'; s.getState().hydrate()
    expect(s.getState().outbox).toEqual([])
    expect(s.getState().workout).toBeNull()
    w.account.id = 'one'; s.getState().hydrate()
    expect(s.getState().outbox).toEqual(queued)
  })
})
