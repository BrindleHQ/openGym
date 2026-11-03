import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createOfflineQuestions } from './offline-questions.js'

const FORMAT = 'reppen.residual/1'
const yes = { v: 'bool', b: true }
const always = { op: 'bool', v: true }
const logged = set => ({ op: 'logged', slot: 's', step: 'w', set })
const wasLogged = set => ({ ...logged(set), op: 'wasLogged' })
const log = (set = 0) => ({ kind: 'setLogged', slot: 's', step: 'w', set, values: { reps: 5 } })
const clear = set => ({ ...log(set), kind: 'setCleared' })
const plan = () => ({ slots: ['s', 'b'].map(slot => ({ slot, exercise: { id: slot }, steps: [{ key: 'w', sets: [0, 1, 2].map(() => ({ metrics: { reps: { k: 'fixed' } }, restSec: 60 })) }] })) })
const target = (set = 0, metric = 'reps') => ({ slot: 's', step: 'w', set, metric, rule: { k: 'expr', expr: { op: 'num', v: 8 } } })
const setOp = (value = 90) => ({ op: 'set', slot: 's', step: 'w', sets: [0, 1, 2], path: ['restSec'], value })
const question = (key = 'q', patch = { k: 'patch' }, extra = {}) => ({ key, question: `question-${key}`, occurrence: `occurrence-${key}`, text: key, trigger: always, choices: [{ label: 'Yes', value: yes, patch }], ...extra })
const controller = (questions, targets = []) => createOfflineQuestions(plan(), targets, questions)
const answer = (c, key = 'q', events = []) => c.answer(events, `occurrence-${key}`, 0)
const rest = c => c.plan.slots[0].steps[0].sets.map(s => s.restSec)

