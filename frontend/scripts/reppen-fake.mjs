#!/usr/bin/env node
/* A stand-in for the Reppen workout API, for the app's tests and for clicking through the Reppen
 * screens without the real service. It speaks the same wire contract (reppen-core
 * backend/README.md: /v1/program-catalog, enrollments, workouts, events, finish, activate,
 * history) for one small two-day program, with no Reppen engine behind it: targets come from a
 * fixed formula, and one question ("Add a back-off set?") appears once the squat's work sets are
 * logged, whose "yes" adds a set at 90% of the heaviest logged squat.
 *
 *   createFakeReppen()  in-process: { handle(method, path, body, sub) -> { status, body } }
 *   node scripts/reppen-fake.mjs --port 8080 [--jwks http://127.0.0.1:3000/api/reppen/jwks]
 *     serves it over HTTP. With --jwks every request needs a Bearer token that verifies against
 *     that key set (EdDSA, exp/nbf), the way the real service checks OpenGym's tokens; the
 *     token's `sub` is the account. Without it any Bearer is accepted as account "dev".
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

const ARTIFACT = 'sha256:fake-gzclp'
const LIFTS = [['squat', 'wger:111', 'Barbell Back Squat'], ['bench', 'wger:192', 'Barbell Bench Press']]
const CATALOG = [{
  catalogId: 'fake-gzclp', revision: 1, artifactId: ARTIFACT, title: 'GZCLP (test program)',
  source: { kind: 'curated', reference: 'frontend/scripts/reppen-fake.mjs' },
  execution: { contract: 'reppen.training/1', runtime: 'sha256:fake' },
  admission: { status: 'supported', capabilities: ['session'] },
  // Optional, but like the real GZCLP the program refuses an enrollment that leaves it out.
  parameters: [{ name: 'squatStart', required: false, type: { t: 'opt', of: { t: 'q', dim: { mass: 1 } } } }],
  readings: LIFTS.map(([, key]) => ({ fact: 'e1rm', key, required: true, type: { t: 'q', dim: { mass: 1 } } })),
  days: ['A1', 'B1'], defaultDay: 'A1', artifactPath: '/v1/program-artifacts/' + ARTIFACT,
}]

const round = (n, grid = 2.5) => Math.round(n / grid) * grid
const fixed = (v, b = 'exact') => ({ k: 'fixed', v: { b, v } })
const set = (role, reps, load, b) => ({ role, metrics: { reps: fixed(reps, b), load: fixed(load) }, restSec: 120, tempo: null, cluster: null })
const err = (status, error, extra = {}) => ({ status, body: { error, ...extra } })
const pos = e => `${e.slot}|${e.step}|${e.set}`
const QUESTION = 'backoff'
const OCCURRENCE = JSON.stringify([QUESTION, 'squat', 'work', 0])

function basePlan(enrollment, day) {
  // A1 trains the squat heavy, B1 the bench; both lifts appear every day.
  const slots = LIFTS.map(([slot, id, label]) => {
    const load = enrollment.state[slot].load
    const heavy = (day === 'A1') === (slot === 'squat')
    return {
      slot, exercise: { id, label, logging: 'weight_reps' }, intensifier: null,
      steps: [
        { id: 'work', key: 'work', count: { k: 'n', n: heavy ? 3 : 2 }, sets: Array.from({ length: heavy ? 3 : 2 }, () => set('working', heavy ? 5 : 10, heavy ? load : round(load * 0.65))), block: null, live: null },
        { id: 'last', key: 'last', count: { k: 'n', n: 1 }, sets: [set('amrap', heavy ? 5 : 10, heavy ? load : round(load * 0.65), 'atLeast')], block: null, live: null },
      ],
    }
  })
  return { issueKey: `fake:${enrollment.revision}:${day}`, day, defaultDay: day, slots, due: { k: 'due' }, stamp: { grids: { load: 2.5 }, display: { load: 'kg' } } }
}

// The latest log or clear per set position, in event order.
function logged(events) {
  const at = new Map()
  for (const e of events) if (e.kind === 'setLogged') at.set(pos(e), e); else if (e.kind === 'setCleared') at.delete(pos(e))
  return at
}

function derive(w) {
  const answer = w.events.find(e => e.kind === 'questionAnswered' && e.question === QUESTION)
  const plan = structuredClone(w.plan)
  const at = logged(w.events)
  const squat = plan.slots.find(s => s.slot === 'squat')
  const workSets = squat.steps[0].sets.length
  const workDone = Array.from({ length: workSets }, (_, i) => at.get(`squat|work|${i}`)).filter(Boolean)
  if (answer?.value?.b === true) {
    const top = Math.max(...workDone.map(e => e.values.load || 0))
    squat.steps.push({ id: 'backoff', key: 'backoff', count: { k: 'n', n: 1 }, sets: [set('backoff', 8, round(top * 0.9), 'atLeast')], block: null, live: { from: 'squat.work', factor: 0.9 } })
  }
  const pending = !answer && workDone.length === workSets
    ? [{ id: QUESTION, occurrence: OCCURRENCE, text: 'Add a back-off set?', choices: [{ label: 'Yes', value: { v: 'bool', b: true } }, { label: 'No', value: { v: 'bool', b: false } }] }]
    : []
  return { effectivePlan: plan, pendingQuestions: pending }
}

export function createFakeReppen({ now = () => new Date() } = {}) {
  const accounts = new Map()
  const of = sub => {
    if (!accounts.has(sub)) accounts.set(sub, { enrollments: new Map(), workouts: new Map(), active: null })
    return accounts.get(sub)
  }
  const summary = w => ({ workoutId: w.workoutId, enrollmentId: w.enrollmentId, revision: w.events.length, eventCount: w.events.length, localDay: w.localDay, day: w.day, status: w.status })
  const view = (a, w) => ({
    ...summary(w), artifactId: ARTIFACT, execution: CATALOG[0].execution, active: a.active === w.workoutId,
    document: '{}', plan: w.plan, ...derive(w), events: w.events,
    // A held workout names the one that is active, as the real view does.
    ...(a.active && a.active !== w.workoutId && w.status === 'active' ? { activeWorkout: summary(a.workouts.get(a.active)) } : {}),
    ...(w.completed ? { completed: w.completed, statistics: { status: 'processed' } } : {}),
  })

  function findSlotSet(w, e) {
    const plan = derive({ ...w, events: w.events }).effectivePlan
    const step = plan.slots.find(s => s.slot === e.slot)?.steps.find(s => s.key === e.step)
    return step && Number.isInteger(e.set) && e.set >= 0 && e.set < step.sets.length
  }

  function events(a, w, body) {
    if (w.status === 'completed') return err(409, 'workoutFinished', { revision: w.events.length })
    const { expectedRevision: rev, events: batch } = body
    if (!Number.isInteger(rev) || !Array.isArray(batch)) return err(400, 'invalidRequest', { reason: 'expectedRevision and events are required' })
    // Replays of events already held at the same positions are no-ops; the rest must start at the head.
    let i = 0
    for (; i < batch.length && rev + i < w.events.length; i++) {
      const held = w.events[rev + i]
      if (held.id !== batch[i].id) return err(409, 'revisionConflict', { currentRevision: w.events.length, missing: w.events.slice(rev) })
      if (JSON.stringify(held) !== JSON.stringify(batch[i])) return err(409, 'eventConflict', { eventId: batch[i].id })
    }
    if (rev > w.events.length) return err(409, 'revisionConflict', { currentRevision: w.events.length, missing: [] })
    const next = [...w.events]
    for (const e of batch.slice(i)) {
      if (next.some(x => x.id === e.id)) return err(409, 'eventConflict', { eventId: e.id })
      const trial = { ...w, events: next }
      if (e.kind === 'setLogged' || e.kind === 'setCleared') {
        if (!findSlotSet(trial, e)) return err(422, 'invalidEvent', { eventId: e.id, reason: `the plan has no set ${e.slot}/${e.step}/${e.set}` })
      } else if (e.kind === 'questionAnswered') {
        if (!derive(trial).pendingQuestions.some(q => q.id === e.question && q.occurrence === e.occurrence)) return err(422, 'invalidEvent', { eventId: e.id, reason: 'that question is not open' })
      } else return err(422, 'unsupportedEvent', { eventId: e.id, kind: e.kind })
      next.push(e)
    }
    w.events = next
    return { status: 200, body: view(a, w) }
  }

  function finish(a, w, body) {
    if (w.completed) return { status: 200, body: { workout: view(a, { ...w, completed: null }), completed: w.completed, statistics: { status: 'processed' } } }
    if (body.expectedRevision !== w.events.length) return err(409, 'revisionConflict', { currentRevision: w.events.length, missing: w.events.slice(body.expectedRevision) })
    if (a.active !== w.workoutId) return err(409, 'activeWorkoutExists', {})
    if (derive(w).pendingQuestions.length) return err(422, 'refused', { code: 'questionsPending' })
    const at = logged(w.events)
    if (!at.size) return err(422, 'refused', { code: 'emptySession' })
    const e = a.enrollments.get(w.enrollmentId)
    // Progression: every lift whose work sets were all logged at their target reps goes up 2.5.
    for (const slot of w.plan.slots) {
      const work = slot.steps[0]
      if (work.sets.every((s, i) => (at.get(`${slot.slot}|work|${i}`)?.values.reps ?? 0) >= s.metrics.reps.v.v)) e.state[slot.slot].load += 2.5
    }
    e.revision++
    w.status = 'completed'
    w.finishedAt = now().toISOString()
    w.completed = { format: 'reppen.completed-workout/1', workoutId: w.workoutId, enrollmentId: w.enrollmentId, artifactId: ARTIFACT, localDay: w.localDay, day: w.day, revision: w.events.length, enrollmentRevision: e.revision, events: w.events }
    a.active = null
    return finish(a, w, body)
  }

  function route(method, path, body, sub) {
    const a = of(sub)
    const [p, query = ''] = path.split('?')
    const parts = p.split('/').filter(Boolean).map(decodeURIComponent)
    if (parts[0] !== 'v1') return err(404, 'notFound')
    const [, kind, id, action] = parts
    if (method === 'GET' && kind === 'program-catalog' && !id) return { status: 200, body: { format: 'reppen.program-catalog/1', items: CATALOG, nextCursor: null } }
    if (kind === 'enrollments' && id && !action) {
      if (method === 'GET') return a.enrollments.has(id) ? { status: 200, body: a.enrollments.get(id) } : err(404, 'enrollmentNotFound')
      if (method === 'PUT') {
        if (body.artifactId !== ARTIFACT) return err(404, 'programNotFound', { artifactId: body.artifactId })
        if (a.enrollments.has(id)) return { status: 200, body: a.enrollments.get(id) }
        if (!body.params?.squatStart) return err(422, 'refused', { reason: 'evaluate: no parameter squatStart' })
        const e1rm = key => body.readings?.find(r => r.key === key)?.value?.n
        if (LIFTS.some(([, key]) => !(e1rm(key) > 0))) return err(422, 'refused', { reason: 'a required reading is missing' })
        const state = Object.fromEntries(LIFTS.map(([slot, key]) => [slot, { load: round(e1rm(key) * 0.85 * 6 / 7) }]))
        a.enrollments.set(id, { enrollmentId: id, artifactId: ARTIFACT, execution: CATALOG[0].execution, revision: 0, document: '{}', state })
        return { status: 201, body: a.enrollments.get(id) }
      }
    }
    if (kind === 'workouts' && id) {
      const w = a.workouts.get(id)
      if (method === 'PUT' && !action) {
        if (w) return JSON.stringify(w.request) === JSON.stringify(body) ? { status: 200, body: view(a, w) } : err(409, 'workoutConflict', { workoutId: id })
        const e = a.enrollments.get(body.enrollmentId)
        if (!e) return err(404, 'enrollmentNotFound')
        if (e.revision !== body.enrollmentRevision) return err(409, 'enrollmentConflict', { expectedRevision: body.enrollmentRevision, currentRevision: e.revision })
        if (!CATALOG[0].days.includes(body.day)) return err(400, 'invalidRequest', { reason: 'unknown day' })
        const nw = { workoutId: id, enrollmentId: body.enrollmentId, localDay: body.localDay, day: body.day, status: 'active', events: [], request: body, plan: basePlan(e, body.day) }
        a.workouts.set(id, nw)
        if (a.active) return err(409, 'activeWorkoutExists', { active: summary(a.workouts.get(a.active)), held: summary(nw) })
        a.active = id
        return { status: 201, body: view(a, nw) }
      }
      if (!w) return err(404, 'workoutNotFound')
      if (method === 'GET' && !action) return { status: 200, body: view(a, w) }
      if (method === 'POST' && action === 'events') return events(a, w, body)
      if (method === 'POST' && action === 'finish') return finish(a, w, body)
      if (method === 'POST' && action === 'activate') {
        if (w.status === 'completed') return err(409, 'workoutFinished', { revision: w.events.length })
        if (a.active !== id) {
          if ((body.replaces ?? null) !== a.active) return err(409, 'activeWorkoutExists', {})
          a.active = id
        }
        return { status: 200, body: view(a, w) }
      }
    }
    if (method === 'GET' && kind === 'history' && !id) {
      const items = [...a.workouts.values()].filter(w => w.completed).sort((x, y) => (x.finishedAt < y.finishedAt ? 1 : -1))
        .map(w => ({ source: 'program', workoutId: w.workoutId, date: w.localDay, localDay: w.localDay, format: 'reppen.completed-workout/1', dateBasis: 'local_day', finishedAt: w.finishedAt, artifactId: ARTIFACT, enrollmentId: w.enrollmentId, amendmentRevision: 0, visibilityRevision: 0 }))
      return { status: 200, body: { format: 'reppen.history/1', items: items.slice(0, Number(new URLSearchParams(query).get('limit')) || 20), nextCursor: null } }
    }
    return err(404, 'notFound')
  }

  return {
    handle(method, path, body, sub) {
      if (!sub) return { status: 401, body: { error: 'unauthenticated', reason: 'noClaims' } }
      return route(method, path, body ?? {}, sub)
    },
  }
}

/* ---------------------------------------------------------------- HTTP, for the dev server */

