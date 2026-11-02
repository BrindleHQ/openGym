import { describe, expect, it, vi } from 'vitest'
import { createReppenStore, massReading, newId, suggestNextDay } from './store.js'
import { ReppenError } from './client.js'
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
