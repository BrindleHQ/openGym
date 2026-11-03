// @vitest-environment happy-dom
// The Reppen screens against the fake Reppen (scripts/reppen-fake.mjs), through the real client and
// store: start from Programs, log sets, answer the question, finish, and find it in the history.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wire = vi.hoisted(() => ({ fake: null, sent: [], offlineEvents: false, offlineActivate: false, after: null }))
vi.mock('./client.js', async orig => {
  const m = await orig()
  const fetch = async (url, init) => {
    const path = url.replace(/^.*?\/reppen/, '')
    const body = init.body ? JSON.parse(init.body) : undefined
    wire.sent.push({ method: init.method, path, body })
    if ((wire.offlineEvents && path.endsWith('/events')) || (wire.offlineActivate && path.endsWith('/activate'))) throw new TypeError('Failed to fetch')
    const headers = Object.fromEntries(new Headers(init.headers))
    const { status, body: out, headers: answer } = wire.fake.handle(init.method, path, body, 'u1', headers)
    await wire.after?.(path, body)
    return new Response(status === 304 ? null : JSON.stringify(out), { status, headers: answer })
  }
  return { ...m, reppenClient: () => m.reppenClient({ base: () => '/reppen/', token: async () => 't', fetch }) }
})
const navSpy = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navSpy, Navigate: ({ to }) => <i data-redirect={to} /> }))

import { createFakeReppen } from '../../scripts/reppen-fake.mjs'
import { useStore } from '../store/useStore.js'
import { reppenStore } from './connection.js'
import ReppenPrograms from './ReppenPrograms.jsx'
import ReppenWorkout from './ReppenWorkout.jsx'
import dorito from './dorito-fixture.json'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mounted = []
async function render(View) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  await act(async () => root.render(<View />))
  await settle()
  return host
}
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)) })
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const click = async el => { await act(async () => el.click()); await settle() }
const row = (host, pos) => host.querySelector(`[data-pos="${pos}"]`)
const initialProfile = structuredClone(useStore.getState().S)
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  wire.fake = createFakeReppen()
  wire.sent = []
  wire.offlineEvents = false; wire.offlineActivate = false; wire.after = null
  navSpy.mockClear()
  localStorage.clear()
  reppenStore.setState({ local: {}, localOwner: null, catalog: null, enrollmentView: null, error: null, busy: false, workout: null, outbox: [], rejected: [], held: null, finished: null, history: null })
  useStore.setState({ S: structuredClone(initialProfile), config: { reppen: true }, user: { id: 'u1', name: 'Ana' } })
  reppenStore.getState().hydrate()
  await reppenStore.getState().loadCatalog()
  await reppenStore.getState().enroll(reppenStore.getState().catalog[0], { 0: 140, 1: 100 })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); document.body.innerHTML = '' })