describe('C2 offline question data applier', () => {
  it('uses current logs for triggers, preserving occurrence identities for repeated questions', () => {
    const qs = [question('a', undefined, { question: 'same', trigger: logged(0) }), question('b', undefined, { question: 'same', trigger: logged(1) })]
    const c = controller(qs)
    expect(c.pending([])).toEqual([])
    expect(c.pending([log(), clear(0)])).toEqual([])
    expect(c.pending([log(), log(1)]).map(q => q.occurrence)).toEqual(['occurrence-a', 'occurrence-b'])
    expect(c.answer([log()], { question: 'wrong', occurrence: 'occurrence-a' }, 0).k).toBe('needsConnection')
    expect(answer(c, 'a', [log()])).toEqual({ k: 'applied', event: { kind: 'questionAnswered', question: 'same', occurrence: 'occurrence-a', value: yes }, atFinish: [] })
    expect(c.pending([log(), log(1)]).map(q => q.key)).toEqual(['b'])
    expect(answer(c, 'a', [log()]).k).toBe('needsConnection')
    expect(c.changed).toBe(false)
  })

  it('protects ever-logged sets after clears while applying broad changes to the rest', () => {
    const c = controller([question('q', { k: 'patch', ops: [{ ...setOp(), unlessLogged: true }] })])
    expect(answer(c, 'q', [log(), clear(0)]).k).toBe('applied')
    expect(rest(c)).toEqual([60, 90, 90])
    expect(c.changed).toBe(true)
  })

  it('refuses history guards atomically without answering or introducing follow-ups', () => {
    const c = controller([question('q', { k: 'patch', refuseIf: { op: 'or', a: wasLogged(0), b: wasLogged(1) }, ops: [setOp()], follow: [question('child')] })])
    expect(answer(c, 'q', [log(), clear(0)])).toEqual({ k: 'refused' })
    expect(rest(c)).toEqual([60, 60, 60])
    expect(c.pending([]).map(q => q.key)).toEqual(['q'])
    expect(c.changed).toBe(false)
    expect(answer(c).k).toBe('applied')
    expect(c.pending([]).map(q => q.key)).toEqual(['child'])
  })

  it('rolls back earlier operations and live updates when a later operation fails', () => {
    for (const bad of [{ op: 'order', slots: ['s'] }, { op: 'removeSets', slot: 's', step: 'w', from: 8 }, { op: 'unknown' }, { ...setOp(), sets: [8] }, { ...setOp(), path: [] }]) {
      const c = controller([question('q', { k: 'patch', ops: [{ op: 'swapExercise', slot: 's', exercise: { id: 'changed' }, live: [target()] }, setOp(), bad] })])
      const before = c.plan
      expect(answer(c).k).toBe('needsConnection')
      expect(c.plan).toEqual(before)
      expect(c.targets).toEqual([])
      expect(c.pending([])).toHaveLength(1)
      expect(c.changed).toBe(false)
    }
  })

  it('replaces/removes metric targets, skips protected targets and prunes removed sets', () => {
    const changed = { ...target(1), rule: { k: 'needsConnection', reason: 'new rule' } }
    const c = controller([question('q', { k: 'patch', ops: [{ ...setOp(), path: ['metrics', 'reps'], value: { k: 'fixed', v: 12 }, unlessLogged: true, live: [changed] }] }), question('trim', { k: 'patch', ops: [{ op: 'removeSets', slot: 's', step: 'w', from: 1 }] })], [target(0), target(1), target(2)])
    expect(answer(c, 'q', [log(), clear(0)]).k).toBe('applied')
    expect(c.targets).toEqual([target(0), changed])
    expect(answer(c, 'trim').k).toBe('applied')
    expect(c.targets).toEqual([target(0)])
    expect(c.plan.slots[0].steps[0].sets).toHaveLength(1)
  })

  it('addresses reordered slots by name, adds sets/targets and replaces exercises', () => {
    const c = controller([question('q', { k: 'patch', ops: [{ op: 'order', slots: ['b', 's'] }, { op: 'set', slot: 's', path: ['label'], value: 'Squat' }, { op: 'set', slot: 's', step: 'w', path: ['count'], value: { k: 'n', n: 4 } }, { op: 'addSets', slot: 's', step: 'w', sets: [{ metrics: {} }], live: [target(3)] }, { op: 'swapExercise', slot: 's', exercise: { id: 'new' }, live: [target(1)] }] })])
    expect(answer(c).k).toBe('applied')
    expect(c.plan.slots.map(s => s.slot)).toEqual(['b', 's'])
    expect(c.plan.slots[1]).toMatchObject({ label: 'Squat', exercise: { id: 'new' }, steps: [{ count: { k: 'n', n: 4 } }] })
    expect(c.plan.slots[1].steps[0].sets).toHaveLength(4)
    expect(c.targets).toEqual([target(1), target(3)])
  })

  it('selects combined patches and ignores operation-free earlier answers', () => {
    const a = question('a', { k: 'patch', ops: [setOp(80)] })
    const b = question('b', { k: 'patch', ops: [setOp(90)] }, { conflicts: ['a'] })
    b.choices[0].after = [{ key: 'a', choice: 0, patch: { k: 'patch', ops: [setOp(100)] } }]
    const c = controller([a, b])
    expect(answer(c, 'a').k).toBe('applied')
    expect(answer(c, 'b').k).toBe('applied')
    expect(rest(c)).toEqual([100, 100, 100])
    a.choices[0].patch = { k: 'patch', atFinish: [{ change: 1, kind: 'state' }] }
    const d = controller([a, b])
    expect(answer(d, 'a').atFinish).toEqual([{ change: 1, kind: 'state' }])
    expect(answer(d, 'b').k).toBe('applied')
    expect(rest(d)).toEqual([90, 90, 90])
  })

  it('uses the original patch for an after entry with no patch', () => {
    const b = question('b', { k: 'patch', ops: [setOp(95)] }, { conflicts: ['a'] })
    b.choices[0].after = [{ key: 'a', choice: 0 }]
    const c = controller([question('a', { k: 'patch', ops: [setOp()] }), b])
    answer(c, 'a')
    expect(answer(c, 'b').k).toBe('applied')
    expect(rest(c)).toEqual([95, 95, 95])
  })

  it('fails closed for missing combined patches, multiple conflicts and chained combinations', () => {
    const a = question('a', { k: 'patch', ops: [setOp()] })
    const b = question('b', { k: 'patch', ops: [setOp(95)] }, { conflicts: ['a'] })
    const c = controller([a, b]); answer(c, 'a')
    expect(answer(c, 'b').reason).toContain('no combined patch')
    b.choices[0].after = [{ key: 'a', choice: 0, patch: { k: 'patch', ops: [setOp(100)] } }]
    const last = question('last', { k: 'patch' }, { conflicts: ['a', 'b'] })
    const d = controller([a, b, last]); answer(d, 'a'); answer(d, 'b')
    expect(answer(d, 'last').reason).toContain('more than one')
    last.conflicts = ['b']
    const e = controller([a, b, last]); answer(e, 'a'); answer(e, 'b')
    expect(answer(e, 'last').reason).toContain('combined patch itself')
  })

  it('follows added occurrences and blocks descendants of a combined ancestor', () => {
    const child = question('child', { k: 'patch' }, { trigger: logged(2) })
    const b = question('b', { k: 'patch', ops: [setOp()], follow: [child] }, { conflicts: ['a'] })
    b.choices[0].after = [{ key: 'a', choice: 0, patch: { k: 'patch', ops: [setOp(100)], follow: [child] } }]
    const c = controller([b])
    answer(c, 'b')
    expect(c.pending([])).toEqual([])
    expect(answer(c, 'child', [log(2)]).k).toBe('applied')
    const d = controller([question('a', { k: 'patch', ops: [setOp()] }), b])
    answer(d, 'a'); answer(d, 'b')
    expect(answer(d, 'child', [log(2)]).reason).toContain('patch this question follows')
  })

  it('allows a conflicting earlier combined patch supplied by the follow-up parent', () => {
    const b = question('b', { k: 'patch', ops: [setOp()] }, { conflicts: ['a'] })
    b.choices[0].after = [{ key: 'a', choice: 0, patch: { k: 'patch', ops: [setOp(95)] } }]
    const child = question('child', { k: 'patch', ops: [setOp(100)] }, { conflicts: ['b'] })
    child.choices[0].after = [{ key: 'b', choice: 0 }]
    const c = controller([question('a', { k: 'patch', ops: [setOp()], follow: [child] }), b])
    answer(c, 'a'); answer(c, 'b')
    expect(answer(c, 'child').k).toBe('applied')
    expect(rest(c)).toEqual([100, 100, 100])
  })

  it('keeps connection-only/unknown rules pending and validates formats and choices', () => {
    expect(() => createOfflineQuestions(plan(), { format: 'future', targets: [] }, [])).toThrow('format')
    const c = controller([question('q', { k: 'needsConnection', reason: 'server only' })])
    expect(answer(c)).toEqual({ k: 'needsConnection', reason: 'server only' })
    expect(c.answer([], 'occurrence-q', 99).reason).toBe('Unknown choice')
    expect(c.pending([])).toHaveLength(1)
    expect(answer(controller([question('q', { k: 'future' })])).k).toBe('needsConnection')
    const d = controller([question('q', undefined, { trigger: { op: 'runProgram' } })])
    expect(() => d.pending([])).toThrow('Unsupported')
    expect(answer(d).k).toBe('needsConnection')
  })

  it('preserves lazy guard evaluation and rejects non-boolean triggers', () => {
    const c = controller([question('q', { k: 'patch', refuseIf: { op: 'and', a: { op: 'bool', v: false }, b: { op: 'unknown' } } }, { trigger: { op: 'or', a: always, b: wasLogged(0) } })])
    expect(c.pending([])).toHaveLength(1)
    expect(answer(c).k).toBe('applied')
    expect(() => controller([question('q', undefined, { trigger: { op: 'num', v: 1 } })]).pending([])).toThrow('boolean')
  })

  it('detaches inputs and snapshots and replays typed answer events deterministically', () => {
    const q = question('q', { k: 'patch', ops: [setOp()] })
    q.choices[0].value = { v: 'enum', name: 'volume', tag: 'more' }
    const p = plan(), c = createOfflineQuestions(p, [], [q])
    p.slots.length = 0; q.choices[0].patch.ops.length = 0
    c.plan.slots.length = 0; c.pending([])[0].choices.length = 0
    const event = c.answer([], { question: 'question-q', occurrence: 'occurrence-q' }, { tag: 'more', name: 'volume', v: 'enum' }).event
    expect(rest(c)).toEqual([90, 90, 90])
    const original = question('q', { k: 'patch', ops: [setOp()] })
    original.choices[0].value = event.value
    const fresh = controller([original])
    expect(fresh.answer([], event, event.value).k).toBe('applied')
    expect(fresh.plan).toEqual(c.plan)
  })
})

