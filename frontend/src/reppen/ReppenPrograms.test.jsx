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
import ReppenPrograms from './ReppenPrograms.jsx'
import { GZCLP, fakeClient } from './test-fixtures.js'

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
  reppenStore.setState({ local: {}, localOwner: null, catalog: null, enrollmentView: null, error: null, busy: false })
  useStore.setState({ config: { reppen: true }, user: { id: 'u1', name: 'Ana' } })
})
afterEach(() => { act(() => { mounted.splice(0).forEach(r => r.unmount()) }); document.body.innerHTML = '' })

describe('Reppen programs screen', () => {
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
})
