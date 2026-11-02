// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { reppenClient, ReppenError, refusalOf, isRevisionConflict, isOffline } from './client.js'
import { reppenAvailable } from './connection.js'

const json = (status, body) => new Response(body === undefined ? 'not json' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(answers) {
  const calls = []
  const fetch = vi.fn(async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : undefined, credentials: init.credentials })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  })
  let n = 0
  const token = vi.fn(async ({ fresh } = {}) => (fresh ? 'fresh' : 'tok') + ++n)
  return { client: reppenClient({ base: () => '/gym/reppen/', token, fetch }), calls, token }
}

describe('Reppen client', () => {
  it('sends a Bearer and no cookies, on the same origin under /reppen/v1', async () => {
    const { client, calls } = setup([json(200, { workoutId: 'w 1', revision: 0 })])
    expect(await client.workout('w 1')).toEqual({ workoutId: 'w 1', revision: 0 })
    expect(calls[0]).toMatchObject({ url: '/gym/reppen/v1/workouts/w%201', method: 'GET', auth: 'Bearer tok1', credentials: 'omit' })
  })

  it('writes the bodies the API takes', async () => {
    const { client, calls } = setup([json(201, {}), json(200, {}), json(200, {}), json(200, {}), json(201, {})])
    await client.startWorkout('w1', { enrollmentId: 'e1', enrollmentRevision: 0, localDay: '2026-11-01', day: 'A1' })
    await client.appendEvents('w1', 3, [{ id: 'ev1', kind: 'setLogged', slot: 'squat', step: 'work', set: 0, values: { reps: 3, load: 100 } }])
    await client.finish('w1', 4)
    await client.activate('w2', 'w1')
    await client.enroll('e1', { artifactId: 'sha256:a', startOn: '2026-11-01', readings: [] })
    expect(calls.map(c => [c.method, c.url, c.body])).toEqual([
      ['PUT', '/gym/reppen/v1/workouts/w1', { enrollmentId: 'e1', enrollmentRevision: 0, localDay: '2026-11-01', day: 'A1' }],
      ['POST', '/gym/reppen/v1/workouts/w1/events', { expectedRevision: 3, events: [{ id: 'ev1', kind: 'setLogged', slot: 'squat', step: 'work', set: 0, values: { reps: 3, load: 100 } }] }],
      ['POST', '/gym/reppen/v1/workouts/w1/finish', { expectedRevision: 4 }],
      ['POST', '/gym/reppen/v1/workouts/w2/activate', { replaces: 'w1' }],
      ['PUT', '/gym/reppen/v1/enrollments/e1', { artifactId: 'sha256:a', startOn: '2026-11-01', readings: [] }],
    ])
  })

  it('pages the catalog and the history with their cursors', async () => {
    const { client, calls } = setup([json(200, { items: [] }), json(200, { items: [] })])
    await client.catalog('c/1')
    await client.history()
    expect(calls.map(c => c.url)).toEqual(['/gym/reppen/v1/program-catalog?limit=100&cursor=c%2F1', '/gym/reppen/v1/history?limit=50'])
  })

  it('replaces a refused token once, and takes a second refusal as the answer', async () => {
    const { client, calls } = setup([json(401, { error: 'unauthenticated' }), json(200, { ok: 1 }), json(401, { error: 'unauthenticated' }), json(401, { error: 'unauthenticated' })])
    expect(await client.history()).toEqual({ ok: 1 })
    expect(calls.map(c => c.auth)).toEqual(['Bearer tok1', 'Bearer fresh2'])
    await expect(client.history()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' })
    expect(calls).toHaveLength(4)
  })

  it('names the API error codes, with their details', async () => {
    const { client } = setup([
      json(409, { error: 'revisionConflict', currentRevision: 5, missing: [] }),
      json(422, { error: 'refused', code: 'questionsPending' }),
      json(500, undefined),
      new TypeError('Failed to fetch'),
      json(200, undefined),
    ])
    const conflict = await client.appendEvents('w1', 2, []).catch(e => e)
    expect(isRevisionConflict(conflict)).toBe(true)
    expect(conflict.body.currentRevision).toBe(5)
    const refused = await client.finish('w1', 5).catch(e => e)
    expect(refusalOf(refused)).toBe('questionsPending')
    expect(isRevisionConflict(refused)).toBe(false)
    expect(await client.history().catch(e => e)).toMatchObject({ status: 500, code: 'http500' })
    const offline = await client.history().catch(e => e)
    expect(isOffline(offline)).toBe(true)
    expect(offline.code).toBe('offline')
    // A 2xx that is not JSON is someone else's page (a proxy's login), not Reppen's answer.
    expect(await client.history().catch(e => e)).toBeInstanceOf(ReppenError)
  })
})

describe('where the Reppen screens show', () => {
  const user = { id: 'u1' }
  it('only for a signed-in browser on an instance with Reppen on', () => {
    expect(reppenAvailable({ reppen: true }, user, { mobile: false, demo: false })).toBe(true)
    expect(reppenAvailable({}, user, { mobile: false, demo: false })).toBe(false)
    expect(reppenAvailable({ reppen: true }, null, { mobile: false, demo: false })).toBe(false)
    expect(reppenAvailable({ reppen: true }, user, { mobile: true, demo: false })).toBe(false)
    expect(reppenAvailable({ reppen: true }, user, { mobile: false, demo: true })).toBe(false)
  })
})
