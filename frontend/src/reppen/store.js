/* What the Reppen screens know: the program catalog, the account's enrollment, and where it
 * stands. Reppen is the authority on all of it; this keeps only what the API has no route to
 * look up, in this browser, per account (`reppen.v1.<account>` in localStorage):
 *
 *   enrollment  the enrolled program: ids, title and the program's days
 *   nextDay     the day to train next (Reppen does not say yet; see suggestNextDay)
 *   workoutId   the workout in progress, if any
 *   pendingStart a start sent but not yet answered: { workoutId, body }
 *
 * A workout is changed only through event batches with ids made here. Events wait in `outbox`
 * until Reppen has accepted them; `flush` sends them at the revision last seen and, when the
 * workout moved on (another device, a lost answer), fetches it, drops what Reppen already holds
 * and sends the rest. The outbox lives in memory for now; a stored command queue for offline
 * use replaces it without changing the actions the screens call.
 *
 * Ids the client chooses (enrollment, workout, event) are UUIDs, made before the request is
 * sent and kept with it, so a request repeated after a lost answer is the same request.
 */
import { createStore } from 'zustand/vanilla'
import { isRevisionConflict } from './client.js'

const KEY = owner => 'reppen.v1.' + owner

export function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The day after `day` in the program's own order, wrapping round; the program's default when unknown. */
export function suggestNextDay(days, day, fallback) {
  const i = Array.isArray(days) ? days.indexOf(day) : -1
  return i < 0 ? (fallback ?? days?.[0] ?? null) : days[(i + 1) % days.length]
}

/** The value Reppen takes for a mass reading entered in kilograms. */
export const massReading = (reading, kg, observedOn) =>
  ({ fact: reading.fact, ...(reading.key ? { key: reading.key } : {}), observedOn, value: { v: 'q', n: kg, dim: { mass: 1 }, unit: 'kg' } })

/** The readings a catalog entry asks for that this form can collect: masses. */
export const massReadings = entry => (entry?.readings || []).filter(r => r?.type?.t === 'q' && r.type.dim?.mass === 1)

/** The parameters a program needs a value for that this form cannot ask: the non-optional ones. */
export const unaskedParameters = entry => (entry?.parameters || []).filter(p => p?.type?.t !== 'opt')

/** Every optional parameter, declared empty. Reppen refuses an enrollment that leaves one out. */
export const emptyParams = entry => Object.fromEntries((entry?.parameters || []).filter(p => p?.type?.t === 'opt')
  .map(p => [p.name, { v: 'none', cause: { k: 'declaredNone' } }]))

function readLocal(storage, owner) {
  try { return JSON.parse(storage.getItem(KEY(owner))) || {} } catch { return {} }
}

/**
 * @param {{ client: ReturnType<import('./client.js').reppenClient>, owner: () => string|null|undefined,
 *   storage?: Storage, today: () => string }} deps
 */
