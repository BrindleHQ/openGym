import { describe, expect, it } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import { createFakeReppen, serve } from '../../scripts/reppen-fake.mjs'

function workout() {
  const fake = createFakeReppen()
  const call = (method, path, body) => fake.handle(method, '/v1/' + path, body, 'dev')
  const entry = call('GET', 'program-catalog').body.items[0]
  call('PUT', 'enrollments/e', { artifactId: entry.artifactId, params: { squatStart: { v: 'none' } }, readings: entry.readings.map(r => ({ key: r.key, value: { n: 140 } })) })
  const view = call('PUT', 'workouts/w', { enrollmentId: 'e', enrollmentRevision: 0, day: 'A1', localDay: '2026-11-02' }).body
  return { call, view }
}

describe('Reppen development stand-in', () => {
  it.each([{ expectedRevision: -1, events: [] }, { expectedRevision: 0, events: [null] }])('refuses malformed event batches atomically: %j', body => {
    const { call } = workout()
    expect(call('POST', 'workouts/w/events', body).status).toBe(400)
    expect(call('GET', 'workouts/w').body.events).toEqual([])
  })

  it('keeps a finite planned back-off load after clearing every source set', () => {
    const { call, view } = workout()
    const work = view.plan.slots[0].steps[0]
    let reply = call('POST', 'workouts/w/events', { expectedRevision: 0, events: work.sets.map((_, i) => ({ id: 'log' + i, kind: 'setLogged', slot: 'squat', step: 'work', set: i, values: { reps: 5, load: 120 } })) })
    const q = reply.body.pendingQuestions[0]
    reply = call('POST', 'workouts/w/events', { expectedRevision: work.sets.length, events: [{ id: 'answer', kind: 'questionAnswered', question: q.id, occurrence: q.occurrence, value: { v: 'bool', b: true } }] })
    reply = call('POST', 'workouts/w/events', { expectedRevision: reply.body.revision, events: work.sets.map((_, i) => ({ id: 'clear' + i, kind: 'setCleared', slot: 'squat', step: 'work', set: i })) })
    const load = reply.body.effectivePlan.slots[0].steps.at(-1).sets[0].metrics.load.v.v
    expect(load).toBe(Math.round(work.sets[0].metrics.load.v.v * 0.9 / 2.5) * 2.5)
    expect(JSON.parse(JSON.stringify(reply)).body.effectivePlan.slots[0].steps.at(-1).sets[0].metrics.load.v.v).toBe(load)
  })

  it('keeps serving after a malformed URL or JSON body', async () => {
    const server = await serve({ port: 0 })
    const base = 'http://127.0.0.1:' + server.address().port
    try {
      for (const [path, options] of [['/v1/workouts/%zz', {}], ['/v1/enrollments/e', { method: 'PUT', body: '{' }]]) {
        expect((await fetch(base + path, { ...options, headers: { authorization: 'Bearer dev' } })).status).toBe(400)
        expect((await fetch(base + '/v1/program-catalog', { headers: { authorization: 'Bearer dev' } })).status).toBe(200)
      }
    } finally { server.closeAllConnections(); await new Promise(r => server.close(r)) }
  })

  it('refuses malformed JWT JSON without stopping the HTTP server', async () => {
    const key = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
    const jwks = http.createServer((_, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ keys: [{ ...key, kid: 'dev' }] })) })
    await new Promise(r => jwks.listen(0, '127.0.0.1', r))
    let server
    try {
      server = await serve({ port: 0, jwks: 'http://127.0.0.1:' + jwks.address().port })
      for (let i = 0; i < 2; i++) expect((await fetch('http://127.0.0.1:' + server.address().port + '/v1/program-catalog', { headers: { authorization: 'Bearer a.b.c' } })).status).toBe(401)
    } finally {
      if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)) }
      jwks.closeAllConnections(); await new Promise(r => jwks.close(r))
    }
  })
})
