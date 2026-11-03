// Applies reppen.residual/1 data. No program document, interpreter, or executable
// expression text crosses this boundary. Unknown data always needs a connection.
const FORMAT = 'reppen.residual/1'
const clone = value => structuredClone(value)
const absent = cause => ({ none: cause })
const isNone = value => value && typeof value === 'object' && Object.hasOwn(value, 'none')
const cmp = (a, b) => a === b || Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1) ? 0 : a < b ? -1 : 1
const number = x => { if (typeof x !== 'number' || !Number.isFinite(x)) throw Error('Expected a finite number'); return x }
const bool = x => { if (typeof x !== 'boolean') throw Error('Expected a boolean'); return x }
const put = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })

export function foldLogs(events) {
  const logs = new Map()
  for (const e of events) {
    if (e.kind !== 'setLogged' && e.kind !== 'setCleared') continue
    const key = JSON.stringify([e.slot, e.step, e.set])
    if (e.kind === 'setCleared') logs.delete(key)
    else logs.set(key, { slot: e.slot, step: e.step, index: e.set, values: e.values })
  }
  return [...logs.values()]
}

export function evaluateExpression(expression, logs, item = null) {
  const e = expression
  const run = x => evaluateExpression(x, logs, item)
  const n = x => number(run(x)), t = x => bool(run(x))
  const sets = list => logs.filter(s => s.slot === list.slot && s.step === list.step).sort((a, b) => a.index - b.index)
  switch (e?.op) {
    case 'num': return number(e.v)
    case 'bool': return bool(e.v)
    case 'none': return absent(clone(e.cause))
    case 'isNone': return !!isNone(run(e.a))
    case 'add': return number(n(e.a) + n(e.b))
    case 'sub': return number(n(e.a) - n(e.b))
    case 'mul': return number(n(e.a) * n(e.b))
    case 'div': { const a = n(e.a), b = n(e.b); return cmp(b, 0) === 0 ? absent({ k: 'zeroDenominator' }) : number(a / b) }
    case 'min': return Math.min(n(e.a), n(e.b))
    case 'max': return Math.max(n(e.a), n(e.b))
    case 'lt': return cmp(n(e.a), n(e.b)) < 0
    case 'le': return cmp(n(e.a), n(e.b)) <= 0
    case 'eq': return cmp(n(e.a), n(e.b)) === 0
    case 'ge': return cmp(n(e.a), n(e.b)) >= 0
    case 'gt': return cmp(n(e.a), n(e.b)) > 0
    case 'and': return t(e.a) && t(e.b)
    case 'or': return t(e.a) || t(e.b)
    case 'not': return !t(e.a)
    case 'if': return run(t(e.c) ? e.a : e.b)
    case 'round': {
      const x = n(e.a), step = number(e.step)
      if (step <= 0) return x
      if (e.mode === 'up') return Math.ceil(x / step - 1e-9) * step
      if (e.mode === 'down') return Math.floor(x / step + 1e-9) * step
      if (e.mode !== 'nearest' || !['up', 'down'].includes(e.ties)) throw Error('Unsupported rounding')
      const scaled = x / step * 1e9
      const m = Math.sign(scaled) * Math.round(Math.abs(scaled))
      if (!Number.isFinite(m) || Math.abs(m) > 4503599627370496) return x
      return (e.ties === 'up' ? Math.floor((m + 5e8) / 1e9) : Math.ceil((m - 5e8) / 1e9)) * step
    }
    case 'item': {
      if (!item) throw Error('Item outside aggregation')
      return Object.hasOwn(item.values, e.metric) ? number(item.values[e.metric]) : absent({ k: 'notLogged', metric: e.metric })
    }
    case 'logged': return logs.some(s => s.slot === e.slot && s.step === e.step && s.index === e.set)
    case 'at': {
      const all = sets(e.sets)
      if (!['position', 'index'].includes(e.by)) throw Error('Unsupported set selection')
      const set = e.by === 'position' ? all[e.i] : all.find(s => s.index === e.i)
      return set && Object.hasOwn(set.values, e.metric) ? number(set.values[e.metric]) : absent({ k: 'notLogged', metric: e.metric })
    }
    case 'agg': {
      const all = sets(e.sets)
      const chosen = e.where ? all.filter(s => bool(evaluateExpression(e.where, logs, s))) : all
      if (e.fn === 'count') return chosen.length
      if (e.fn === 'all') return chosen.length === all.length
      if (e.fn === 'any') return chosen.length > 0
      if (!e.of) throw Error('Aggregation needs of')
      const values = chosen.map(s => evaluateExpression(e.of, logs, s)).filter(v => !isNone(v)).map(number)
      if (e.fn === 'sum') return number(values.reduce((a, b) => a + b, 0))
      if (!['min', 'max', 'last'].includes(e.fn)) throw Error('Unsupported aggregation')
      if (!values.length) {
        if (!Object.hasOwn(e, 'empty')) throw Error('Aggregation needs empty')
        return absent(clone(e.empty))
      }
      return e.fn === 'last' ? values.at(-1) : e.fn === 'max' ? Math.max(...values) : Math.min(...values)
    }
    default: throw Error('Unsupported residual operation')
  }
}

