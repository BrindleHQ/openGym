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

export const reppenAvailable = (config, user, { mobile = MOBILE, demo = DEMO, storage = globalThis.localStorage } = {}) => {
  if (mobile || demo || !user?.id) return false
  if (config != null) return config.reppen === true
  // During a complete outage the public config cannot be fetched. Only the
  // cached account's own enrollment may keep its already-enabled runner open.
  try {
    const kept = JSON.parse(storage.getItem(`reppen.offline.v1.${user.id}`))
    return !!(kept?.version === 1 && kept.owner === user.id && kept.data?.local?.enrollment)
  } catch { return false }
}

const tokens = tokenSource({ mint: () => api('/api/reppen/token', { method: 'POST' }) })

export const reppen = reppenClient({
  base: () => appBase().replace(/\/?$/, '/') + 'reppen/',
  token: opts => tokens.get(useStore.getState().user?.id, opts),
})

// Observe sign-out even when no Reppen screen is mounted; signing back into the same account
// must not revive an abandoned operation or leave its busy state behind.
useStore.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) reppenStore.getState().hydrate()
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
if (import.meta.hot) import.meta.hot.dispose(() => reppenStore.getState()._disposeOffline())
/** The Reppen store in a component, the way useStore is used everywhere else. */
export const useReppen = selector => useZustand(reppenStore, selector)
