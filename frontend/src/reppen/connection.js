// The app's one Reppen client: same origin under /reppen/, tokens minted by this server for the
// signed-in account. Shown only where it can work: a signed-in browser on an instance that has
// Reppen on (GET /api/config `reppen`). The phone apps talk to their paired server from another
// origin, and the demo and guests have no account to mint a token for.
import { api, appBase } from '../lib/api.js'
import { MOBILE } from '../lib/mobile.js'
import { DEMO } from '../lib/demo.js'
import { useStore } from '../store/useStore.js'
import { tokenSource } from './token.js'
import { reppenClient } from './client.js'

export const reppenAvailable = (config, user, { mobile = MOBILE, demo = DEMO } = {}) =>
  !mobile && !demo && !!(config?.reppen === true && user?.id)

const tokens = tokenSource({ mint: () => api('/api/reppen/token', { method: 'POST' }) })

export const reppen = reppenClient({
  base: () => appBase().replace(/\/?$/, '/') + 'reppen/',
  token: opts => tokens.get(useStore.getState().user?.id, opts),
})
