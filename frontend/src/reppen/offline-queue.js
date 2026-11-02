// Durable per-account commands. The server remains the authority: locally
// finished workouts enter OpenGym history only after replay and verification.
import { ReppenError, isOffline } from './client.js'
import { createOfflineQuestions } from './offline-questions.js'
import { evaluateFinish, evaluateLiveTarget, nextWorkout, resolveLiveTargets } from './offline-finish.js'

const clone = x => structuredClone(x)
const key = owner => `reppen.offline.v1.${owner}`
const fault = (code, message) => new ReppenError(409, { error: code }, message)
const canonical = x => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)
const same = (a, b) => canonical(a) === canonical(b)
const planShape = plan => {
  const slots = clone(plan.slots)
  for (const slot of slots) delete slot.trace
  return { day: plan.day, defaultDay: plan.defaultDay, slots }
}
const eventsOf = s => {
  const events = [], seen = new Map()
  for (const e of [...(s.workout?.events || []), ...s.outbox]) {
    if (seen.has(e.id)) { if (!same(seen.get(e.id), e)) throw fault('offlineConflict', 'An entry changed while waiting to sync.'); continue }
    seen.set(e.id, e); events.push(e)
  }
  return events
}

export function offlineProjection(s) {
  const envelope = s.offlinePack, nodeIndex = s.offlineNode || 0
  if (!envelope || !s.workout || envelope.artifactId !== s.workout.artifactId || envelope.enrollmentId !== s.workout.enrollmentId
    || (nodeIndex === 0 && (envelope.workoutId !== s.workout.workoutId || envelope.workoutRevision > s.workout.revision))) return null
  const node = envelope.pack?.nodes?.[nodeIndex]
  if (!node) return null
  const events = eventsOf(s), basis = nodeIndex === 0 ? envelope.workoutRevision : 0
  const questions = createOfflineQuestions(node.plan, node.targets, node.occurrences)
  for (let i = basis; i < events.length; i++) {
    const e = events[i]
    if (e.kind !== 'questionAnswered') continue
    const result = questions.answer(events.slice(0, i), { question: e.question, occurrence: e.occurrence }, e.value)
    if (result.k !== 'applied') throw fault('needsConnection', result.reason || 'This answer needs a connection.')
  }
  const plan = resolveLiveTargets(questions.plan, questions.targets, events)
  const pending = questions.pending(events).map(q => ({ ...q, id: q.question }))
  let finish = pending.length ? { k: 'refused', code: 'questionsPending' }
    : questions.changed ? { k: 'needsConnection', reason: 'Connect to finish a workout whose answers changed its plan.' }
      : evaluateFinish(envelope.pack, nodeIndex, events, { allowQuestions: true })
  const next = nextWorkout(envelope.pack, nodeIndex, finish, events)
  return { plan, targets: questions.targets, pending, finish, next, ...(finish.k === 'finished' ? { offlineState: Object.fromEntries(finish.slots.map(v => [v.slot, v.state])) } : {}) }
}

