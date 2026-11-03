// Data-only port of residual::questions::Offline. Never executes program/CEL text.
import { evaluateExpression, foldLogs } from './offline-finish.js'

const FORMAT = 'reppen.residual/1'
const clone = value => structuredClone(value)
const id = t => JSON.stringify([t.slot, t.step, t.set, t.metric])
const setId = t => JSON.stringify([t.slot, t.step, t.set])
const connection = reason => ({ k: 'needsConnection', reason })
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const own = (x, key) => x != null && Object.hasOwn(x, key)
const put = (x, key, value) => Object.defineProperty(x, key, { value: clone(value), enumerable: true, writable: true, configurable: true })
const equal = (a, b) => {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && equal(a[k], b[k]))
}

// Resolve only the history predicate; all arithmetic/aggregation stays in the
// shared residual evaluator. Unknown expression operations still fail closed.
function truth(expression, logs, ever) {
  const resolve = x => {
    if (Array.isArray(x)) return x.map(resolve)
    if (!object(x)) return x
    if (x.op === 'wasLogged') {
      // Let the shared evaluator reject this only if evaluation reaches it:
      // boolean/conditional branches are lazy, just as in Rust's Cx.
      if (!ever) return x
      return { op: 'bool', v: ever.has(setId(x)) }
    }
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, resolve(v)]))
  }
  const result = evaluateExpression(resolve(expression), logs)
  if (typeof result !== 'boolean') throw Error('Expected a boolean')
  return result
}

function find(list, field, name) {
  if (!Array.isArray(list)) throw Error('The plan has no list here')
  const found = list.find(x => x?.[field] === name)
  if (!found) throw Error(`The plan has no ${name}`)
  return found
}

function writePath(at, path, value) {
  if (!Array.isArray(path) || !path.length || path.some(k => typeof k !== 'string')) throw Error('Invalid patch path')
  for (const key of path.slice(0, -1)) {
    if (!own(at, key)) throw Error('The plan has no such field')
    at = at[key]
  }
  if (!object(at)) throw Error('The plan has no such field')
  put(at, path.at(-1), value)
}

function apply(plan, live, op, ever) {
  const upsert = rules => {
    for (const rule of rules || []) live.set(id(rule), clone(rule))
  }
  const slot = () => find(plan.slots, 'slot', op.slot)
  const step = () => find(slot().steps, 'key', op.step)
  const sets = () => {
    const list = step().sets
    if (!Array.isArray(list)) throw Error('The step has no sets')
    return list
  }
  const index = n => {
    if (!Number.isInteger(n) || n < 0 || n > 4294967295) throw Error('Invalid set index')
    return n
  }
  switch (op.op) {
    case 'set': {
      if (op.step == null || op.sets == null) {
        writePath(op.step == null ? slot() : step(), op.path, op.value)
        return
      }
      if (!Array.isArray(op.sets)) throw Error('Invalid set indexes')
      const list = sets()
      for (const i of op.sets) {
        index(i)
        if (op.unlessLogged && ever.has(setId({ ...op, set: i }))) continue
        if (!own(list, i)) throw Error('The step has no such set')
        writePath(list[i], op.path, op.value)
        if (op.path.length === 2 && op.path[0] === 'metrics') live.delete(id({ ...op, set: i, metric: op.path[1] }))
        upsert((op.live || []).filter(t => t.set === i))
      }
      return
    }
    case 'addSets': {
      if (!Array.isArray(op.sets)) throw Error('Invalid added sets')
      sets().push(...clone(op.sets))
      upsert(op.live)
      return
    }
    case 'removeSets': {
      const list = sets(), from = index(op.from)
      if (from > list.length) throw Error('Removing sets the step does not have')
      list.length = from
      for (const [key, t] of live) if (t.slot === op.slot && t.step === op.step && t.set >= from) live.delete(key)
      return
    }
    case 'swapExercise':
      put(slot(), 'exercise', op.exercise)
      upsert(op.live)
      return
    case 'order': {
      if (!Array.isArray(op.slots) || !Array.isArray(plan.slots)) throw Error('Invalid slot order')
      const remaining = [...plan.slots]
      const ordered = op.slots.map(name => {
        const i = remaining.findIndex(s => s.slot === name)
        if (i < 0) throw Error(`The plan has no slot ${name}`)
        return remaining.splice(i, 1)[0]
      })
      if (remaining.length) throw Error('The order leaves out a slot')
      plan.slots = ordered
      return
    }
    default: throw Error('Unsupported question patch operation')
  }
}

