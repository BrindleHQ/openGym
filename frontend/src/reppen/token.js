/* Reppen access tokens. This server mints them (POST /api/reppen/token, api/reppen.js) for the
 * signed-in session; the app keeps the current one in memory only and sends it to Reppen as a
 * Bearer. Reppen never sees the session cookie.
 *
 * A token lives a few minutes. It is reused until shortly before it expires, then a new one is
 * asked for; callers that ask at the same moment share one request. The expiry is measured on
 * this device's clock from the token's own lifetime (exp - iat), so a phone whose clock is off by
 * minutes neither reuses a dead token nor asks for a new one on every request.
 *
 * A token belongs to the account it was minted for: asking for another account's token (a
 * sign-out and a different sign-in on this page) never returns the cached one.
 */

const EARLY_MS = 30000

// The token's lifetime in seconds, from its claims; null when it cannot be read.
function lifetimeS(token) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)))
    const s = claims.exp - claims.iat
    return Number.isFinite(s) && s > 0 ? s : null
  } catch { return null }
}

/**
 * @param {{ mint: () => Promise<{ token: string, expiresAt: number }>, now?: () => number }} deps
 * @returns {{ get: (owner: string, opts?: { fresh?: boolean }) => Promise<string>, clear: () => void }}
 */
export function tokenSource({ mint, now = () => Date.now() }) {
  let cached = null     // { owner, token, until }: `until` on this device's clock
  let pending = null    // { owner, promise }

  function fetchFor(owner) {
    const started = now()
    const promise = Promise.resolve().then(mint).then(answer => {
      if (!answer || typeof answer.token !== 'string' || !answer.token) throw new Error('no Reppen token in the answer')
      const life = lifetimeS(answer.token)
      // Without readable claims, trust expiresAt (seconds) as a last resort.
      const until = life != null ? started + life * 1000 : Number(answer.expiresAt) * 1000
      if (pending?.promise === promise) cached = { owner, token: answer.token, until }
      return answer.token
    }).finally(() => { if (pending?.promise === promise) pending = null })
    pending = { owner, promise }
    return promise
  }

  return {
    async get(owner, { fresh = false } = {}) {
      if (!owner) throw new Error('not signed in')
      if (cached && cached.owner !== owner) cached = null
      if (!fresh && cached && cached.until - EARLY_MS > now()) return cached.token
      if (pending && pending.owner === owner && !fresh) return pending.promise
      return fetchFor(owner)
    },
    clear() { cached = null; pending = null },
  }
}
