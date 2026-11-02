// Reading a Reppen workout view for display. Only data: Reppen computes every target, and this
// never derives one (no rounding, no progression); it shows what the effective plan says.

/** A metric target as text: "102.5", "5+" (at least), "≤3", "8–12"; null when not fixed. */
export function targetText(target) {
  if (!target || target.k !== 'fixed' || !target.v) return null
  const { b, v, lo, hi, min, max } = target.v
  const n = x => (Number.isFinite(x) ? String(Math.round(x * 100) / 100) : null)
  if (b === 'exact') return n(v)
  if (b === 'atLeast') return n(v) && n(v) + '+'
  if (b === 'atMost') return n(v) && '≤' + n(v)
  const a = n(lo ?? min), z = n(hi ?? max)
  return a && z ? a + '–' + z : null
}

/** The number a field starts at: what was logged, else the target when it is one number. */
export function startValue(target, logged) {
  if (logged != null) return logged
  const v = target?.k === 'fixed' ? target.v : null
  return v && (v.b === 'exact' || v.b === 'atLeast') && Number.isFinite(v.v) ? v.v : null
}

/** Metric names in display order: load first, then reps, then the rest as the plan has them. */
export const metricOrder = metrics => Object.keys(metrics || {}).sort((a, b) => rank(a) - rank(b))
const rank = m => (m === 'load' ? 0 : m === 'reps' ? 1 : 2)

export const posKey = (slot, step, set) => `${slot}|${step}|${set}`

/**
 * What is logged per set position: Reppen's events in order (the latest log or clear wins), then
 * the events still waiting to be sent, marked `pending`.
 * @returns {Map<string, { values: object, pending: boolean }>}
 */
export function loggedSets(workout, outbox = []) {
  const at = new Map()
  const apply = (e, pending) => {
    const k = posKey(e.slot, e.step, e.set)
    if (e.kind === 'setLogged') at.set(k, { values: e.values || {}, pending })
    else if (e.kind === 'setCleared') at.delete(k)
  }
  for (const e of workout?.events || []) apply(e, false)
  for (const e of outbox) apply(e, true)
  return at
}
