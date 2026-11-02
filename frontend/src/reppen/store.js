/* What the Reppen screens know: the program catalog, the account's enrollment, and where it
 * stands. Reppen is the authority on all of it; this keeps only what the API has no route to
 * look up, in this browser, per account (`reppen.v1.<account>` in localStorage):
 *
 *   enrollment  the enrolled program: ids, title and the program's days
 *   nextDay     the day to train next (Reppen does not say yet; see suggestNextDay)
 *
 * Ids the client chooses (enrollment, workout, event) are UUIDs, made before the request is
 * sent and kept with it, so a request repeated after a lost answer is the same request.
 */
import { createStore } from 'zustand/vanilla'

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
    return {
      local: {},
      localOwner: null,
      catalog: null,          // catalog entries, once loaded
      enrollmentView: null,   // GET /v1/enrollments/{id}
      error: null,            // the last failure, a ReppenError
      busy: false,

      /** Loads this account's pointers; call on every screen mount (the account may have changed). */
      hydrate() {
        const who = owner()
        if (get().localOwner === who) return
        set({ local: who ? readLocal(storage, who) : {}, localOwner: who, enrollmentView: null, error: null, busy: false })
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
    }
  })
  return store
}