/**
 * Accept live/question documents (format checked), or their targets/occurrences
 * arrays from a validated pack. Inputs and getter outputs are detached copies.
 * events must contain the complete log/clear history since the workout began,
 * including server events. Each queued answer is applied once, in order, to a
 * fresh controller on reload, using the events preceding that answer.
 *
 * pending(events) returns descriptors, throwing for unsupported trigger data.
 * answer(events, occurrenceString | {question, occurrence}, choiceIndex | typedValue)
 * returns {k: applied, event, atFinish}, {k: refused}, or {k: needsConnection, reason}.
 * The caller supplies event id/revision and persists applied answers only.
 */
export function createOfflineQuestions(plan, targets, occurrences) {
  const entries = (doc, field) => {
    if (Array.isArray(doc)) return clone(doc)
    if (doc?.format !== FORMAT || !Array.isArray(doc[field])) throw Error('Unsupported residual format')
    return clone(doc[field])
  }
  let current = clone(plan)
  let live = new Map(entries(targets, 'targets').map(t => [id(t), t]))
  const visible = entries(occurrences, 'occurrences').map(o => ({ o, parent: null }))
  const given = []
  const parentOf = key => visible.find(v => v.o.key === key)?.parent ?? null
  const pending = events => {
    const logs = foldLogs(events)
    return visible.filter(({ o }) => !given.some(g => g.key === o.key) && truth(o.trigger, logs)).map(({ o }) => clone(o))
  }
  return {
    get plan() { return clone(current) },
    get targets() {
      const compare = (a, b) => a === b ? 0 : a < b ? -1 : 1
      return clone([...live.values()].sort((a, b) => compare(a.slot, b.slot) || compare(a.step, b.step) || compare(a.set, b.set) || compare(a.metric, b.metric)))
    },
    get changed() { return given.some(g => g.changed) },
    pending,
    answer(events, question, choice) {
      try {
        const occurrence = typeof question === 'string' ? question : question?.occurrence
        const target = pending(events).find(o => o.occurrence === occurrence && (typeof question === 'string' || o.question === question?.question))
        if (!target) throw Error('The occurrence is not pending')
        const choiceIndex = Number.isInteger(choice) ? choice : target.choices.findIndex(c => equal(c.value, choice))
        const picked = target.choices[choiceIndex]
        if (!picked) throw Error('Unknown choice')
        const parent = parentOf(target.key)
        for (let up = parent; up != null; up = parentOf(up)) {
          if (given.some(g => g.key === up && g.via != null)) return connection('an earlier answer changed the patch this question follows')
        }
        const earlier = given.filter(g => g.changed && (target.conflicts || []).includes(g.key))
        let patch = picked.patch, via = null
        if (earlier.length > 1) return connection('it conflicts with more than one earlier answer')
        if (earlier.length) {
          const g = earlier[0]
          if (g.via != null && g.via !== parent) return connection('the earlier answer used a combined patch itself')
          const after = (picked.after || []).find(a => a.key === g.key && a.choice === g.choice)
          if (!after) return connection('the rules have no combined patch for this order')
          if (after.patch != null) { patch = after.patch; via = g.key }
        }
        if (patch?.k === 'needsConnection') return connection(patch.reason)
        if (patch?.k !== 'patch') throw Error('Unsupported question patch')
        const logs = foldLogs(events), ever = new Set(events.filter(e => e.kind === 'setLogged').map(setId))
        if (patch.refuseIf != null && truth(patch.refuseIf, logs, ever)) return { k: 'refused' }
        const nextPlan = clone(current), nextLive = new Map([...live].map(([k, v]) => [k, clone(v)]))
        const ops = patch.ops || []
        for (const op of ops) apply(nextPlan, nextLive, op, ever)
        const follow = (patch.follow || []).map(o => ({ o: clone(o), parent: target.key }))
        const result = { k: 'applied', event: { kind: 'questionAnswered', question: target.question, occurrence: target.occurrence, value: clone(picked.value) }, atFinish: clone(patch.atFinish || []) }
        current = nextPlan
        live = nextLive
        visible.push(...follow)
        given.push({ key: target.key, choice: choiceIndex, via, changed: ops.length > 0 })
        return result
      } catch (e) { return connection(e.message) }
    },
  }
}
