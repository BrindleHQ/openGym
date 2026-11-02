/* The Reppen API, as the app calls it: on this app's own origin under /reppen (a proxy strips the
 * prefix and forwards to the Reppen service), with a Bearer token from tokenSource (token.js).
 *
 * Every answer is JSON. A refusal becomes a ReppenError carrying the API's error code
 * (`revisionConflict`, `refused`, `activeWorkoutExists`, ...) and the whole body, so a caller can
 * act on the details (the current revision of a conflict, the refusal's own code). A request that
 * never got an answer is a ReppenError with status 0 and code `offline`.
 *
 * Writes are plain requests that a caller may repeat: every one is idempotent on the Reppen side
 * (client-chosen enrollment and workout ids, event ids, finish at a revision), so the same call
 * can later come from a queue of commands without changing here.
 */

const TIMEOUT_GET_MS = 20000
const TIMEOUT_MS = 60000

export class ReppenError extends Error {
  constructor(status, body, message) {
    const code = body && typeof body.error === 'string' ? body.error : status === 0 ? 'offline' : 'http' + status
    super(message || (body && (body.reason || body.code)) || code)
    this.name = 'ReppenError'
    this.status = status
    this.code = code
    this.body = body || {}
  }
}

/** The refusal's own code for a 422 `refused` (`questionsPending`, `emptySession`), else null. */
export const refusalOf = e => (e instanceof ReppenError && e.code === 'refused' ? e.body.code || e.body.reason || 'refused' : null)
/** The workout moved on under this device: refetch, then resend what is still unsent. */
export const isRevisionConflict = e => e instanceof ReppenError && e.code === 'revisionConflict'
export const isOffline = e => e instanceof ReppenError && e.status === 0

const seg = s => encodeURIComponent(String(s))

/**
 * @param {{ base: () => string, token: (opts?: { fresh?: boolean }) => Promise<string>, fetch?: typeof fetch }} deps
 *   `base` is the URL Reppen is reached at, ending in "/" (e.g. "/reppen/").
 */
export function reppenClient({ base, token, fetch: doFetch = (...a) => globalThis.fetch(...a) }) {
  async function once(method, path, body, bearer) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), method === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_MS)
    let r
    try {
      r = await doFetch(base() + 'v1/' + path, {
        method,
        headers: { Authorization: 'Bearer ' + bearer, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        credentials: 'omit',   // Reppen takes the Bearer only, never this origin's cookies
      })
    } catch {
      throw new ReppenError(0, null, 'Reppen could not be reached')
    } finally { clearTimeout(timer) }
    let data = null
    try { data = await r.json() } catch { /* not JSON: someone else's answer, judged below */ }
    if (!r.ok) throw new ReppenError(r.status, data && typeof data === 'object' ? data : null)
    if (!data || typeof data !== 'object') throw new ReppenError(r.status, null, 'Reppen answered with something other than JSON')
    return data
  }

  // A token refused (expired early, a key rotated) is replaced once; a second 401 is the answer.
  async function call(method, path, body) {
    try { return await once(method, path, body, await token()) }
    catch (e) {
      if (!(e instanceof ReppenError) || e.status !== 401) throw e
      return once(method, path, body, await token({ fresh: true }))
    }
  }

  return {
    catalog: (cursor = null) => call('GET', 'program-catalog?limit=100' + (cursor ? '&cursor=' + seg(cursor) : '')),
    enrollment: id => call('GET', 'enrollments/' + seg(id)),
    /** @param {{ artifactId: string, startOn: string, params?: object, readings?: object[] }} body */
    enroll: (id, body) => call('PUT', 'enrollments/' + seg(id), body),
    workout: id => call('GET', 'workouts/' + seg(id)),
    /** @param {{ enrollmentId: string, enrollmentRevision: number, localDay: string, day: string }} body */
    startWorkout: (id, body) => call('PUT', 'workouts/' + seg(id), body),
    appendEvents: (id, expectedRevision, events) => call('POST', 'workouts/' + seg(id) + '/events', { expectedRevision, events }),
    finish: (id, expectedRevision) => call('POST', 'workouts/' + seg(id) + '/finish', { expectedRevision }),
    activate: (id, replaces) => call('POST', 'workouts/' + seg(id) + '/activate', { replaces: replaces ?? null }),
    history: (cursor = null) => call('GET', 'history?limit=50' + (cursor ? '&cursor=' + seg(cursor) : '')),
  }
}
