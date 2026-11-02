import { describe, expect, it } from 'vitest'
import { loggedSets, metricOrder, startValue, targetText } from './plan.js'

const fixed = v => ({ k: 'fixed', v })

describe('reading a Reppen plan for display', () => {
  it('writes each kind of target the way a lifter reads it', () => {
    expect(targetText(fixed({ b: 'exact', v: 102.5 }))).toBe('102.5')
    expect(targetText(fixed({ b: 'atLeast', v: 5 }))).toBe('5+')
    expect(targetText(fixed({ b: 'atMost', v: 3 }))).toBe('≤3')
    expect(targetText(fixed({ b: 'range', lo: 8, hi: 12 }))).toBe('8–12')
    expect(targetText(fixed({ b: 'exact', v: 1 / 3 }))).toBe('0.33')
    // Not a fixed number: Reppen works it out, the app does not guess.
    expect(targetText({ k: 'live' })).toBe(null)
    expect(targetText(null)).toBe(null)
  })

  it('starts a field at what was logged, else at a one-number target', () => {
    expect(startValue(fixed({ b: 'exact', v: 100 }), 95)).toBe(95)
    expect(startValue(fixed({ b: 'atLeast', v: 5 }), null)).toBe(5)
    expect(startValue(fixed({ b: 'range', lo: 8, hi: 12 }), null)).toBe(null)
    expect(startValue({ k: 'live' }, null)).toBe(null)
  })

  it('puts load before reps', () => {
    expect(metricOrder({ reps: 1, rir: 1, load: 1 })).toEqual(['load', 'reps', 'rir'])
  })

  it('takes the latest log or clear per set, then the events still being sent', () => {
    const ev = (kind, set, values) => ({ kind, slot: 'squat', step: 'work', set, ...(values ? { values } : {}) })
    const workout = { events: [ev('setLogged', 0, { reps: 3 }), ev('setLogged', 1, { reps: 3 }), ev('setCleared', 1), ev('setLogged', 0, { reps: 4 })] }
    const at = loggedSets(workout, [ev('setLogged', 2, { reps: 5 })])
    expect([...at]).toEqual([['squat|work|0', { values: { reps: 4 }, pending: false }], ['squat|work|2', { values: { reps: 5 }, pending: true }]])
  })
})
