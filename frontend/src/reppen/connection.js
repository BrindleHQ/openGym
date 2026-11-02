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
import { createReppenStore } from './store.js'
import { addManaged, hasManaged, managedWorkout } from './history.js'
import { useStore as useZustand } from 'zustand'
import { todayISO } from '../lib/format.js'

export const reppenAvailable = (config, user, { mobile = MOBILE, demo = DEMO } = {}) =>
  !mobile && !demo && !!(config?.reppen === true && user?.id)

const tokens = tokenSource({ mint: () => api('/api/reppen/token', { method: 'POST' }) })

export const reppen = reppenClient({
  base: () => appBase().replace(/\/?$/, '/') + 'reppen/',
  token: opts => tokens.get(useStore.getState().user?.id, opts),
})

// A finished Reppen workout goes into this profile's history once (history.js). Checked before
// update(), so a delivery that finds it already there changes nothing and pushes nothing.
function recordFinished(result, { title, names }) {
  const { S, update } = useStore.getState()
  const id = (result?.workout || result)?.workoutId
  if (!S || !id || hasManaged(S, id)) return
  const made = managedWorkout(result, { title, names, unit: S.unit })
  if (made) update(s => { addManaged(s, made) })
}

export const reppenStore = createReppenStore({ client: reppen, owner: () => useStore.getState().user?.id, today: todayISO, recordFinished })
/** The Reppen store in a component, the way useStore is used everywhere else. */
export const useReppen = selector => useZustand(reppenStore, selector)