export function evaluateFinish(pack, nodeIndex, events, { allowQuestions = false } = {}) {
  try {
    if (pack?.format !== FORMAT) throw Error('Unsupported residual format')
    const node = pack.nodes[nodeIndex]
    if (!node) throw Error('No such workout node')
    const rules = node.finish
    if (rules.k === 'needsConnection') return clone(rules)
    if (rules.k !== 'residual') throw Error('Unsupported finish rule')
    // C2 question patches are a separate adapter. Never apply C3 rules to a
    // plan that an offline answer may have changed behind these rules.
    if (node.occurrences?.length && !allowQuestions) throw Error('Question patches require a connection in this client')
    const logs = foldLogs(events)
    const run = expression => evaluateExpression(expression, logs)
    if (bool(run(rules.refuseIf))) return { k: 'refused', code: 'emptySession' }
    const slots = rules.slots.map(rule => {
      const branch = rule.branches.findIndex(b => bool(run(b.when)))
      if (branch < 0) throw Error('No finish branch holds')
      const selected = rule.branches[branch]
      if (selected.k === 'needsConnection') throw Error(selected.reason)
      if (selected.k !== 'patch') throw Error('Unsupported finish branch')
      const state = clone(rule.state), proposed = {}
      for (const [field, write] of Object.entries(selected.set)) {
        let value
        if (Object.hasOwn(write, 'value')) value = clone(write.value)
        else if (write.expr) {
          const result = run(write.expr)
          value = isNone(result) ? { v: 'none', cause: result.none } : { v: 'q', n: number(result), dim: clone(write.dim), ...(write.unit == null ? {} : { unit: clone(write.unit) }) }
        } else throw Error('Unsupported state write')
        if (!['commit', 'propose'].includes(write.mode)) throw Error('Unsupported state write mode')
        put(write.mode === 'commit' ? state : proposed, field, value)
      }
      return { slot: rule.slot, branch, state, proposed }
    })
    for (const e of events.filter(e => e.kind === 'questionAnswered')) {
      const rule = (rules.answers || []).find(r => r.question === e.question)
      if (!rule) continue
      const choice = rule.choices.find(c => JSON.stringify(c.value) === JSON.stringify(e.value))
      if (!choice) throw Error('Unknown question answer')
      for (const write of choice.state) {
        const slot = slots.find(s => s.slot === write.slot)
        if (!slot) throw Error('Missing state slot')
        put(slot.state, write.field, clone(write.value))
      }
    }
    return { k: 'finished', slots }
  } catch (e) { return { k: 'needsConnection', reason: e.message } }
}

