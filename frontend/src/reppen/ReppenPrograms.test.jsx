// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const client = vi.hoisted(() => ({}))
vi.mock('./client.js', async orig => ({ ...(await orig()), reppenClient: () => client }))
const navSpy = vi.fn()
vi.mock('react-router-dom', () => ({ useNavigate: () => navSpy, Navigate: ({ to }) => <i data-redirect={to} /> }))

import { useStore } from '../store/useStore.js'
import { reppenStore } from './connection.js'
import ReppenPrograms, { availablePrograms } from './ReppenPrograms.jsx'
import { GZCLP, fakeClient } from './test-fixtures.js'
import dorito from './dorito-fixture.json'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const mounted = []
async function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  await act(async () => root.render(<ReppenPrograms />))
  return host
}
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const button = (host, text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text)
const type = (input, value) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(() => {
  localStorage.clear()
  Object.assign(client, fakeClient())
  reppenStore.setState({ local: {}, localOwner: null, catalog: null, enrollmentView: null, error: null, catalogError: null, enrollmentError: null, busy: false })
  useStore.setState({ config: { reppen: true }, user: { id: 'u1', name: 'Ana' } })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); document.body.innerHTML = '' })

describe('Reppen programs screen', () => {
  it('offers the latest program revision while keeping an older pending enrollment retry reachable', () => {
    const old = { ...dorito, revision: 1 }, current = { ...dorito, artifactId: 'new', revision: 2 }
    expect(availablePrograms([old, current])).toEqual([current])
    expect(availablePrograms([old, current], old.artifactId)).toEqual([old, current])
  })
  it('asks for a day instead of defaulting an advanced recovered enrollment to day A', async () => {
    client.enrollments.mockResolvedValue({ items: [{ enrollmentId: 'server', artifactId: dorito.artifactId, title: dorito.title, days: dorito.days, defaultDay: 'A', nextDay: null, revision: 3 }], nextCursor: null })
    const host = await render()
    expect(host.textContent).toContain('Choose the day you want to train next.')
    expect(host.textContent).not.toContain('Next workout: A')
    expect(button(host, 'Start').disabled).toBe(true)
  })
  it('lets a beginner enroll with unknown weights without silently using program reference weights', async () => {
    const guided = { ...dorito, parameters: dorito.parameters.map(p => ({ ...p, required: false, deferred: true, type: { t: 'opt', of: p.type } })) }
    client.catalog = vi.fn(async () => ({ items: [guided] }))
    const host = await render()
    await act(async () => host.querySelector('button.lrow').click())
    expect(host.querySelectorAll('.rp-setup input')).toHaveLength(0)
    expect(host.textContent).toContain('You do not need to know your weights yet.')
    expect(button(host, 'Enroll').disabled).toBe(false)
    await act(async () => button(host, 'Enroll').click())
    expect(Object.values(client.enroll.mock.calls[0][1].params).every(p => p.v === 'none')).toBe(true)
  })
  it('collects only the user’s known weights and requires confirmation', async () => {
    const guided = { ...dorito, parameters: dorito.parameters.map(p => ({ ...p, required: false, deferred: true, type: { t: 'opt', of: p.type } })) }
    client.catalog = vi.fn(async () => ({ items: [guided] }))
    const host = await render()
    await act(async () => host.querySelector('button.lrow').click())
    await act(async () => button(host, 'I already know some weights').click())
    expect([...host.querySelectorAll('.rp-setup input')].every(i => i.value === '')).toBe(true)
    await act(async () => type(host.querySelectorAll('.rp-setup input')[1], '65'))
    expect([...host.querySelectorAll('.rp-setup input')].filter(i => i.value)).toHaveLength(1)
    expect(button(host, 'Enroll').disabled).toBe(true)
    await act(async () => host.querySelector('input[type=checkbox]').click())
    expect(button(host, 'Enroll').disabled).toBe(false)
    await act(async () => button(host, 'Enroll').click())
    const params = client.enroll.mock.calls[0][1].params
    expect(params.b_press_starting_load.v).toBe('none')
    expect(params.a_bench_increment.v).toBe('none')
    expect(params.a_bench_starting_load.n).toBeCloseTo(65 * 0.45359237)
  })
  it('collects 44 lb values, requires explicit confirmation, and displays the saved setup on retry', async () => {
    client.catalog = vi.fn(async () => ({ items: [dorito] }))
    client.enroll.mockRejectedValue({ code: 'offline' })
    const host = await render()
    await act(async () => host.querySelector('button.lrow').click())
    const fields = [...host.querySelectorAll('.rp-setup input')]
    expect(fields).toHaveLength(44)
    expect(fields.filter(i => !i.value)).toHaveLength(26)
    expect(host.textContent).toContain('each hand')
    expect(host.textContent).not.toContain('custom:opengym')
    expect(button(host, 'Enroll').disabled).toBe(true)
    await act(async () => fields.forEach(i => { if (!i.value) type(i, '5') }))
    expect(button(host, 'Enroll').disabled).toBe(true)
    await act(async () => host.querySelector('input[type=checkbox]').click())
    expect(button(host, 'Enroll').disabled).toBe(false)
    await act(async () => type(fields[0], '135'))
    expect(button(host, 'Enroll').disabled).toBe(true)
    await act(async () => host.querySelector('input[type=checkbox]').click())
    await act(async () => button(host, 'Enroll').click())
    expect(fields.every(i => i.disabled)).toBe(true)
    await act(async () => button(host, 'Try again').click())
    expect(client.enroll.mock.calls[1]).toEqual(client.enroll.mock.calls[0])
  })
  it('is not there on an instance without Reppen', async () => {
    useStore.setState({ config: {} })
    const host = await render()
    expect(host.querySelector('[data-redirect]').dataset.redirect).toBe('/plan')
    expect(client.catalog).not.toHaveBeenCalled()
  })

  it('lists the catalog, enrolls with the readings and shows the next workout', async () => {
    const host = await render()
    await settle()
    expect(host.textContent).toContain('GZCLP T1')
    await act(async () => [...host.querySelectorAll('button.lrow')][0].click())
    const form = host.querySelector('.reppen-enroll')
    expect(form.dataset.catalogId).toBe('gzclp-t1')
    expect(button(host, 'Enroll').disabled).toBe(true)   // both readings are required
    const [squat, bench] = form.querySelectorAll('input')
    await act(async () => { type(squat, '140'); type(bench, '100') })
    expect(button(host, 'Enroll').disabled).toBe(false)
    await act(async () => button(host, 'Enroll').click())
    await settle()
    expect(client.enroll).toHaveBeenCalledTimes(1)
    expect(client.enroll.mock.calls[0][1].readings.map(r => [r.key, r.value.n])).toEqual([['wger:111', 140], ['wger:192', 100]])
    expect(host.querySelector('.reppen-enroll')).toBe(null)
    expect(host.textContent).toContain('Your program')
    expect(host.textContent).toContain('Next workout: A1')
    // A day can be picked by hand; it is remembered for this account.
    await act(async () => button(host, 'B2').click())
    expect(host.textContent).toContain('Next workout: B2')
    expect(JSON.parse(localStorage.getItem('reppen.v1.u1')).nextDay).toBe('B2')
  })

  it('labels each reading with the exercise name, and its id when the catalog has none', async () => {
    const host = await render()
    await settle()
    reppenStore.setState({ exerciseNames: { 'wger:111': 'Barbell Back Squat' } })
    await act(async () => [...host.querySelectorAll('button.lrow')][0].click())
    const fields = [...host.querySelectorAll('.reppen-enroll .measure-field')]
    expect(fields.map(f => f.querySelector('span').textContent)).toEqual(['Barbell Back Squat', 'wger:192'])
    // The app's own measurement field: the number and its unit in one box, what is asked under it.
    expect(fields[0].querySelector('.measure-input input.num')).toBeTruthy()
    expect(fields[0].querySelector('.measure-input i').textContent).toBe('kg')
    expect(fields[0].querySelector('.rp-t').textContent).toBe('Estimated one-rep max')
    expect(fields[0].querySelector('input').getAttribute('aria-label')).toBe('Estimated one-rep max Barbell Back Squat')
    expect(host.querySelector('.reppen-enroll').textContent).not.toContain('wger:111')
  })

  it('says what went wrong when Reppen cannot be reached', async () => {
    const { ReppenError } = await import('./client.js')
    client.catalog = vi.fn(async () => { throw new ReppenError(0, null) })
    const host = await render()
    await settle()
    expect(host.querySelector('[role=alert]').textContent).toContain('could not be reached')
  })

  it('will not enroll in a program that needs a setting it cannot ask for', async () => {
    client.catalog = vi.fn(async () => ({ items: [{ ...GZCLP, parameters: [{ name: 'inc', required: true, type: { t: 'q', dim: { mass: 1 } } }] }], nextCursor: null }))
    const host = await render()
    await settle()
    await act(async () => [...host.querySelectorAll('button.lrow')][0].click())
    expect(host.querySelector('.reppen-enroll [role=alert]').textContent).toContain('needs settings')
    expect(button(host, 'Enroll').disabled).toBe(true)
  })

  it('will not enroll in a program it cannot run', async () => {
    client.catalog = vi.fn(async () => ({ items: [{ ...GZCLP, admission: { status: 'unsupported' } }], nextCursor: null }))
    const host = await render()
    await settle()
    await act(async () => [...host.querySelectorAll('button.lrow')][0].click())
    expect(host.querySelector('.reppen-enroll [role=alert]').textContent).toContain('cannot run here yet')
    expect(button(host, 'Enroll').disabled).toBe(true)
  })

  it('invalidates a pending enrollment on sign-out and permits the same account to retry', async () => {
    let answer
    client.enroll = vi.fn(() => new Promise(r => { answer = r }))
    await render()
    let pending
    await act(async () => { pending = reppenStore.getState().enroll(GZCLP, { 0: 140, 1: 100 }) })
    expect(reppenStore.getState().busy).toBe(true)
    await act(async () => useStore.setState({ user: null }))
    expect(reppenStore.getState().busy).toBe(false)
    await act(async () => useStore.setState({ user: { id: 'u1' } }))
    answer({ enrollmentId: 'old' })
    await settle()
    expect(reppenStore.getState().local.enrollment).toBeUndefined()
    expect(reppenStore.getState().busy).toBe(false)
    client.enroll = vi.fn(async id => ({ enrollmentId: id }))
    await act(async () => expect(await reppenStore.getState().enroll(GZCLP, {})).toBe(true))
    void pending
  })

  it('shows the saved readings and retries them after an ambiguous enrollment failure', async () => {
    const { ReppenError } = await import('./client.js')
    client.enroll = vi.fn().mockRejectedValueOnce(new ReppenError(0, null)).mockImplementation(async id => ({ enrollmentId: id }))
    const host = await render()
    await act(async () => [...host.querySelectorAll('button.lrow')][0].click())
    const inputs = host.querySelectorAll('.reppen-enroll input')
    await act(async () => { type(inputs[0], '140'); type(inputs[1], '100') })
    await act(async () => button(host, 'Enroll').click())
    expect(host.textContent).toContain('Retrying confirms the original enrollment request and readings.')
    expect([...host.querySelectorAll('.reppen-enroll input')].map(i => [i.value, i.disabled])).toEqual([['140', true], ['100', true]])
    await act(async () => button(host, 'Try again').click())
    expect(client.enroll.mock.calls[1]).toEqual(client.enroll.mock.calls[0])
    expect(host.querySelector('.reppen-enroll')).toBe(null)
  })
})
