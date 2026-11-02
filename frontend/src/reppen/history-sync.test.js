// Whether OpenGym's profile sync can carry a Reppen workout written into history from two devices
// without losing or doubling it. Each device is modelled on the store (useStore update: stampChange;
// a push with the revision it last read, merged with the server's copy on a 409: mergeStates), the
// server on PUT /api/data (409 on a stale baseRev, else stampPut and a new revision), the way
// lib/sync-fuzz.test.js models them. The entry is the one history.js makes from a real finish.
import { describe, expect, it } from 'vitest'
import { mergeStates, stampChange } from '../lib/sync-merge.js'
import { stampPut } from '../../../api/sync-stamps.js'
import { addManaged, hasManaged } from './history.js'

const clone = o => JSON.parse(JSON.stringify(o))
const entry = (workoutId, extra = {}) => ({
  exercises: [{ id: 'reppen:wger:111', n: 'Barbell Back Squat', custom: true, eq: '', bp: '', tg: '' }],
  workout: { id: 'reppen:' + workoutId, d: '2026-10-30', start: new Date(2026, 9, 30).getTime(), end: new Date(2026, 9, 30).getTime(),
    routineIds: [], routineId: null, name: 'GZCLP · A1', prs: [], entries: [{ id: 'reppen:wger:111', sets: [{ w: 100, r: 5, done: true }], topW: 100, target: null }],
    managed: { source: 'reppen', workoutId, enrollmentId: 'e1', revision: 5 }, ...extra },
})
const own = (id, d = '2026-10-31') => ({ id, d, start: Date.parse(d + 'T09:00'), end: Date.parse(d + 'T10:00'), routineIds: [], name: 'Own', entries: [], prs: [] })

function world() {
  let clock = Date.parse('2026-11-01T08:00')
  const tick = () => (clock += 1000)
  const server = { doc: { unit: 'kg', workouts: [], customEx: [], _ts: clock }, rev: 1 }
  const put = body => {
    if (body.baseRev != null && body.baseRev !== server.rev) return { status: 409, state: clone(server.doc), rev: server.rev }
    const st = clone(body.state)
    stampPut(server.doc, st, { overRead: true, stamped: true, now: tick() })
    server.doc = st
    return { status: 200, rev: ++server.rev }
  }
  const device = () => {
    const d = { S: clone(server.doc), base: server.rev }
    d.update = mut => { const prev = d.S, S = clone(prev); mut(S); S._ts = stampChange(prev, S, tick()); d.S = S }
    d.push = () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = put({ state: clone(d.S), baseRev: d.base, stamped: true })
        if (res.status === 200) { d.base = res.rev; return }
        d.S = mergeStates(d.S, res.state); d.base = res.rev
      }
      throw new Error('push did not land')
    }
    d.pull = () => { d.S = mergeStates(d.S, clone(server.doc)); d.base = server.rev }
    // What the Reppen screens do with a finished workout (connection.js recordFinished).
    d.record = made => { if (!hasManaged(d.S, made.workout.managed.workoutId)) d.update(S => { addManaged(S, made) }) }
    return d
  }
  return { server, device }
}
const ids = S => S.workouts.map(w => w.id).sort()

describe('profile sync and a Reppen workout written from two devices', () => {
  it('keeps one copy when both devices write it before either syncs', () => {
    const { server, device } = world()
    const phone = device(), laptop = device()
    phone.record(entry('w1'))
    laptop.record(entry('w1'))
    laptop.update(S => { S.workouts.push(own('o1')) })
    phone.push(); laptop.push(); phone.pull()
    for (const S of [server.doc, phone.S, laptop.S]) {
      expect(ids(S)).toEqual(['o1', 'reppen:w1'])
      expect(S.customEx.map(e => e.id)).toEqual(['reppen:wger:111'])
    }
  })

  it('never drops it when the other device pushes unrelated history first', () => {
    const { server, device } = world()
    const phone = device(), laptop = device()
    laptop.update(S => { S.workouts.push(own('o1')) })
    phone.record(entry('w1'))
    laptop.push()     // the phone's base is stale now: its push is refused, merged and sent again
    phone.push()
    laptop.update(S => { S.workouts.push(own('o2', '2026-11-01')) })
    laptop.push()
    phone.pull()
    for (const S of [server.doc, phone.S, laptop.S]) expect(ids(S)).toEqual(['o1', 'o2', 'reppen:w1'])
  })

  it('writes nothing on a second delivery to a device that already has it', () => {
    const { server, device } = world()
    const phone = device(), laptop = device()
    phone.record(entry('w1')); phone.push(); laptop.pull()
    const before = laptop.S
    laptop.record(entry('w1'))
    expect(laptop.S).toBe(before)
    expect(ids(server.doc)).toEqual(['reppen:w1'])
  })

  it('keeps one copy when the two writes differ, whichever pushes first', () => {
    for (const first of ['phone', 'laptop']) {
      const { server, device } = world()
      const dev = { phone: device(), laptop: device() }
      dev.phone.record(entry('w1'))
      dev.laptop.record(entry('w1', { name: 'GZCLP (renamed) · A1' }))
      const second = first === 'phone' ? 'laptop' : 'phone'
      dev[first].push(); dev[second].push(); dev[first].pull()
      expect(ids(server.doc)).toEqual(['reppen:w1'])
      expect(dev.phone.S.workouts).toEqual(dev.laptop.S.workouts)
    }
  })

  it('lets a deletion stand against a device that delivers it again without having synced', () => {
    const { server, device } = world()
    const phone = device(), laptop = device()
    phone.record(entry('w1')); phone.push()
    phone.update(S => { S.workouts = S.workouts.filter(w => w.id !== 'reppen:w1') }); phone.push()
    // The laptop never saw the copy nor its deletion: it adds it, and the merge on its push removes it.
    laptop.record(entry('w1'))
    expect(ids(laptop.S)).toEqual(['reppen:w1'])
    laptop.push()
    expect(ids(server.doc)).toEqual([])
    expect(ids(laptop.S)).toEqual([])
    // Synced, the laptop knows of the deletion and does not add it again.
    laptop.record(entry('w1'))
    expect(ids(laptop.S)).toEqual([])
  })
})