export function evaluateLiveTarget(target, events) {
  const logs = foldLogs(events), rule = target.rule
  if (rule.k === 'needsConnection') return clone(rule)
  if (rule.k !== 'residual') return { k: 'needsConnection', reason: 'Unsupported target rule' }
  if (rule.ready.some(list => !logs.some(s => s.slot === list.slot && s.step === list.step))) return { k: 'pending' }
  try {
    const { bound, grid, ties } = rule.field
    const expressions = bound.b === 'range' ? [bound.min, bound.max] : [bound.v]
    if (!['exact', 'atLeast', 'atMost', 'range'].includes(bound.b)) throw Error('Unsupported target bound')
    const values = expressions.map(e => evaluateExpression(e, logs))
    const missing = values.find(isNone)
    if (missing) return { k: 'resolved', field: { k: 'silent', cause: missing.none } }
    values.forEach(number)
    const out = n => ({ k: 'resolved', field: { k: 'silent', cause: { k: 'outOfDomain', field: target.metric, value: n } } })
    const negative = values.find(n => n < -1e-9)
    if (negative != null) return out(negative)
    const snap = (value, mode) => Math.max(0, evaluateExpression({ op: 'round', a: { op: 'num', v: value }, step: grid, mode, ties }, logs))
    let value
    if (bound.b === 'range') {
      const min = snap(values[0], 'up'), max = snap(values[1], 'down')
      if (cmp(values[0], values[1]) > 0 || cmp(min, max) > 0) return out(values[0])
      value = { b: 'range', min, max }
    } else value = { b: bound.b, v: snap(values[0], bound.b === 'atLeast' ? 'up' : bound.b === 'atMost' ? 'down' : 'nearest') }
    return { k: 'resolved', field: { k: 'fixed', v: value } }
  } catch (e) { return { k: 'needsConnection', reason: e.message } }
}

export function resolveLiveTargets(plan, targets, events) {
  const result = clone(plan)
  for (const target of targets) {
    const value = evaluateLiveTarget(target, events)
    if (value.k !== 'resolved') continue
    const set = result.slots.find(s => s.slot === target.slot)?.steps.find(s => s.key === target.step)?.sets[target.set]
    if (!set || !Object.hasOwn(set.metrics, target.metric)) throw Error('Missing calculated target')
    put(set.metrics, target.metric, value.field)
  }
  return result
}

export function nextWorkout(pack, nodeIndex, outcome, events = []) {
  if (pack?.format !== FORMAT || outcome?.k !== 'finished') return { k: 'needsConnection', reason: 'Workout did not finish offline' }
  const next = pack.nodes[nodeIndex]?.next
  if (next?.k === 'needsConnection') return clone(next)
  if (next?.k !== 'workouts') return { k: 'needsConnection', reason: 'Unsupported next workout rule' }
  const answers = []
  for (const key of next.questions || []) {
    const values = events.filter(e => e.kind === 'questionAnswered' && e.question === key.question).map(e => key.choices.findIndex(c => JSON.stringify(c) === JSON.stringify(e.value)))
    if (values.some(v => v < 0) || new Set(values).size > 1) return { k: 'needsConnection', reason: 'Question answers need reconciliation' }
    answers.push(values.length ? values[0] : null)
  }
  const branches = outcome.slots.map(s => s.branch)
  const found = next.outcomes.find(o => JSON.stringify(o.slots) === JSON.stringify(branches) && (!answers.length || JSON.stringify(o.answers) === JSON.stringify(answers)))
  if (!found || found.node == null) return { k: 'needsConnection', reason: found?.needsConnection || 'No prepared outcome' }
  if (!pack.nodes[found.node]) return { k: 'needsConnection', reason: 'Missing prepared workout' }
  return { k: 'workout', node: found.node, plan: clone(pack.nodes[found.node].plan) }
}

export function previewOfflineFinish(envelope, workout, outbox = []) {
  if (!envelope || !workout || typeof envelope.workoutId !== 'string' || typeof envelope.artifactId !== 'string' || typeof envelope.enrollmentId !== 'string' || !Number.isSafeInteger(envelope.workoutRevision) || envelope.workoutRevision < 0 || envelope.workoutId !== workout.workoutId || envelope.artifactId !== workout.artifactId || envelope.enrollmentId !== workout.enrollmentId || envelope.workoutRevision !== workout.revision) {
    return { finish: { k: 'needsConnection', reason: 'Offline pack is stale or belongs to another workout' } }
  }
  const events = [...(workout.events || []), ...outbox]
  const finish = evaluateFinish(envelope.pack, 0, events)
  return { finish, next: nextWorkout(envelope.pack, 0, finish, events), ...(finish.k === 'finished' ? { offlineState: Object.fromEntries(finish.slots.map(s => [s.slot, clone(s.state)])) } : {}) }
}
