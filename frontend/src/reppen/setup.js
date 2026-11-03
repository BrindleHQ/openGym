// Only the catalog's explicitly confirmed mass setup contract is supported.
export const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0
export const LB_KG = 0.45359237
export const supportedMass = p => p?.type?.t === 'q' && p.type.dim?.mass === 1
  && Object.keys(p.type.dim).length === 1 && p.required === true
  && ['startingLoad', 'equipmentIncrement'].includes(p.purpose)
  && typeof p.name === 'string' && typeof p.slot === 'string' && typeof p.exerciseName === 'string'
  && p.unit === 'kg' && p.displayUnit === 'lb' && p.minimumExclusive === 0 && p.requiresConfirmation === true
export const massParameters = entry => (entry?.parameters || []).filter(supportedMass)
export const initialSetup = entry => Object.fromEntries(massParameters(entry).map(p =>
  [p.name, p.purpose === 'startingLoad' && positive(p.knownValue) ? Number((p.knownValue / LB_KG).toFixed(8)) : null]))
export const validSetup = (entry, values, confirmed) => !massParameters(entry).length ||
  (confirmed === true && massParameters(entry).every(p => positive(values[p.name]) && positive(values[p.name] * LB_KG)))
export const setupParams = (entry, values) => Object.fromEntries(massParameters(entry).map(p =>
  [p.name, { v: 'q', n: values[p.name] * LB_KG, dim: { mass: 1 }, unit: 'kg' }]))
