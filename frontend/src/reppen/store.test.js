import { describe, expect, it, vi } from 'vitest'
import { createReppenStore, exerciseName, exerciseNames, massReading, newId, suggestNextDay } from './store.js'
import { ReppenError, reppenClient } from './client.js'
import { createFakeReppen } from '../../scripts/reppen-fake.mjs'
import { GZCLP, fakeClient } from './test-fixtures.js'

function memoryStorage() {
  const m = new Map()
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m }
}

function setup(client = fakeClient(), who = { id: 'u1' }) {
  const storage = memoryStorage()
  const store = createReppenStore({ client, owner: () => who.id, storage, today: () => '2026-11-01' })
  store.getState().hydrate()
  return { store, client, storage, who }
}

describe('Reppen store: programs', () => {
  it('loads every page of the catalog', async () => {
    const { store, client } = setup()
    await store.getState().loadCatalog()
    expect(store.getState().catalog.map(e => e.title)).toEqual(['GZCLP T1', 'Two'])
    expect(client.catalog.mock.calls).toEqual([[null], ['p2']])
  })

  it('enrolls with the readings in kilograms and remembers the program for this account', async () => {
    const { store, client, storage } = setup()
    expect(await store.getState().enroll(GZCLP, { 0: 140, 1: 100 })).toBe(true)
    const [id, body] = client.enroll.mock.calls[0]
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body).toEqual({
      artifactId: 'sha256:gz', startOn: '2026-11-01',
      params: { squatStart: { v: 'none', cause: { k: 'declaredNone' } } },
      readings: [massReading(GZCLP.readings[0], 140, '2026-11-01'), massReading(GZCLP.readings[1], 100, '2026-11-01')],
    })
    expect(body.readings[0]).toEqual({ fact: 'e1rm', key: 'wger:111', observedOn: '2026-11-01', value: { v: 'q', n: 140, dim: { mass: 1 }, unit: 'kg' } })
    const local = JSON.parse(storage.getItem('reppen.v1.u1'))
    expect(local.enrollment).toMatchObject({ enrollmentId: id, artifactId: 'sha256:gz', title: 'GZCLP T1', days: GZCLP.days })
    expect(local.nextDay).toBe('A1')
    expect(local.pendingEnrollment).toBe(null)
  })

  it('repeats a failed enrollment with the same id, so a lost answer cannot enroll twice', async () => {
    const enroll = vi.fn().mockRejectedValueOnce(new ReppenError(0, null)).mockImplementation(async id => ({ enrollmentId: id }))
    const { store } = setup(fakeClient({ enroll }))
    expect(await store.getState().enroll(GZCLP, { 0: 140, 1: 100 })).toBe(false)
    expect(store.getState().error.code).toBe('offline')
    expect(await store.getState().enroll(GZCLP, { 0: 140, 1: 100 })).toBe(true)
    expect(enroll.mock.calls[1][0]).toBe(enroll.mock.calls[0][0])
    expect(store.getState().local.enrollment.enrollmentId).toBe(enroll.mock.calls[0][0])
  })

  it('keeps each account to its own program', async () => {
    const { store, who } = setup()
    await store.getState().enroll(GZCLP, { 0: 1, 1: 1 })
    who.id = 'u2'
    store.getState().hydrate()
    expect(store.getState().local).toEqual({})
    who.id = 'u1'
    store.getState().hydrate()
    expect(store.getState().local.enrollment.title).toBe('GZCLP T1')
  })

  it('drops an answer that arrives after the account changed', async () => {
    let answer
    const enroll = vi.fn(() => new Promise(r => { answer = r }))
    const { store, storage, who } = setup(fakeClient({ enroll }))
    const pending = store.getState().enroll(GZCLP, { 0: 1, 1: 1 })
    who.id = 'u2'
    store.getState().hydrate()
    answer({ enrollmentId: 'e' })
    await new Promise(r => setTimeout(r, 0))
    expect(store.getState().local).toEqual({})
    expect(storage.getItem('reppen.v1.u2')).toBe(null)
    expect(JSON.parse(storage.getItem('reppen.v1.u1')).enrollment).toBeUndefined()
    expect(store.getState().busy).toBe(false)
    void pending
  })

  it('suggests the day after the last one in the program order, wrapping round', () => {
    expect(suggestNextDay(GZCLP.days, 'A1', 'A1')).toBe('B1')
    expect(suggestNextDay(GZCLP.days, 'B2', 'A1')).toBe('A1')
    expect(suggestNextDay(GZCLP.days, 'X', 'A1')).toBe('A1')
    expect(newId()).not.toBe(newId())
  })
})

