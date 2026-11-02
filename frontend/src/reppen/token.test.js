import { describe, expect, it, vi } from 'vitest'
import { tokenSource } from './token.js'

const b64u = o => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
// A token as the server mints it: only the claims matter here, the signature is Reppen's to check.
const jwt = (iat, exp, n = 0) => `${b64u({ alg: 'EdDSA' })}.${b64u({ iat, exp, sub: 'u1', n })}.sig`

function setup() {
  let clock = 1_000_000
  let n = 0
  // The server's clock is an hour ahead of this device's: only the token's lifetime may count.
  const mint = vi.fn(async () => {
    const iat = Math.floor(clock / 1000) + 3600
    return { token: jwt(iat, iat + 300, ++n), expiresAt: iat + 300 }
  })
  const src = tokenSource({ mint, now: () => clock })
  return { src, mint, tick: ms => { clock += ms } }
}

describe('Reppen token source', () => {
  it('reuses a token until shortly before it expires, whatever the server clock says', async () => {
    const { src, mint, tick } = setup()
    const a = await src.get('u1')
    tick(240_000)
    expect(await src.get('u1')).toBe(a)
    expect(mint).toHaveBeenCalledTimes(1)
    tick(40_000)   // 280 s in: inside the last 30 s
    expect(await src.get('u1')).not.toBe(a)
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('shares one request between callers asking at the same time', async () => {
    const { src, mint } = setup()
    const [a, b] = await Promise.all([src.get('u1'), src.get('u1')])
    expect(a).toBe(b)
    expect(mint).toHaveBeenCalledTimes(1)
  })

  it('asks again when told the token was refused', async () => {
    const { src, mint } = setup()
    const a = await src.get('u1')
    expect(await src.get('u1', { fresh: true })).not.toBe(a)
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('never hands one account the token of another', async () => {
    const { src, mint } = setup()
    await src.get('u1')
    await src.get('u2')
    expect(mint).toHaveBeenCalledTimes(2)
    await expect(src.get(null)).rejects.toThrow('not signed in')
  })

  it('forgets everything on clear, including a request still in flight', async () => {
    const { src, mint } = setup()
    const first = src.get('u1')
    src.clear()
    await first
    await src.get('u1')
    expect(mint).toHaveBeenCalledTimes(2)
  })

  it('refuses an answer without a token', async () => {
    const src = tokenSource({ mint: async () => ({ error: 'nope' }) })
    await expect(src.get('u1')).rejects.toThrow('no Reppen token')
  })
})