export function createReppenStore({ client: direct, owner, storage = globalThis.localStorage, today }) {
  // An answer that arrives after the account changed belongs to nobody here: its promise never
  // settles, so nothing after it runs, and one account's enrollment or workout cannot be written
  // into another's state or storage. hydrate() resets what such an action left in flight.
  const client = new Proxy(direct, {
    get: (target, name) => (...args) => {
      const who = owner()
      const mine = () => owner() === who
      return target[name](...args).then(r => (mine() ? r : new Promise(() => {})), e => (mine() ? Promise.reject(e) : new Promise(() => {})))
    },
  })
  const store = createStore((set, get) => {
    const save = patch => {
      const who = owner()
      const local = { ...get().local, ...patch }
      try { storage.setItem(KEY(who), JSON.stringify(local)) } catch { /* private mode: kept for this page only */ }
      set({ local, localOwner: who })
    }
    let again = false
    function enqueue(event) {
      if (!get().workout) return Promise.resolve()
      set({ outbox: [...get().outbox, { id: newId(), ...event }] })
      return get().flush()
    }
    // A refused batch: true when the outbox was put right and can be sent again.
    async function recover(e) {
      const id = get().workout.workoutId
      if (isRevisionConflict(e)) {
        // Fetch what Reppen holds; events of ours already among them were accepted (a lost answer).
        const view = await client.workout(id).catch(() => null)
        if (!view) return false
        const held = new Set((view.events || []).map(ev => ev.id))
        set({ workout: view, outbox: get().outbox.filter(ev => !held.has(ev.id)) })
        return true
      }
      // One event Reppen will not take (a set another device logged first, a question no longer
      // open): it leaves the outbox as a rejected draft, and the rest go again.
      const bad = e.body?.eventId
      if (bad && ['eventConflict', 'invalidEvent', 'unsupportedEvent'].includes(e.code)) {
        const ev = get().outbox.find(x => x.id === bad)
        if (!ev) return false
        const view = await client.workout(id).catch(() => null)
        set({ outbox: get().outbox.filter(x => x.id !== bad), rejected: [...get().rejected, { event: ev, code: e.code }], ...(view ? { workout: view } : {}) })
        return true
      }
      return false
    }
    return {
      local: {},
      localOwner: null,
      catalog: null,          // catalog entries, once loaded
      enrollmentView: null,   // GET /v1/enrollments/{id}
      error: null,            // the last failure, a ReppenError
      busy: false,
      workout: null,          // the workout view, as Reppen last answered it
      outbox: [],             // events not yet accepted, in order
      rejected: [],           // events Reppen refused: shown so the person can log them again
      held: null,             // an activeWorkoutExists answer to a start: { active, held }
      finished: null,         // the finish answer of the workout just finished
      flushing: false,
      history: null,

      /** Loads this account's pointers; call on every screen mount (the account may have changed). */
      hydrate() {
        const who = owner()
        if (get().localOwner === who) return
        set({ local: who ? readLocal(storage, who) : {}, localOwner: who, enrollmentView: null, error: null, busy: false,
          workout: null, outbox: [], rejected: [], held: null, finished: null, history: null, flushing: false })
      },

      async loadCatalog() {
        try {
          const items = []
          let cursor = null
          do {
            const page = await client.catalog(cursor)
            items.push(...(page.items || []))
            cursor = page.nextCursor
          } while (cursor)
          set({ catalog: items, error: null })
        } catch (e) { set({ error: e }) }
      },

      async loadEnrollment() {
        const id = get().local.enrollment?.enrollmentId
        if (!id) return null
        try {
          const view = await client.enrollment(id)
          set({ enrollmentView: view, error: null })
          return view
        } catch (e) { set({ error: e }); return null }
      },

      /** Enrolls in a catalog program with the readings it asks for ({ [reading index]: kg }). */
      async enroll(entry, kgByReading) {
        if (get().busy) return false
        const day = today()
        const readings = massReadings(entry).map((r, i) => kgByReading[i] > 0 ? massReading(r, kgByReading[i], day) : null).filter(Boolean)
        // Kept before the request: a retry after a lost answer repeats it with the same id.
        const pending = get().local.pendingEnrollment?.artifactId === entry.artifactId ? get().local.pendingEnrollment : { enrollmentId: newId(), artifactId: entry.artifactId }
        save({ pendingEnrollment: pending })
        set({ busy: true, error: null })
        try {
          const view = await client.enroll(pending.enrollmentId, { artifactId: entry.artifactId, startOn: day, params: emptyParams(entry), readings })
          save({
            pendingEnrollment: null,
            enrollment: { enrollmentId: pending.enrollmentId, artifactId: entry.artifactId, catalogId: entry.catalogId, title: entry.title, days: entry.days || [], defaultDay: entry.defaultDay ?? null },
            nextDay: entry.defaultDay ?? entry.days?.[0] ?? null,
          })
          set({ enrollmentView: view })
          return true
        } catch (e) { set({ error: e }); return false }
        finally { set({ busy: false }) }
      },

      chooseDay(day) { save({ nextDay: day }) },

      /** Starts the next workout on `day`, or repeats a start whose answer was lost. */
      async start(day) {
        const enrollment = get().local.enrollment
        if (!enrollment || get().busy) return false
        set({ busy: true, error: null, held: null, finished: null })
        try {
          const current = await client.enrollment(enrollment.enrollmentId)
          const body = { enrollmentId: enrollment.enrollmentId, enrollmentRevision: current.revision, localDay: today(), day }
          const prev = get().local.pendingStart
          const same = prev && JSON.stringify(prev.body) === JSON.stringify(body)
          const pending = same ? prev : { workoutId: newId(), body }
          save({ pendingStart: pending })
          try {
            const view = await client.startWorkout(pending.workoutId, body)
            save({ pendingStart: null, workoutId: view.workoutId })
            set({ workout: view, outbox: [], rejected: [] })
            return true
          } catch (e) {
            // Another workout holds the active place (another device, a lost pointer): this one is
            // stored as held. The person chooses which to keep (continueActive / continueHeld).
            if (e.code === 'activeWorkoutExists') { save({ pendingStart: null, workoutId: pending.workoutId }); set({ held: e.body }); return false }
            throw e
          }
        } catch (e) { set({ error: e }); return false }
        finally { set({ busy: false }) }
      },

      /** After a start found another active workout: carry on with that one. */
      async continueActive() {
        const active = get().held?.active?.workoutId
        if (!active) return
        save({ workoutId: active })
        set({ held: null })
        await get().resume()
      },

      /** After a start found another active workout: make the new one active in its place. */
      async continueHeld() {
        const { held } = get()
        if (!held?.held?.workoutId) return
        try {
          const view = await client.activate(held.held.workoutId, held.active?.workoutId ?? null)
          save({ workoutId: view.workoutId })
          set({ held: null, workout: view, outbox: [], rejected: [], error: null })
        } catch (e) { set({ error: e }) }
      },

      /** Fetches the workout in progress; forgets it once it is finished or gone. */
      async resume() {
        const id = get().local.workoutId
        if (!id) return null
        try {
          const view = await client.workout(id)
          if (view.status === 'completed') { save({ workoutId: null }); set({ workout: null }); return null }
          set({ workout: view, error: null })
          return view
        } catch (e) {
          if (e.code === 'workoutNotFound') { save({ workoutId: null }); set({ workout: null }) }
          set({ error: e })
          return null
        }
      },

      logSet(slot, step, index, values) { return enqueue({ kind: 'setLogged', slot, step, set: index, values }) },
      clearSet(slot, step, index) { return enqueue({ kind: 'setCleared', slot, step, set: index }) },
      /** `question` is one of the workout's pendingQuestions; the occurrence goes back as Reppen sent it. */
      answer(question, choice) { return enqueue({ kind: 'questionAnswered', question: question.id, occurrence: question.occurrence, value: choice.value }) },
      dismissRejected() { set({ rejected: [] }) },

      /** Sends the outbox. One run at a time; a call during a run makes the run go round again. */
      async flush() {
        if (get().flushing) { again = true; return }
        set({ flushing: true })
        try {
          let tries = 0
          do {
            again = false
            while (get().outbox.length && get().workout && tries < 5) {
              tries++
              const batch = get().outbox
              const { workoutId, revision } = get().workout
              try {
                const view = await client.appendEvents(workoutId, revision, batch)
                const sent = new Set(batch.map(e => e.id))
                set({ workout: view, outbox: get().outbox.filter(e => !sent.has(e.id)), error: null })
              } catch (e) {
                if (!(await recover(e))) { set({ error: e }); return }
              }
            }
          } while (again)
        } finally { set({ flushing: false }) }
      },

      async finish() {
        if (get().busy) return false
        set({ busy: true, error: null })
        try {
          await get().flush()
          const { workout, outbox } = get()
          if (!workout || outbox.length) return false
          for (let tries = 0; ; tries++) {
            try {
              const result = await client.finish(workout.workoutId, get().workout.revision)
              const { enrollment } = get().local
              save({ workoutId: null, nextDay: suggestNextDay(enrollment?.days, result.workout?.day ?? workout.day, enrollment?.defaultDay) })
              set({ workout: null, finished: result })
              return true
            } catch (e) {
              if (!isRevisionConflict(e) || tries >= 2) throw e
              set({ workout: await client.workout(workout.workoutId) })
            }
          }
        } catch (e) { set({ error: e }); return false }
        finally { set({ busy: false }) }
      },

      async loadHistory() {
        try { set({ history: (await client.history()).items || [], error: null }) }
        catch (e) { set({ error: e }) }
      },
    }
  })
  return store
}
