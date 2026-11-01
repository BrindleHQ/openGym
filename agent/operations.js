import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { EXIDX, canonicalExId, registerCustom, isHold, isCardio, searchExercises as catalogSearch } from '../frontend/src/lib/exercises.js'
import { buildSessionEntries } from '../frontend/src/lib/session-start.js'
import { convertWeight } from '../frontend/src/lib/units.js'
import { apiFetch } from '../mcp/src/api-client.js'
import { keepUnknown } from '../api/sync-stamps.js'

export function fail(code, message) { return Object.assign(new Error(message), { code }) }
function check(ok, message) { if (!ok) throw fail('EINVAL', message) }
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function keys(v, allowed, label) {
  check(object(v), `${label} must be an object`)
  for (const k of Object.keys(v)) check(allowed.includes(k), `${label}: unknown field ${k}`)
}
function number(v, min, max, label, integer = false) {
  check(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max && (!integer || Number.isInteger(v)), `${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`)
}
function text(v, max, label) { check(typeof v === 'string' && v.trim().length > 0 && v.length <= max, `${label} must be nonempty text, at most ${max} characters`); return v }
function unit(v) { check(v === 'kg' || v === 'lb', 'unit must be kg or lb'); return v }
function exercise(id, state) {
  const canonical = canonicalExId(id)
  const ex = (state.customEx || []).find(e => e.id === id) || EXIDX[canonical]
  check(ex, `unknown exercise ${id}; use exercises search to find an ID`)
  check(!isHold(id) && !isCardio(id) && ex.cat !== 'cardio', `exercise ${id}: only rep-based routines are supported in this version`)
  return { ex, id: ex.custom ? id : canonical }
}
function validateExercise(e, state, from) {
  keys(e, ['id','sets','reps','repsMin','weight','restSec','prog','inc','dbLoad','bodyweight','note'], 'exercise')
  text(e.id, 150, 'exercise.id')
  const resolved = exercise(e.id, state)
  number(e.sets, 1, 30, 'sets', true)
  number(e.reps, 1, 1000, 'reps', true)
  if (e.repsMin !== undefined) number(e.repsMin, 1, e.reps, 'repsMin', true)
  if (e.weight !== undefined) number(e.weight, 0, 5000, 'weight')
  if (e.restSec !== undefined) number(e.restSec, 0, 900, 'restSec', true)
  if (e.inc !== undefined) number(e.inc, 0.01, 500, 'inc')
  if (e.prog !== undefined) check(['off','linear','greyskull','double','triple'].includes(e.prog), 'unsupported progression')
  if (e.bodyweight !== undefined) check(typeof e.bodyweight === 'boolean', 'bodyweight must be boolean')
  if (e.note !== undefined) check(typeof e.note === 'string' && e.note.length <= 4000, 'note must be text, at most 4000 characters')
  if (e.dbLoad !== undefined) {
    check(['as','each','total'].includes(e.dbLoad), 'dbLoad must be as, each or total')
    check(['dumbbell','kettlebell'].includes(resolved.ex.eq), 'dbLoad applies only to dumbbells or kettlebells')
  }
  const out = { ...e, id: resolved.id }
  for (const k of ['weight','inc']) if (out[k] !== undefined) {
    const converted=convertWeight(out[k], from, state.unit || 'kg')
    check(out[k] === 0 || converted > 0, `${k} rounds to zero in the profile unit; choose a representable load`)
    out[k]=converted
  }
  return out
}
function validateRoutine(r, state, from, previous = null) {
  keys(r, ['id','name','emoji','prog','ex','excludeFromProgression'], 'routine')
  text(r.id, 150, 'routine.id'); text(r.name, 150, 'routine.name')
  if (r.emoji !== undefined) text(r.emoji, 20, 'emoji')
  if (r.prog !== undefined) check(['off','linear','greyskull','double','triple'].includes(r.prog), 'unsupported routine progression')
  if (r.excludeFromProgression !== undefined) check(typeof r.excludeFromProgression === 'boolean', 'excludeFromProgression must be boolean')
  check(Array.isArray(r.ex) && r.ex.length > 0 && r.ex.length <= 40, 'routine needs 1–40 exercises')
  return { ...r, ex: r.ex.map((e,i) => previous && isDeepStrictEqual(e,previous.ex?.[i]) ? e : validateExercise(e, state, from)) }
}
function seal(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function binding(snapshot) {
  return { url: snapshot.url, uid: snapshot.uid, revision: snapshot.revision, wid: snapshot.state?._wid || null, unit: snapshot.state?.unit || 'kg' }
}
function packet(snapshot, routines, week) {
  const changes = routines.filter(c => !isDeepStrictEqual(c.before, c.after))
  const value = { format:'opengym-change/1', base:binding(snapshot), routines:changes, ...(week ? { week } : {}) }
  return { ...value, digest:seal(value) }
}

export async function readProfile(config, options = {}) {
  const me = await apiFetch(config, '/api/me', options)
  const uid = me.body?.user?.id
  if (typeof uid !== 'string' || !uid) throw fail('EAPI', 'server did not identify the authenticated profile')
  if (config.uid && config.uid !== uid) throw fail('EPROFILE', 'authenticated profile differs from OPENGYM_UID')
  const got = await apiFetch(config, '/api/data', options)
  check(got.status === 200 && Number.isInteger(got.body?.rev) && got.body.rev >= 0, 'server returned an invalid profile revision')
  const state = got.body.state
  check(state === null || object(state), 'server returned an invalid profile')
  if (state?.engineSchemaVersion && state.engineSchemaVersion !== 1) throw fail('EUNSUPPORTED', 'this CLI supports v1 profiles; update the CLI before using a migrated profile')
  return { url:config.base, uid, name:me.body.user.name || null, revision:got.body.rev, state }
}

export function preparePlan(snapshot, input) {
  keys(input, ['opengym_plan','name','unit','routines','week','customEx'], 'plan')
  check(input.opengym_plan === 1, 'opengym_plan must be 1')
  const from = unit(input.unit)
  check(!input.customEx || (Array.isArray(input.customEx) && input.customEx.length === 0), 'create custom exercises in the app first; reference their IDs here')
  check(Array.isArray(input.routines) && input.routines.length <= 30 && (input.routines.length > 0 || input.week !== undefined), 'plan needs 1–30 routines or an explicit week patch')
  const state = snapshot.state || { unit:from, routines:[], week:{}, workouts:[], customEx:[] }
  unit(state.unit || 'kg')
  const seen = new Set()
  const routines = input.routines.map(r => {
    const validated = validateRoutine(r, state, from)
    check(!seen.has(r.id), 'duplicate routine ID'); seen.add(r.id)
    const before = (state.routines || []).find(x => x.id === r.id) || null
    const after = { ...before, ...validated }
    const retained = keepUnknown({routines:before ? [before] : []}, {routines:[structuredClone(after)]}).routines[0]
    check(isDeepStrictEqual(retained.ex,after.ex), `routine ${r.id}: the API retains omitted native exercise fields; use weights preview for load-only edits or edit advanced configuration in the app`)
    return { before, after }
  })
  let week
  if (input.week !== undefined) {
    check(object(input.week), 'week must be an object')
    const after = structuredClone(state.week || {})
    const known = new Set([...(state.routines || []).map(r => r.id), ...seen])
    for (const [day, ids] of Object.entries(input.week)) {
      check(/^[0-6]$/.test(day), 'week keys must be 0 (Sunday) through 6 (Saturday)')
      check(Array.isArray(ids) && ids.length <= 10 && new Set(ids).size === ids.length && ids.every(id => known.has(id)), 'week contains duplicate or unknown routine IDs')
      if (ids.length) after[day] = ids; else delete after[day]
    }
    if (!isDeepStrictEqual(after, state.week || {})) week = { before:state.week || {}, after }
  }
  // An empty profile starts in the plan's unit; use that same unit when applying the packet.
  const normalized = { ...snapshot, state: snapshot.state || { unit:from } }
  return packet(normalized, routines, week)
}

export function prepareWeights(snapshot, input) {
  keys(input, ['unit','updates'], 'weights')
  const from = unit(input.unit), state = snapshot.state
  check(state, 'profile has no routines yet')
  check(Array.isArray(input.updates) && input.updates.length > 0 && input.updates.length <= 200, 'weights need 1–200 updates')
  const routines = new Map(), seen = new Set()
  for (const u of input.updates) {
    keys(u, ['routine_id','position','weight','reported_reps','acknowledge_rep_mismatch','dbLoad'], 'weight update')
    text(u.routine_id, 150, 'routine_id'); number(u.position, 1, 40, 'position', true); number(u.weight, 0, 5000, 'weight')
    const key = `${u.routine_id}:${u.position}`
    check(!seen.has(key), 'duplicate weight update'); seen.add(key)
    const before = (state.routines || []).find(r => r.id === u.routine_id)
    check(before, `unknown routine ${u.routine_id}`)
    if (!routines.has(before.id)) routines.set(before.id, { before, after:structuredClone(before) })
    const target = routines.get(before.id).after.ex[u.position - 1]
    check(target, 'position is outside the routine')
    if (u.acknowledge_rep_mismatch !== undefined) check(typeof u.acknowledge_rep_mismatch === 'boolean', 'acknowledge_rep_mismatch must be boolean')
    if (u.reported_reps !== undefined) {
      number(u.reported_reps, 1, 1000, 'reported_reps', true)
      const min = target.repsMin || target.reps
      if (u.reported_reps < min && !u.acknowledge_rep_mismatch) throw fail('ETARGET', `${key}: reported ${u.reported_reps} reps is below the ${min}–${target.reps} target; clarify the intended load before acknowledging the mismatch`)
    }
    if (u.dbLoad !== undefined) {
      const ex = exercise(target.id, state).ex
      check(['as','each','total'].includes(u.dbLoad) && ['dumbbell','kettlebell'].includes(ex.eq), 'invalid dumbbell load meaning')
      target.dbLoad = u.dbLoad
    }
    target.weight = convertWeight(u.weight, from, state.unit || 'kg')
    check(u.weight === 0 || target.weight > 0, 'weight rounds to zero in the profile unit; choose a representable load')
  }
  return packet(snapshot, [...routines.values()])
}

export function changeSummary(change) {
  return { account:change.base.uid, server:change.base.url, revision:change.base.revision, unit:change.base.unit, digest:change.digest,
    routines:change.routines.map(c => ({ id:c.after.id, name:c.after.name, action:c.before ? 'update' : 'create',
      fields:Object.keys(c.after).filter(k => k !== 'ex' && !isDeepStrictEqual(c.before?.[k], c.after[k])),
      exercises:c.after.ex.flatMap((e,i) => {
        const previous=c.before?.ex?.[i]
        const fields=Object.keys(e).filter(k=>!isDeepStrictEqual(previous?.[k],e[k]))
        const removed=previous ? Object.keys(previous).filter(k=>!(k in e)) : []
        return fields.length || removed.length ? [{position:i+1, values:Object.fromEntries(fields.map(k=>[k,e[k]])), ...(removed.length?{removed}: {})}] : []
      }), removed_exercises:Math.max(0,(c.before?.ex?.length||0)-c.after.ex.length) })),
    ...(change.week ? { week:change.week } : {}), no_change:change.routines.length === 0 && !change.week }
}

export async function applyChange(config, change, options = {}) {
  keys(change, ['format','base','routines','week','digest'], 'change')
  const { digest, ...value } = change
  check(change.format === 'opengym-change/1' && digest === seal(value), 'change file is invalid or edited; preview again')
  if (config.base !== change.base?.url) throw fail('ECONFLICT', 'prepared change belongs to a different server; preview again before applying')
  const snapshot = await readProfile(config, options)
  const expected = binding(snapshot)
  // On first import there is no persisted unit yet; the prepared packet chooses it.
  if (!snapshot.state) expected.unit = unit(change.base.unit)
  if (!isDeepStrictEqual(expected, change.base)) throw fail('ECONFLICT', 'server, account, unit or revision changed; preview again before applying')
  const next = structuredClone(snapshot.state || {unit:change.base.unit,routines:[],week:{},workouts:[],customEx:[]})
  check(Array.isArray(change.routines) && change.routines.length <= 30, 'invalid routine changes')
  const seen = new Set()
  for (const c of change.routines) {
    check(object(c) && object(c.after), 'invalid routine change')
    const existing = (next.routines || []).find(r=>r.id===c.after.id) || null
    check(isDeepStrictEqual(existing,c.before), 'routine no longer matches the preview')
    check(!seen.has(c.after.id), 'duplicate routine change'); seen.add(c.after.id)
    // Validate supported prescriptions again; retain existing app metadata from the exact before copy.
    const old = c.before || {}
    const input = Object.fromEntries(Object.entries(c.after).filter(([k])=>['id','name','emoji','prog','ex','excludeFromProgression'].includes(k)))
    // Weight-only edits may carry native fields this CLI does not author. They may only be retained unchanged.
    input.ex = c.after.ex.map((e,i)=>{
      if (isDeepStrictEqual(e,old.ex?.[i])) return e
      const known = ['id','sets','reps','repsMin','weight','restSec','prog','inc','dbLoad','bodyweight','note']
      for (const [k,v] of Object.entries(e)) if (!known.includes(k)) check(isDeepStrictEqual(v,old.ex?.[i]?.[k]), 'unsupported exercise field was changed')
      return Object.fromEntries(Object.entries(e).filter(([k])=>known.includes(k)))
    })
    validateRoutine(input,next,change.base.unit,old)
    for(const [k,v] of Object.entries(c.after)) if(!['id','name','emoji','prog','ex','excludeFromProgression'].includes(k)) check(isDeepStrictEqual(v,old[k]), 'unsupported routine field was changed')
    next.routines ||= []
    const index=next.routines.findIndex(r=>r.id===c.after.id)
    if(index<0)next.routines.push(c.after);else next.routines[index]=c.after
  }
  if (change.week) {
    check(isDeepStrictEqual(next.week || {},change.week.before), 'schedule no longer matches preview')
    const known = new Set(next.routines.map(r=>r.id))
    check(object(change.week.after), 'invalid schedule')
    for (const [day,ids] of Object.entries(change.week.after)) check(/^[0-6]$/.test(day)&&Array.isArray(ids)&&ids.length<=10&&new Set(ids).size===ids.length&&ids.every(id=>known.has(id)), 'invalid schedule')
    next.week=change.week.after
  }
  if (!change.routines.length && !change.week) return { applied:false, no_change:true, revision:snapshot.revision }
  const result=await apiFetch(config,'/api/data',{...options,method:'PUT',body:{state:next,baseRev:snapshot.revision,...(snapshot.state?._wid?{baseWid:snapshot.state._wid}:{})}})
  if (result.status===409) throw fail('ECONFLICT','profile changed during save; preview again before applying')
  const readBack=await apiFetch(config,'/api/data',options)
  const state=readBack.body?.state
  if (!state || change.routines.some(c=>{const r=state.routines?.find(x=>x.id===c.after.id);return !r || !Object.entries(c.after).filter(([k])=>!k.startsWith('_')).every(([k,v])=>isDeepStrictEqual(r[k],v))}) || (change.week&&!isDeepStrictEqual(state.week,change.week.after))) throw fail('EVERIFY','save was accepted but read-back differs; inspect the current profile before retrying')
  return { applied:true, verified:true, revision:readBack.body.rev, routines:change.routines.map(c=>({id:c.after.id,name:c.after.name})), schedule_changed:!!change.week }
}

export function previewSession(snapshot, routineId) {
  const state=snapshot.state
  const routine=state?.routines?.find(r=>r.id===routineId)
  if(!routine)throw fail('ENOENT','routine not found')
  registerCustom(state.customEx || [])
  try {
    const entries=buildSessionEntries(state,routine)
    return { routine_id:routine.id, name:routine.name, unit:state.unit || 'kg', revision:snapshot.revision,
      exercises:routine.ex.map((e,i)=>({position:i+1,id:e.id,name:EXIDX[e.id]?.n||e.id,planned:e,prescription:entries[i].plan,opening_sets:entries[i].sets})) }
  } finally { registerCustom([]) }
}

export function searchExercises(query, limit=10) {
  text(query,200,'query')
  return catalogSearch(Object.values(EXIDX),query).slice(0,limit).map(e=>({id:e.id,name:e.n,equipment:e.eq}))
}
