// Only the catalog's explicit mass setup contract is supported. Unknown is a
// declared optional value, never a zero or an invented starting prescription.
export const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0
export const LB_KG = 0.45359237
export const deferredMass = p => p?.required === false && p?.deferred === true && p?.type?.t === 'opt'
export const supportedMass = p => {
  const type = deferredMass(p) ? p.type.of : p?.type
  return type?.t === 'q' && type.dim?.mass === 1
  && Object.keys(type.dim).length === 1 && (p.required === true || deferredMass(p))
  && ['startingLoad', 'equipmentIncrement'].includes(p.purpose)
  && typeof p.name === 'string' && typeof p.slot === 'string' && typeof p.exerciseName === 'string'
  && p.unit === 'kg' && p.displayUnit === 'lb' && p.minimumExclusive === 0 && p.requiresConfirmation === true
}
export const massParameters = entry => (entry?.parameters || []).filter(supportedMass)
export const guidedSetup = entry => massParameters(entry).length > 0 && massParameters(entry).every(deferredMass)
export const initialSetup = entry => Object.fromEntries(massParameters(entry).map(p =>
  [p.name, !deferredMass(p) && p.purpose === 'startingLoad' && positive(p.knownValue) ? Number((p.knownValue / LB_KG).toFixed(8)) : null]))
export const validSetup = (entry, values, confirmed) => {
  const parameters = massParameters(entry)
  return parameters.every(p => deferredMass(p) && values[p.name] == null || positive(values[p.name]) && positive(values[p.name] * LB_KG))
    && (!parameters.some(p => values[p.name] != null || !deferredMass(p)) || confirmed === true)
}
export const setupParams = (entry, values) => Object.fromEntries(massParameters(entry).map(p =>
  [p.name, deferredMass(p) && values[p.name] == null ? { v: 'none', cause: { k: 'declaredNone' } }
    : { v: 'q', n: values[p.name] * LB_KG, dim: { mass: 1 }, unit: 'kg' }]))