const b64json = s => JSON.parse(Buffer.from(s, 'base64url'))

async function verifier(jwksUrl) {
  if (!jwksUrl) return auth => (/^Bearer \S+$/.test(auth || '') ? 'dev' : null)
  const keys = new Map()
  const load = async () => { for (const k of (await (await fetch(jwksUrl)).json()).keys) keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })) }
  await load()
  return async auth => {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth || '')
    if (!m) return null
    const head = b64json(m[1]), claims = b64json(m[2])
    if (head.alg !== 'EdDSA') return null
    if (!keys.has(head.kid)) await load()
    const key = keys.get(head.kid)
    if (!key || !crypto.verify(null, Buffer.from(`${m[1]}.${m[2]}`), key, Buffer.from(m[3], 'base64url'))) return null
    const t = Date.now() / 1000
    return claims.exp > t - 60 && claims.nbf <= t + 60 && typeof claims.sub === 'string' ? claims.sub : null
  }
}

export async function serve({ port = 8080, jwks = null } = {}) {
  const fake = createFakeReppen()
  const subOf = await verifier(jwks)
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try { body = raw ? JSON.parse(raw) : null } catch { body = null }
    const { status, body: out } = fake.handle(req.method, req.url, body, await subOf(req.headers.authorization))
    console.log(req.method, req.url, status)
    res.writeHead(status, { 'content-type': 'application/json', 'x-reppen-contract': 'reppen.workout-api/1' })
    res.end(JSON.stringify(out))
  })
  await new Promise(r => server.listen(port, '127.0.0.1', r))
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
  const port = Number(arg('--port') || 8080)
  serve({ port, jwks: arg('--jwks') }).then(() => console.log(`fake Reppen on http://127.0.0.1:${port}`))
}