describe('Reppen store: exercise names', () => {
  // The fake Reppen through the real client, so the ETag and the 304 are the wire's own.
  function wired() {
    const fake = createFakeReppen()
    const sent = []
    const fetch = vi.fn(async (url, init) => {
      const headers = Object.fromEntries(new Headers(init.headers))
      sent.push(headers['if-none-match'] ?? null)
      const answer = fake.handle(init.method, url.replace(/^\/reppen/, ''), undefined, 'u1', headers)
      return new Response(answer.status === 304 ? null : JSON.stringify(answer.body), { status: answer.status, headers: answer.headers })
    })
    return { client: reppenClient({ base: () => '/reppen/', token: async () => 't', fetch }), sent }
  }
  const page = (client, storage) => createReppenStore({ client, owner: () => 'u1', storage, today: () => '2026-11-01' })

  it('keeps the catalog names with their ETag and revalidates them on the next page load', async () => {
    const { client, sent } = wired()
    const storage = memoryStorage()
    const first = page(client, storage)
    await first.getState().loadExerciseNames()
    expect(first.getState().exerciseNames).toMatchObject({ 'wger:111': 'Barbell Back Squat', 'wger:192': 'Barbell Bench Press' })
    const etag = JSON.parse(storage.getItem('reppen.exercise-names.v1')).etag
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    const next = page(client, storage)
    const loading = next.getState().loadExerciseNames()
    expect(next.getState().exerciseNames['wger:111']).toBe('Barbell Back Squat')   // the kept copy, before any answer
    await loading
    await next.getState().loadExerciseNames()   // once per page load
    expect(sent).toEqual([null, etag])
    expect(next.getState().exerciseNames['wger:192']).toBe('Barbell Bench Press')
  })

  it('takes a changed catalog, ignores a format it does not know, and retries after a failure', async () => {
    const storage = memoryStorage()
    storage.setItem('reppen.exercise-names.v1', JSON.stringify({ etag: '"old"', names: { 'wger:111': 'Squat' } }))
    const exerciseCatalog = vi.fn()
      .mockRejectedValueOnce(new ReppenError(0, null))
      .mockResolvedValueOnce({ catalog: { format: 'reppen.exercise-catalog/1', entries: [{ id: 'wger:111', name: 'Barbell Back Squat' }], retired: [{ id: 'old', name: 'Old Lift' }] }, etag: '"new"' })
    const s = createReppenStore({ client: fakeClient({ exerciseCatalog }), owner: () => 'u1', storage, today: () => '2026-11-01' })
    await s.getState().loadExerciseNames()
    expect(s.getState().exerciseNames).toEqual({ 'wger:111': 'Squat' })
    expect(s.getState().error).toBe(null)
    await s.getState().loadExerciseNames()
    expect(exerciseCatalog.mock.calls).toEqual([['"old"'], ['"old"']])
    expect(s.getState().exerciseNames).toEqual({ old: 'Old Lift', 'wger:111': 'Barbell Back Squat' })
    expect(JSON.parse(storage.getItem('reppen.exercise-names.v1')).etag).toBe('"new"')
    expect(exerciseNames({ format: 'reppen.exercise-catalog/2', entries: [{ id: 'a', name: 'A' }] })).toBe(null)
  })

  it('shows the id when the catalog has no name for it', () => {
    expect(exerciseName({ 'wger:111': 'Barbell Back Squat' }, 'wger:111')).toBe('Barbell Back Squat')
    expect(exerciseName({ 'wger:111': 'Barbell Back Squat' }, 'wger:999')).toBe('wger:999')
    expect(exerciseName(null, 'wger:111')).toBe('wger:111')
  })
})
