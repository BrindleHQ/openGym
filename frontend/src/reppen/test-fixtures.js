// Shared by the Reppen tests: a catalog entry shaped like the API's, and a client that answers
// like Reppen without a network.
import { vi } from 'vitest'

export const GZCLP = {
  catalogId: 'gzclp-t1', artifactId: 'sha256:gz', title: 'GZCLP T1', admission: { status: 'supported' },
  readings: [
    { fact: 'e1rm', key: 'wger:111', required: true, type: { t: 'q', dim: { mass: 1 } } },
    { fact: 'e1rm', key: 'wger:192', required: true, type: { t: 'q', dim: { mass: 1 } } },
  ],
  parameters: [{ name: 'squatStart', required: false, type: { t: 'opt', of: { t: 'q', dim: { mass: 1 } } } }],
  days: ['A1', 'B1', 'A2', 'B2'], defaultDay: 'A1',
}

export function fakeClient(overrides = {}) {
  return {
    catalog: vi.fn(async cursor => (cursor ? { items: [{ ...GZCLP, artifactId: 'sha256:2', title: 'Two' }], nextCursor: null } : { items: [GZCLP], nextCursor: 'p2' })),
    enrollment: vi.fn(async id => ({ enrollmentId: id, revision: 0 })),
    enroll: vi.fn(async (id, body) => ({ enrollmentId: id, artifactId: body.artifactId, revision: 0 })),
    history: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  }
}