const vectorPath = process.env.C2_VECTOR_PATH || new URL('./fixtures/question-patches.json', import.meta.url)
describe('authoritative Rust question-patches vectors', () => {
  it('checks every answer, pending list and final plan/live document for every case', () => {
    const vectors = JSON.parse(readFileSync(vectorPath, 'utf8'))
    expect(vectors.format).toBe('reppen.residual-vectors/1')
    expect(vectors.cases.length).toBeGreaterThan(0)
    for (const v of vectors.cases) {
      const c = createOfflineQuestions(v.plan, v.live, v.questions)
      const events = []
      // Reconstruct the fixture's server baseline without losing cleared history.
      for (const [slot, step, set] of v.ever) {
        events.push({ kind: 'setLogged', slot, step, set, values: {} }, { kind: 'setCleared', slot, step, set })
      }
      for (const [slot, steps] of Object.entries(v.logged)) for (const [step, sets] of Object.entries(steps)) for (const [set, values] of Object.entries(sets)) events.push({ kind: 'setLogged', slot, step, set: Number(set), values })
      const initialEvents = structuredClone(events)
      const accepted = []
      for (const [i, s] of v.steps.entries()) {
        if (s.event.kind === 'questionAnswered') {
          const before = { plan: c.plan, targets: c.targets, changed: c.changed }
          expect(c.answer(events, s.event, s.event.value).k, `${v.name} step ${i}`).toBe(s.outcome)
          if (s.outcome === 'applied') { events.push(s.event); accepted.push(s.event) }
          else expect({ plan: c.plan, targets: c.targets, changed: c.changed }).toEqual(before)
        } else { events.push(s.event); accepted.push(s.event) }
        if (s.pending) expect(c.pending(events).map(q => q.occurrence).sort(), `${v.name} pending ${i}`).toEqual([...s.pending].sort())
      }
      expect(c.plan, v.name).toEqual(v.final.plan)
      expect({ format: FORMAT, targets: c.targets }, v.name).toEqual(v.final.live)
      const fresh = createOfflineQuestions(v.plan, v.live, v.questions), prefix = [...initialEvents]
      for (const event of accepted) {
        if (event.kind === 'questionAnswered') expect(fresh.answer(prefix, event, event.value).k).toBe('applied')
        prefix.push(event)
      }
      expect(fresh.plan).toEqual(c.plan)
      expect(fresh.targets).toEqual(c.targets)
    }
  })
})
