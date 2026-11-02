// What a Reppen failure means to the person, in their language. The API's codes are listed in
// reppen-core backend/README.md; anything not named here reads as a general failure.
import { t } from '../lib/i18n.js'
import { refusalOf } from './client.js'

export function errorText(e) {
  if (!e) return null
  const refusal = refusalOf(e)
  if (refusal === 'questionsPending') return t('Answer the open questions before finishing.')
  if (refusal === 'emptySession') return t('Log at least one set before finishing.')
  if (refusal) return t('Reppen refused this: {0}', refusal)
  switch (e.code) {
    case 'offline': return t('Reppen could not be reached. Check your connection and try again.')
    case 'unauthenticated': case 'http401': return t('Reppen did not accept your sign-in. Sign in again and retry.')
    case 'enrollmentNotFound': return t('Reppen no longer has this program enrollment.')
    case 'workoutNotFound': return t('Reppen no longer has this workout.')
    case 'programNotFound': case 'catalogArtifactNotFound': return t('This program is no longer available.')
    case 'unsupportedExecution': return t('This program cannot run here yet.')
    case 'accountDeleting': return t('Your Reppen data is being deleted.')
    default: return t('Something went wrong with Reppen. Try again.')
  }
}
