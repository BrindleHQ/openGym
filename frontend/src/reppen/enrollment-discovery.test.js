import { describe, it, expect, vi } from 'vitest'
import { createReppenStore } from './store.js'
import { fakeClient } from './test-fixtures.js'

const enrollment = { enrollmentId: 'server-enrollment', artifactId: 'artifact', catalogId: 'program/dorito-cut', title: 'Dorito Cut',
  days: ['A', 'B', 'C', 'D', 'E'], defaultDay: 'A', nextDay: 'A', activeWorkout: null, revision: 0 }
function world(items = [enrollment], nextCursor = null) {
  const client = fakeClient({ enrollments: vi.fn(async () => ({ items, nextCursor })) }), kept = new Map(), account = { id: 'one' }
  const storage = { getItem: k => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v) }
  const s = createReppenStore({ client, storage, owner: () => account.id, today: () => '2026-11-03' })
  s.getState().hydrate()
  return { s, client, kept, account }
}
describe('recovering an existing account enrollment on a new browser', () => {
  it('adopts the sole enrollment durably without creating another', async () => {
    const { s, client, kept } = world()
    expect(await s.getState().loadEnrollment()).toEqual(enrollment)
    expect(s.getState().local.enrollment.enrollmentId).toBe(enrollment.enrollmentId)
    expect(s.getState().local.nextDay).toBe('A')
    expect(JSON.parse(kept.get('reppen.offline.v1.one')).data.local.enrollment.enrollmentId).toBe(enrollment.enrollmentId)
    expect(client.enroll).not.toHaveBeenCalled()
  })
  it.each([[[enrollment, { ...enrollment, enrollmentId: 'other' }], null], [[enrollment], 'more']])('does not choose among multiple enrollments', async (items, nextCursor) => {
    const { s } = world(items, nextCursor)
    expect(await s.getState().loadEnrollment()).toBeNull()
    expect(s.getState().local.enrollment).toBeUndefined()
  })
  it('recovers the active workout pointer, but does not invent a next day for an advanced enrollment', async () => {
    const { s } = world([{ ...enrollment, revision: 3, nextDay: null, activeWorkout: { workoutId: 'active', day: 'C' } }])
    await s.getState().loadEnrollment()
    expect(s.getState().local).toMatchObject({ workoutId: 'active', nextDay: 'C' })
    const other = world([{ ...enrollment, revision: 3, nextDay: null }]).s
    await other.getState().loadEnrollment()
    expect(other.getState().local.nextDay).toBeNull()
  })
  it.each([{ pendingEnrollment: { enrollmentId: 'pending' } }, { pendingStart: {} }, { workoutId: 'local' }])('does not overwrite pending local work', async local => {
    const { s, client } = world()
    s.setState({ local })
    await s.getState().loadEnrollment()
    expect(client.enrollments).not.toHaveBeenCalled()
    expect(s.getState().local).toEqual(local)
  })
  it('ignores discovery if an enrollment request started while the response was in flight', async () => {
    const { s, client } = world(); let resolve
    client.enrollments.mockImplementation(() => new Promise(r => { resolve = r }))
    const loading = s.getState().loadEnrollment()
    s.setState({ local: { pendingEnrollment: { enrollmentId: 'pending' } } })
    resolve({ items: [enrollment], nextCursor: null }); await loading
    expect(s.getState().local.pendingEnrollment.enrollmentId).toBe('pending')
    expect(s.getState().local.enrollment).toBeUndefined()
  })
  it('ignores an old account response after switching accounts', async () => {
    const { s, client, account } = world(); let resolve
    client.enrollments.mockImplementation(() => new Promise(r => { resolve = r }))
    void s.getState().loadEnrollment()
    account.id = 'two'; s.getState().hydrate()
    resolve({ items: [enrollment], nextCursor: null })
    await new Promise(r => setTimeout(r, 0))
    expect(s.getState().local.enrollment).toBeUndefined()
  })
})