describe('Reppen workout screens', () => {
  it('renders every real Dorito quality, fifth-set, recovery and duration choice without skipping', async () => {
    await reppenStore.getState().start('A1')
    const host = await render(ReppenWorkout)
    const questions = Object.entries(dorito.questions).map(([id, q]) => ({ id, occurrence: 'occ-' + id, text: q.text,
      choices: Object.entries(q.answer.labels).map(([tag, label]) => ({ label, value: { v: 'enum', name: q.answer.name, tag } })) }))
    const answer = vi.spyOn(reppenStore.getState(), 'answer').mockResolvedValue()
    await act(async () => reppenStore.setState(s => ({ workout: { ...s.workout, pendingQuestions: questions } })))
    expect(host.querySelectorAll('.rp-question')).toHaveLength(46)
    expect(button(host, 'Finish workout').disabled).toBe(true)
    for (const q of questions) {
      const card = host.querySelector(`[data-question="${q.id}"]`)
      expect(card.textContent).toContain(q.text)
      for (const [i, choice] of q.choices.entries()) {
        expect(card.querySelectorAll('button')[i].textContent).toBe(choice.label)
        await act(async () => card.querySelectorAll('button')[i].click())
        expect(answer).toHaveBeenLastCalledWith(q, choice)
      }
    }
    answer.mockRestore()
  })

  it('explains online-required finish while disconnected even with no unsent sets', async () => {
    await reppenStore.getState().start('A1')
    const host = await render(ReppenWorkout)
    await act(async () => reppenStore.setState({ offline: true, offlinePack: null, outbox: [] }))
    expect(button(host, 'Finish workout').disabled).toBe(true)
    expect(host.textContent).toContain('Connect to finish this workout. Your entries are saved on this device.')
  })
  it('resets typed set drafts when continuing another workout', async () => {
    await reppenStore.getState().start('A1')
    await reppenStore.getState().start('B1')
    await reppenStore.getState().resume()
    const host = await render(ReppenWorkout)
    await act(async () => type(row(host, 'squat|work|0').querySelector('input'), '999'))
    await click(button(host, 'Continue that workout'))
    expect(host.querySelector('h1').textContent).toBe('Day A1')
    expect(row(host, 'squat|work|0').querySelector('input').value).toBe('102.5')
  })

  it('keeps a failed activation on Programs visible without navigating', async () => {
    await reppenStore.getState().start('A1')
    await reppenStore.getState().start('B1')
    const host = await render(ReppenPrograms)
    navSpy.mockClear(); wire.offlineActivate = true
    await click(button(host, 'Start this one instead'))
    expect(navSpy).not.toHaveBeenCalled()
    expect(host.textContent).toContain('could not be reached')
  })

  it('queues only one answer when a question is tapped twice before its response', async () => {
    await reppenStore.getState().start('A1')
    const host = await render(ReppenWorkout)
    for (let i = 0; i < 3; i++) await click(row(host, `squat|work|${i}`).querySelector('[role=checkbox]'))
    let release
    wire.after = (path, body) => path.endsWith('/events') && body.events.some(e => e.kind === 'questionAnswered') ? new Promise(r => { release = r }) : undefined
    const yes = button(host, 'Yes')
    await act(async () => { yes.click(); yes.click() })
    await settle()
    expect(reppenStore.getState().outbox).toHaveLength(1)
    await act(async () => release())
    await settle()
    expect(reppenStore.getState().rejected).toEqual([])
  })

  it('offers retry for queued entries even when navigation cleared the error', async () => {
    await reppenStore.getState().start('A1')
    wire.offlineEvents = true
    await reppenStore.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    reppenStore.setState({ error: null })
    const host = await render(ReppenWorkout)
    const retry = button(host, 'Try again')
    expect(retry).toBeTruthy()
    wire.offlineEvents = false
    await click(retry)
    expect(reppenStore.getState().outbox).toEqual([])
  })

  it('blocks set changes while Finish is waiting for its response', async () => {
    await reppenStore.getState().start('A1')
    await reppenStore.getState().logSet('bench', 'work', 0, { load: 50, reps: 10 })
    const host = await render(ReppenWorkout)
    let release
    wire.after = path => path.endsWith('/finish') ? new Promise(r => { release = r }) : undefined
    await click(button(host, 'Finish workout'))
    const checkbox = row(host, 'squat|work|0').querySelector('[role=checkbox]')
    const calls = wire.sent.filter(r => r.path.endsWith('/events')).length
    const disabled = checkbox.matches(':disabled')
    await act(async () => { checkbox.click(); void reppenStore.getState().logSet('squat', 'work', 0, { load: 1, reps: 1 }) })
    await settle()
    const after = wire.sent.filter(r => r.path.endsWith('/events')).length
    await act(async () => release())
    await settle()
    expect(disabled).toBe(true)
    expect(after).toBe(calls)
    expect(host.querySelector('.rp-finished')).toBeTruthy()
  })

  it('shows prescribed rest and RIR and retains issued units when the effective plan omits its stamp', async () => {
    useStore.setState({ S: { ...useStore.getState().S, unit: 'lb' } })
    await reppenStore.getState().start('A1')
    const workout = structuredClone(reppenStore.getState().workout)
    workout.plan.stamp = { display: { load: 'lb' } }
    const effective = structuredClone(workout.effectivePlan || workout.plan)
    delete effective.stamp
    effective.slots[0].steps[0].sets[0].restSec = 120
    effective.slots[0].steps[0].sets[0].metrics.effort = { k: 'fixed', v: { b: 'exact', v: 2 } }
    workout.effectivePlan = effective
    reppenStore.setState({ workout })
    const host = await render(ReppenWorkout)
    const set = row(host, 'squat|work|0')
    expect(set.textContent).toContain('Rest (s): 120')
    expect(set.textContent).toContain('2 RIR')
    expect(set.textContent).toContain('102.5 lb')
    expect(set.textContent).not.toContain('kg')
  })

  it('displays pounds but logs edited loads in the issued kilograms', async () => {
    useStore.setState({ S: { ...useStore.getState().S, unit: 'lb' } })
    await reppenStore.getState().start('A1')
    const host = await render(ReppenWorkout)
    const set = row(host, 'squat|work|0')
    expect(set.textContent).toContain('225.97 lb')
    await act(async () => type(set.querySelector('input[aria-label="lb"]'), '130'))
    await click(set.querySelector('[role=checkbox]'))
    const event = wire.sent.filter(r => r.path.endsWith('/events')).at(-1).body.events[0]
    expect(event.values.load).toBeCloseTo(58.9670081, 8)
    expect(set.querySelector('input[aria-label="lb"]').value).toBe('130')
  })

  it('runs a workout from start to history', async () => {
    let host = await render(ReppenPrograms)
    await click(button(host, 'Start A1'))
    expect(navSpy).toHaveBeenCalledWith('/reppen/workout')
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })

    host = await render(ReppenWorkout)
    expect(host.querySelector('h1').textContent).toBe('Day A1')
    expect(row(host, 'squat|work|0').textContent).toContain('102.5 kg')
    expect(row(host, 'squat|last|0').textContent).toContain('5+ Reps')
    expect(button(host, 'Finish workout').disabled).toBe(false)

    // Each tick is one event for that set, with the numbers in its fields.
    for (let i = 0; i < 3; i++) await click(row(host, `squat|work|${i}`).querySelector('[role=checkbox]'))
    const logged = wire.sent.filter(r => r.path.endsWith('/events')).map(r => r.body.events[0])
    expect(logged.map(e => [e.slot, e.step, e.set, e.values.load, e.values.reps])).toEqual([
      ['squat', 'work', 0, 102.5, 5], ['squat', 'work', 1, 102.5, 5], ['squat', 'work', 2, 102.5, 5]])
    expect(row(host, 'squat|work|0').className).toContain('done')

    // The question those sets opened; Finish waits for it.
    expect(host.querySelector('.rp-question h2').textContent).toBe('Add a back-off set?')
    expect(button(host, 'Finish workout').disabled).toBe(true)
    await click(button(host, 'Yes'))
    expect(host.querySelector('.rp-question')).toBe(null)
    // The set the answer added, at the load Reppen calculated from the logged sets.
    expect(row(host, 'squat|backoff|0').textContent).toContain('92.5 kg')
    expect(host.querySelector('[data-step="backoff"]').textContent).toContain('calculated these targets')

    // A tick undone is a clear, not a deletion of a list entry.
    await click(row(host, 'bench|work|0').querySelector('[role=checkbox]'))
    await click(row(host, 'bench|work|0').querySelector('[role=checkbox]'))
    expect(wire.sent.findLast(r => r.path.endsWith('/events')).body.events[0]).toMatchObject({ kind: 'setCleared', slot: 'bench', step: 'work', set: 0 })
    expect(wire.sent.some(r => r.method === 'GET' && r.path.endsWith('/offline-pack'))).toBe(true)

    await click(button(host, 'Finish workout'))
    expect(wire.sent.at(-1)).toMatchObject({ method: 'POST', body: { expectedRevision: 6 } })
    expect(host.querySelector('.rp-finished').textContent).toContain('Next workout: B1')
    // It is in OpenGym's own history too, once: the three squat sets; the bench set was cleared.
    const copies = useStore.getState().S.workouts.filter(x => x.managed?.source === 'reppen')
    expect(copies.map(x => [x.name, x.entries.map(e => [e.id, e.sets.length])])).toEqual([
      ['GZCLP (test program) · A1', [['reppen:wger:111', 3]]]])
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })

    host = await render(ReppenPrograms)
    expect(button(host, 'Start B1')).toBeTruthy()
    expect(host.querySelectorAll('.lrow').length).toBeGreaterThan(0)
    expect(host.textContent).toContain('Reppen history')
    expect(host.textContent).toContain('GZCLP (test program)')
  })

  it('keeps a metric logged blank blank, instead of showing the target', async () => {
    let host = await render(ReppenPrograms)
    await click(button(host, 'Start A1'))
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    host = await render(ReppenWorkout)
    const load = row(host, 'squat|work|0').querySelector('input')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(load, '')
      load.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(row(host, 'squat|work|0').querySelector('[role=checkbox]'))
    expect(wire.sent.filter(r => r.path.endsWith('/events')).at(-1).body.events[0].values).toEqual({ reps: 5 })
    expect(row(host, 'squat|work|0').className).toContain('done')
    expect(row(host, 'squat|work|0').querySelector('input').value).toBe('')
  })

  it('names an exercise from the catalog when the plan gives it no label', async () => {
    await reppenStore.getState().start('A1')
    const host = await render(ReppenWorkout)
    expect([...host.querySelectorAll('.rp-slot h2')].map(h => h.textContent)).toEqual(['Barbell Back Squat', 'Barbell Bench Press'])
    const workout = structuredClone(reppenStore.getState().workout)
    for (const slot of workout.effectivePlan.slots) delete slot.exercise.label
    workout.effectivePlan.slots[1].exercise.id = 'wger:999'
    await act(async () => reppenStore.setState({ workout }))
    expect([...host.querySelectorAll('.rp-slot h2')].map(h => h.textContent)).toEqual(['Barbell Back Squat', 'wger:999'])
  })

  it('shows Resume for a workout in progress, and a refusal in words', async () => {
    await reppenStore.getState().start('A1')
    let host = await render(ReppenPrograms)
    await click(button(host, 'Resume workout'))
    expect(navSpy).toHaveBeenCalledWith('/reppen/workout')
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    host = await render(ReppenWorkout)
    await click(button(host, 'Finish workout'))   // nothing logged yet
    expect(host.querySelector('[role=alert]').textContent).toContain('Log at least one set before finishing.')
  })

  it('lets the person choose when another workout is already in progress', async () => {
    await reppenStore.getState().start('A1')
    reppenStore.setState({ local: { ...reppenStore.getState().local, workoutId: null }, workout: null })
    const host = await render(ReppenPrograms)
    await click(button(host, 'Start A1'))
    expect(host.querySelector('.rp-held').textContent).toContain('Another workout is already in progress: A1')
    await click(button(host, 'Continue that workout'))
    expect(navSpy).toHaveBeenLastCalledWith('/reppen/workout')
    expect(reppenStore.getState().workout.day).toBe('A1')
  })

  it('still offers that choice after a reload, read from the held workout', async () => {
    await reppenStore.getState().start('A1')
    reppenStore.setState({ local: { ...reppenStore.getState().local, workoutId: null }, workout: null })
    await reppenStore.getState().start('B1')   // held behind A1
    // A reload: nothing in memory, only what this browser stored.
    reppenStore.setState({ local: {}, localOwner: null, workout: null, held: null })
    let host = await render(ReppenPrograms)
    expect(host.querySelector('.rp-held').textContent).toContain('A1')
    act(() => { mounted.splice(0).forEach(r => r.unmount()) })
    host = await render(ReppenWorkout)
    expect(host.querySelector('h1').textContent).toBe('Day B1')
    await click(button(host, 'Start this one instead'))
    expect(reppenStore.getState().workout).toMatchObject({ day: 'B1', active: true })
    expect(host.querySelector('.rp-held')).toBe(null)
    await click(row(host, 'squat|work|0').querySelector('[role=checkbox]'))
    await click(button(host, 'Finish workout'))
    expect(host.querySelector('.rp-finished')).toBeTruthy()
  })

  it('shows a set another device saved first as a draft, and follows that device to the finish', async () => {
    await reppenStore.getState().start('A1')
    const id = reppenStore.getState().workout.workoutId
    const host = await render(ReppenWorkout)
    // The other device saves the squat's first set while this one still shows revision 0.
    const other = (path, body) => wire.fake.handle('POST', `/v1/workouts/${id}/${path}`, body, 'u1')
    other('events', { expectedRevision: 0, events: [{ id: 'e-other', kind: 'setLogged', slot: 'squat', step: 'work', set: 0, values: { load: 110, reps: 5 } }] })
    // This device types 100 and ticks the set.
    const load = row(host, 'squat|work|0').querySelector('input')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(load, '100')
      load.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(row(host, 'squat|work|0').querySelector('[role=checkbox]'))
    const draft = row(host, 'squat|work|0').querySelector('.rp-draft')
    expect(draft.textContent).toContain('Another device saved this set first. Yours was: 100 kg × 5 Reps')
    // The row shows the value Reppen kept, not the one typed here.
    expect(row(host, 'squat|work|0').querySelector('input').value).toBe('110')
    await click(button(draft, 'Save mine'))
    expect(wire.sent.findLast(r => r.path.endsWith('/events')).body.events[0]).toMatchObject({ kind: 'setLogged', set: 0, values: { load: 100 } })
    expect(row(host, 'squat|work|0').querySelector('.rp-draft')).toBe(null)

    // Hidden, the runner does not ask; shown again, it catches up and finds the workout finished.
    other('finish', { expectedRevision: 2 })
    const gets = () => wire.sent.filter(r => r.method === 'GET' && r.path.includes('/workouts/')).length
    const before = gets()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(gets()).toBe(before)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await settle()
    expect(host.querySelector('.rp-finished').textContent).toContain('Next workout: B1')
    expect(wire.sent.filter(r => r.path.endsWith('/finish'))).toEqual([])
  })

  it('tells of a draft still open when the other device finished', async () => {
    await reppenStore.getState().start('A1')
    const id = reppenStore.getState().workout.workoutId
    const host = await render(ReppenWorkout)
    const other = (path, body) => wire.fake.handle('POST', `/v1/workouts/${id}/${path}`, body, 'u1')
    other('events', { expectedRevision: 0, events: [{ id: 'e-other', kind: 'setLogged', slot: 'squat', step: 'work', set: 0, values: { load: 110, reps: 5 } }] })
    await click(row(host, 'squat|work|0').querySelector('[role=checkbox]'))
    expect(row(host, 'squat|work|0').querySelector('.rp-draft')).toBeTruthy()
    other('finish', { expectedRevision: 1 })
    await act(async () => window.dispatchEvent(new Event('focus')))
    await settle()
    expect(host.querySelector('.rp-finished')).toBeTruthy()
    const note = host.querySelector('[role=alert]')
    expect(note.textContent).toContain('Reppen did not take 1 of your entries.')
    await click(button(note, 'OK'))
    expect(reppenStore.getState().rejected).toEqual([])
  })
})
