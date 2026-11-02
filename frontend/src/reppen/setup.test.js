import { describe, it, expect } from 'vitest'
import entry from './dorito-fixture.json'
import { initialSetup, setupParams, LB_KG } from './setup.js'
import { createReppenStore } from './store.js'
import { fakeClient } from './test-fixtures.js'
import { ReppenError } from './client.js'

// Metadata and question definitions extracted from sealed artifact 78ab170e;
// no synthetic proof loads are carried into this fixture.
const filled = () => Object.fromEntries(entry.parameters.map(p => [p.name, p.knownValue ? p.knownValue / LB_KG : 5]))
function world() {
  const kept = new Map(), client = fakeClient()
  const storage = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }
  let day = '2026-11-02'
  const device = () => { const s = createReppenStore({ client, storage, owner: () => 'one', today: () => day }); s.getState().hydrate(); return s }
  return { client, device, midnight: () => { day = '2026-11-03' } }
}
describe('Dorito required setup', () => {
  it('never sends an enrollment if its exact retry request cannot be retained', async () => {
    const client = fakeClient()
    const kept = new Map()
    const storage = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => {
      if (k.startsWith('reppen.v1.')) throw Error('quota')
      kept.set(k, v)
    } }
    const s = createReppenStore({ client, storage, owner: () => 'one', today: () => '2026-11-02' })
    s.getState().hydrate()
    expect(await s.getState().enroll(entry, {}, filled(), true)).toBe(false)
    expect(client.enroll).not.toHaveBeenCalled()
    expect(s.getState().error.code).toBe('enrollmentStorage')
  })
  it('prefills only 18 known starting loads, leaves four starts and every increment blank', () => {
    const values = initialSetup(entry)
    expect(Object.keys(values)).toHaveLength(44)
    expect(Object.values(values).filter(v => v === null)).toHaveLength(26)
    expect(values.a_bench_starting_load).toBe(65)
    expect(values.b_press_starting_load).toBeNull()
    expect(setupParams(entry, filled()).a_bench_starting_load).toEqual({ v: 'q', n: 65 * LB_KG, dim: { mass: 1 }, unit: 'kg' })
  })
  it.each([null, 0, -1, NaN, Infinity, '5'])('refuses invalid input %s and never sends enrollment', async bad => {
    const w = world(), s = w.device(), values = filled(); values.a_bench_increment = bad
    expect(await s.getState().enroll(entry, {}, values, true)).toBe(false)
    expect(w.client.enroll).not.toHaveBeenCalled()
  })
  it('requires confirmation and refuses unsupported parameter types', async () => {
    const w = world(), s = w.device()
    expect(await s.getState().enroll(entry, {}, filled())).toBe(false)
    expect(await s.getState().enroll({ ...entry, parameters: [...entry.parameters, { name: 'unknown', type: { t: 'n' } }] }, {}, filled(), true)).toBe(false)
    expect(w.client.enroll).not.toHaveBeenCalled()
  })
  it('replays the exact request after timeout, reload, midnight and edits; blocks other artifacts', async () => {
    const w = world(); let s = w.device()
    w.client.enroll.mockRejectedValueOnce(new ReppenError(0))
    expect(await s.getState().enroll(entry, {}, filled(), true)).toBe(false)
    const original = structuredClone(w.client.enroll.mock.calls[0])
    w.midnight(); s = w.device()
    expect(await s.getState().enroll({ ...entry, artifactId: 'other' }, {}, filled(), true)).toBe(false)
    expect(await s.getState().enroll(entry, {}, {}, false)).toBe(true)
    expect(w.client.enroll.mock.calls[1]).toEqual(original)
    expect(s.getState().local.pendingEnrollment).toBeNull()
  })
})