export function withOfflineQueue(store, { client, owner, storage, today, newId, recordFinished }) {
  const base = store.getState()
  let who = null, loading = false, raw = null, replaying = null, finishing = null, reconciling = null, epoch = 0, release = null
  let ready = Promise.resolve(true), writable = true, persistError = null, unreadable = false, preparing = null
  const fields = ['local', 'workout', 'outbox', 'rejected', 'offlineComputed', 'offlinePack', 'finished', 'offlineJournal', 'offlineNext', 'offlineStart', 'offlineNode', 'offlineGeneration', 'offlineBlocked', 'offlineRecovery', 'offline']
  const snapshot = patch => {
    const state = { ...store.getState(), ...patch }
    return { version: 1, owner: who, data: Object.fromEntries(fields.map(f => [f, state[f] ?? null])) }
  }
  function write(patch = {}) {
    if (unreadable) throw persistError
    if (!who || owner() !== who || !writable) throw fault('offlineQueueBusy', 'This workout is open in another tab. Continue there.')
    try {
      if (storage.getItem(key(who)) !== raw) throw fault('offlineQueueBusy', 'This workout changed in another tab. Reload before continuing.')
      const next = JSON.stringify(snapshot(patch))
      storage.setItem(key(who), next)
      if (storage.getItem(key(who)) !== next) throw Error('Storage did not retain the workout')
      raw = next; persistError = null
    } catch (e) {
      persistError = e instanceof ReppenError ? e : fault('offlineStorage', 'This device could not save the workout. Free storage before continuing.')
      throw persistError
    }
  }
  function commit(patch) { write(patch); store.setState(patch) }
  const report = e => store.setState({ error: e })
  const queueProjection = state => {
    try { return offlineProjection(state) }
    catch (e) { if (e.code !== 'needsConnection') throw e; return null }
  }
  const project = () => {
    try {
      const state = store.getState(), p = queueProjection(state)
      if (p && state.workout) store.setState({ workout: { ...state.workout, effectivePlan: p.plan, pendingQuestions: p.pending } })
    } catch (e) { report(e) }
  }
  const empty = { offlineJournal: [], offlineComputed: [], offlineNext: null, offlineStart: null, offlineNode: 0, offlineGeneration: 0, offlineBlocked: null, offlineRecovery: [], offline: false }
  store.setState(empty)
  store.subscribe(() => {
    if (loading || !who || owner() !== who || store.getState().localOwner !== who || !writable || persistError) return
    try { write() } catch { /* New writes preflight storage; acknowledged server data can be re-fetched. */ }
  })
  async function ensure() {
    const account = owner()
    if (account !== who) store.getState().hydrate()
    if (!(await ready) || owner() !== account || account !== who) throw fault('offlineQueueBusy', 'This workout is open in another tab. Continue there.')
    write()
  }
  function hydrate() {
    const account = owner()
    if (account === who && store.getState().localOwner === account) { base.hydrate(); return }
    release?.(); release = null; epoch++; replaying = null; finishing = null; reconciling = null; persistError = null; unreadable = false
    loading = true; writable = false; who = account
    let saved = null
    try {
      raw = account ? storage.getItem(key(account)) : null
      saved = raw ? JSON.parse(raw) : null
      if (saved && (saved.version !== 1 || saved.owner !== account || !saved.data || !Array.isArray(saved.data.outbox) || !Array.isArray(saved.data.offlineJournal))) throw Error('Invalid offline journal')
    } catch { unreadable = true; persistError = fault('offlineStorage', 'Saved offline work could not be read. Keep this device open and recover it before continuing.'); saved = null }
    base.hydrate()
    const baseLocal = store.getState().local
    store.setState(empty)
    if (saved) {
      const local = { ...saved.data.local }
      // Either journal can retain the acknowledgment when the other's write fails.
      // Match it to the pending ID; never roll back an offline-advanced nextDay.
      if (baseLocal.enrollment?.enrollmentId && baseLocal.enrollment.enrollmentId === local.pendingEnrollment?.enrollmentId) {
        local.enrollment = baseLocal.enrollment
        local.nextDay = baseLocal.nextDay
      }
      // Pending requests are verified in the base journal before HTTP. Keep its
      // exact request unless the snapshot already records that enrollment's ACK.
      if (Object.hasOwn(baseLocal, 'pendingEnrollment')) local.pendingEnrollment = baseLocal.pendingEnrollment
      if (local.pendingEnrollment?.enrollmentId && local.pendingEnrollment.enrollmentId === local.enrollment?.enrollmentId) local.pendingEnrollment = null
      store.setState({ ...saved.data, local })
    }
    base._rememberPending(store.getState().outbox, store.getState().workout?.revision || 0)
    loading = false
    const generation = epoch
    if (account && globalThis.window && storage === globalThis.localStorage && globalThis.navigator?.locks) {
      ready = new Promise(resolve => {
        navigator.locks.request(key(account), { ifAvailable: true }, async lock => {
          if (!lock || generation !== epoch) { resolve(false); return }
          writable = true; resolve(true)
          await new Promise(done => { release = done })
        }).catch(() => resolve(false))
      })
    } else { writable = !!account; ready = Promise.resolve(writable) }
    project()
    if (persistError) report(persistError)
  }
  const withoutDraft = (rows, draft) => rows.filter(r => r.event.slot !== draft.event.slot || r.event.step !== draft.event.step || r.event.set !== draft.event.set)
  async function enqueue(event, draft = null) {
    const account = owner()
    try {
      await ensure()
      const s = store.getState()
      if (!s.workout || s.busy) return
      if (event.kind === 'questionAnswered' && s.outbox.some(e => e.kind === event.kind && e.question === event.question && e.occurrence === event.occurrence)) return
      if (eventsOf(s).length >= 500) throw fault('needsConnection', 'This workout has reached its entry limit. Connect before continuing.')
      const next = { id: newId(), ...event }
      const outbox = [...s.outbox, next]
      const before = queueProjection(s), computed = []
      if (event.kind === 'setLogged' && before) for (const target of before.targets) {
        if (target.slot !== event.slot || target.step !== event.step || target.set !== event.set || !Object.hasOwn(event.values, target.metric)) continue
        const value = evaluateLiveTarget(target, eventsOf(s))
        if (value.k === 'resolved') computed.push({ eventId: next.id, metric: target.metric, value: value.field })
      }
      // Connection-only rules still enqueue durably for the authoritative
      // server. They never apply a guessed plan or permit a local finish.
      const projected = queueProjection({ ...s, outbox })
      base._rememberPending([next], s.workout.revision)
      const rejected = event.kind === 'setLogged' || event.kind === 'setCleared'
        ? s.rejected.filter(r => !(r.code === 'setTaken' && r.event.slot === event.slot && r.event.step === event.step && r.event.set === event.set))
        : draft ? withoutDraft(s.rejected, draft) : s.rejected
      commit({ outbox, rejected, offlineComputed: [...(s.offlineComputed || []), ...computed], ...(projected ? { workout: { ...s.workout, effectivePlan: projected.plan, pendingQuestions: projected.pending } } : {}) })
      await store.getState().flush()
    } catch (e) { if (owner() === account) report(e) }
  }
  async function replay() {
    await ensure()
    const account = who, generation = epoch
    const mine = () => owner() === account && generation === epoch
    while (store.getState().offlineJournal.length) {
      const entry = store.getState().offlineJournal[0]
      let view = entry.start ? await client.startWorkout(entry.workoutId, entry.start) : await client.workout(entry.workoutId)
      if (!mine()) return false
      if (view.artifactId !== entry.artifactId || view.enrollmentId !== entry.enrollmentId) throw fault('offlineConflict', 'The server workout differs. Your offline entries are kept on this device.')
      if (entry.start && !same(planShape(view.plan), entry.initialPlan)) throw fault('offlineMismatch', 'The next workout differs from the prepared plan. Your entries are kept.')
      const wanted = new Map(entry.events.map(e => [e.id, e]))
      if ((view.events || []).some(e => !wanted.has(e.id) || !same(wanted.get(e.id), e))) throw fault('offlineConflict', 'Another device changed this workout. Your offline entries are kept.')
      const accepted = new Set((view.events || []).map(e => e.id))
      const pending = entry.events.filter(e => !accepted.has(e.id))
      if (pending.length) {
        const claims = (entry.offlineComputed || []).filter(c => pending.some(e => e.id === c.eventId))
        view = await client.appendEvents(entry.workoutId, view.revision, pending, ...(claims.length ? [claims] : []))
      }
      if (!mine()) return false
      const result = await client.finish(entry.workoutId, view.revision, entry.offlineState)
      if (!mine()) return false
      try { recordFinished(result, { title: entry.title, names: entry.names }) } catch { throw fault('offlineStorage', 'The verified workout could not be added to history. Retry sync.') }
      const s = store.getState()
      commit({ offlineJournal: s.offlineJournal.slice(1), ...(s.finished?.workout?.workoutId === entry.workoutId ? { finished: result } : {}) })
    }
    const s = store.getState()
    if (s.offlineStart && s.workout) {
      const view = await client.startWorkout(s.workout.workoutId, s.offlineStart.body)
      if (!mine()) return false
      if (!same(planShape(view.plan), s.offlineStart.plan)) throw fault('offlineMismatch', 'The server prescribed a different workout. Your offline entries are kept.')
      base._rememberPending(s.outbox, view.revision)
      commit({ workout: view, offlineStart: null })
      await base.flush()
      project()
    }
    return true
  }
  async function flush() {
    if (replaying) return replaying
    const account = owner()
    const run = async () => {
      try {
        await ensure()
        if (store.getState().offlineBlocked) return false
        if (store.getState().offlineJournal.length || store.getState().offlineStart) await replay()
        await base.flush()
        if (owner() !== account) return false
        project()
        const error = store.getState().error
        store.setState({ offline: isOffline(error) })
        return !error && !store.getState().outbox.length
      } catch (e) {
        if (owner() === account) {
          const offline = isOffline(e)
          store.setState({ error: e, offline, ...(!offline && [409, 422].includes(e.status) && e.code !== 'offlineQueueBusy' && e.code !== 'offlineStorage' ? { offlineBlocked: { code: e.code, message: e.message } } : {}) })
        }
        return false
      }
    }
    replaying = run().finally(() => { if (owner() === account) replaying = null })
    return replaying
  }
  async function localFinish() {
    await ensure()
    const s = store.getState(), p = offlineProjection(s)
    if (s.offlineBlocked) throw fault('offlineConflict', 'Connect to resolve the saved offline work before continuing.')
    if (!p || p.finish.k === 'needsConnection') throw fault('needsConnection', p?.finish.reason || 'Connect to prepare this workout for offline use.')
    if (p.finish.k !== 'finished') throw new ReppenError(422, { error: 'refused', code: p.finish.code })
    const node = s.offlinePack.pack.nodes[s.offlineNode || 0]
    const entry = { workoutId: s.workout.workoutId, artifactId: s.workout.artifactId, enrollmentId: s.workout.enrollmentId,
      events: eventsOf(s), offlineComputed: s.offlineComputed || [], offlineState: p.offlineState, start: s.offlineStart?.body || null, initialPlan: planShape(node.plan),
      title: s.local.enrollment?.title, names: Object.fromEntries((p.plan.slots || []).map(v => [v.exercise?.id, s.exerciseNames?.[v.exercise?.id] || v.exercise?.label || v.exercise?.id])) }
    const next = { envelope: s.offlinePack, node: p.next.node, result: p.next, generation: (s.offlineGeneration || 0) + 1,
      enrollmentRevision: s.offlinePack.enrollmentRevision + (s.offlineGeneration || 0) + 1 }
    commit({ offlineJournal: [...s.offlineJournal, entry], offlineNext: next, offlineStart: null, workout: null, outbox: [], offlineComputed: [], held: null, error: null, offline: true,
      local: { ...s.local, workoutId: null, nextDay: p.next.plan?.day || s.workout.plan.defaultDay },
      finished: { workout: { ...s.workout, events: entry.events }, offline: true, progression: p.finish, next: p.next } })
    return true
  }
  async function start(day) {
    const account = owner()
    try {
      await ensure()
      if (store.getState().offlineBlocked) throw fault('offlineConflict', 'Connect to resolve the saved offline work before continuing.')
      if (store.getState().offlineJournal.length) await flush()
      if (!store.getState().offlineJournal.length && await base.start(day)) {
        commit({ offline: false, offlineComputed: [], offlineStart: null, offlinePack: null, offlineNext: null, offlineNode: 0, offlineGeneration: 0 })
        return true
      }
      const s = store.getState(), next = s.offlineNext
      if (!isOffline(s.error) || !next) return false
      if (next?.result.k !== 'workout' || next.result.plan.day !== day) throw fault('needsConnection', next?.result.reason || 'Connect to prepare this next workout.')
      const body = { enrollmentId: s.local.enrollment.enrollmentId, enrollmentRevision: next.enrollmentRevision, localDay: today(), day }
      const pending = s.local.pendingStart
      if (pending && !same(pending.body, body)) throw fault('needsConnection', 'The enrollment changed before this start. Reconnect before continuing.')
      const workoutId = pending?.workoutId || newId(), plan = clone(next.result.plan)
      commit({ workout: { workoutId, artifactId: next.envelope.artifactId, enrollmentId: body.enrollmentId, localDay: body.localDay, day, revision: 0, eventCount: 0, status: 'active', active: true, plan, effectivePlan: plan, events: [], pendingQuestions: [] },
        outbox: [], offlineComputed: [], rejected: [], finished: null, held: null, busy: false, error: null, offline: true,
        offlinePack: next.envelope, offlineNode: next.node, offlineGeneration: next.generation, offlineNext: null, offlineStart: { body, plan },
        local: { ...s.local, pendingStart: null, workoutId } })
      project()
      return true
    } catch (e) { if (owner() === account) report(e); return false }
  }
  async function finishOnce() {
    const account = owner()
    try {
      await ensure()
      const s = store.getState()
      if (s.offlineStart || s.offlineJournal.length) { if (!(await flush())) return isOffline(store.getState().error) ? await localFinish() : false }
      const prior = store.getState(), p = queueProjection(prior)
      if (await base.finish()) {
        if (p?.finish.k === 'finished') commit({ offlineNext: { envelope: prior.offlinePack, node: p.next.node, result: p.next, generation: (prior.offlineGeneration || 0) + 1, enrollmentRevision: prior.offlinePack.enrollmentRevision + (prior.offlineGeneration || 0) + 1 } })
        return true
      }
      if (isOffline(store.getState().error)) return await localFinish()
      return false
    } catch (e) { if (owner() === account) report(e); return false }
  }
  function finish() {
    if (finishing) return finishing
    const promise = finishOnce().finally(() => { if (finishing === promise) finishing = null })
    finishing = promise
    return promise
  }
  store.setState({
    hydrate, flush, start, finish,
    // Explicit user reconciliation preserves the complete local journal as a
    // downloadable recovery copy before adopting the server's actual workout.
    reconcileOffline() {
      if (reconciling) return reconciling
      const account = owner()
      const run = async () => {
        try {
          await ensure()
          const generation = epoch
          const s = store.getState(), id = s.offlineJournal[0]?.workoutId || s.workout?.workoutId
          if (!s.offlineBlocked || !id) return false
          const view = await client.workout(id)
          const current = store.getState()
          if (owner() !== account || epoch !== generation || current.offlineBlocked !== s.offlineBlocked) return false
          const completed = view.status === 'completed'
          const days = current.local.enrollment?.days || [], index = days.indexOf(view.day)
          const recovery = snapshot().data
          delete recovery.offlineRecovery
          commit({ ...empty, offlineRecovery: [...(current.offlineRecovery || []), recovery],
            local: { ...current.local, workoutId: completed ? null : id, pendingStart: null, nextDay: days[(index + 1) % days.length] || current.local.nextDay },
            workout: completed ? null : view, outbox: [], rejected: [], offlinePack: null,
            finished: completed ? { workout: view, completed: view.completed } : null, error: null,
          })
          if (completed) recordFinished(view, { title: current.local.enrollment?.title, names: current.exerciseNames })
          return true
        } catch (e) { if (owner() === account) report(e); return false }
      }
      const promise = run().finally(() => { if (reconciling === promise) reconciling = null })
      reconciling = promise
      return promise
    },
    offlineRecoveryData() {
      const s = store.getState()
      return { format: 'reppen.offline-recovery/1', owner: who, current: snapshot().data, recovered: s.offlineRecovery || [] }
    },
    async resume() {
      try { await ensure() } catch (e) { report(e); return store.getState().workout }
      if (store.getState().offlineStart || store.getState().offlineJournal.length) { await flush(); return store.getState().workout }
      const answer = await base.resume(); project(); return answer || store.getState().workout
    },
    async catchUp() { if (store.getState().offlineJournal.length || store.getState().offlineStart) return flush(); await base.catchUp(); project() },
    loadOfflinePack() {
      if (store.getState().offlineStart || store.getState().offlineJournal.length) return Promise.resolve(store.getState().offlinePack)
      const s = store.getState(), id = s.workout?.workoutId
      if (!id) return Promise.resolve(null)
      if (s.offlinePack?.workoutId === id) return Promise.resolve(s.offlinePack)
      if (preparing?.id === id) return preparing.promise
      const promise = base.loadOfflinePack().then(pack => {
        if (pack) { store.setState({ offlineNode: 0, offlineGeneration: 0 }); project() }
        return pack
      }).finally(() => { if (preparing?.promise === promise) preparing = null })
      preparing = { id, promise }
      return promise
    },
    previewOfflineFinish() {
      try { const p = offlineProjection(store.getState()); return p ? { finish: p.finish, next: p.next, offlineState: p.offlineState } : { finish: { k: 'needsConnection', reason: 'No current offline pack' } } }
      catch (e) { return { finish: { k: 'needsConnection', reason: e.message } } }
    },
    logSet(slot, step, set, values) { return enqueue({ kind: 'setLogged', slot, step, set, values }) },
    clearSet(slot, step, set) { return enqueue({ kind: 'setCleared', slot, step, set }) },
    relogDraft(draft) { const { id, ...event } = draft.event; return enqueue(event, draft) },
    discardDraft(draft) { try { commit({ rejected: withoutDraft(store.getState().rejected, draft) }) } catch (e) { report(e) } },
    dismissRejected() { try { const s = store.getState(); commit({ rejected: s.workout ? s.rejected.filter(r => r.code === 'setTaken') : [] }) } catch (e) { report(e) } },
    answer(question, choice) { return enqueue({ kind: 'questionAnswered', question: question.id || question.question, occurrence: question.occurrence, value: choice.value }) },
    _persistLocal(local) { write({ local }) },
    async enroll(...args) {
      try {
        await ensure()
        if (store.getState().offlineJournal.length || store.getState().outbox.length) throw fault('offlineConflict', 'Sync the saved workout before changing programs.')
        return base.enroll(...args)
      } catch (e) { report(e); return false }
    },
    async continueActive() {
      try {
        await ensure()
        if (store.getState().offlineJournal.length || store.getState().outbox.length) throw fault('offlineConflict', 'Sync or reconcile the saved workout before switching workouts.')
        return base.continueActive()
      } catch (e) { report(e) }
    },
    async continueHeld() {
      try {
        await ensure()
        if (store.getState().offlineJournal.length || store.getState().outbox.length) throw fault('offlineConflict', 'Sync or reconcile the saved workout before switching workouts.')
        return base.continueHeld()
      } catch (e) { report(e) }
    },
    _disposeOffline() { release?.(); writable = false; epoch++ },
  })
  return store
}
