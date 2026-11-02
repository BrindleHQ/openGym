// Local browser acceptance support. Runs the REAL OpenGym API with an isolated
// disposable account; the loopback-only bridge signs that test account in without
// involving a human passkey. Reppen still verifies tokens minted by the real API.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.env.REPPEN_ACCEPTANCE !== '1') throw Error('Run only with REPPEN_ACCEPTANCE=1')
const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../api')
const data = fs.mkdtempSync(path.join(os.homedir(), '.cache/reppen-offline-'))
const secret = crypto.randomBytes(32).toString('hex')
const user = { id: 'offline_acceptance', name: 'Offline acceptance', created: new Date().toISOString() }
fs.writeFileSync(path.join(data, 'secret'), secret, { mode: 0o600 })
fs.writeFileSync(path.join(data, 'db.json'), JSON.stringify({ users: [user], creds: [], subs: [], invites: [] }))
const api = spawn(process.execPath, ['server.js'], { cwd: apiDir, stdio: ['ignore', 'ignore', 'pipe'], env: {
  ...process.env, PORT: '5339', HOST: '127.0.0.1', DATA_DIR: data,
  ORIGIN: 'http://127.0.0.1:5327', RP_ID: '127.0.0.1', ADMIN_SOCKET_DIR: path.join(data, 'sock'),
  REPPEN_TOKEN_ISSUER: 'http://opengym.acceptance.local', REPPEN_TOKEN_AUDIENCE: 'reppen-acceptance', COACH_DISABLED: '1',
} })
api.stderr.on('data', () => {})
const bridge = http.createServer((req, res) => {
  if (req.url === '/api/__offline_acceptance_session') {
    const payload = `${user.id}:${Date.now() + 86400000}:0:c`
    const session = payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url')
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `gymsid=${session}; HttpOnly; Path=/; SameSite=Lax`, 'cache-control': 'no-store' })
    res.end(JSON.stringify(user)); return
  }
  const upstream = http.request({ hostname: '127.0.0.1', port: 5339, path: req.url, method: req.method, headers: req.headers }, reply => {
    res.writeHead(reply.statusCode, reply.headers); reply.pipe(res)
  })
  upstream.on('error', () => { res.writeHead(502); res.end() })
  req.pipe(upstream)
})
bridge.listen(5340, '127.0.0.1', () => console.log('offline acceptance API bridge ready on 127.0.0.1:5340'))
let stopping = false
async function stop() {
  if (stopping) return; stopping = true
  bridge.close(); api.kill('SIGTERM')
  await new Promise(resolve => api.exitCode != null ? resolve() : api.once('exit', resolve))
  fs.rmSync(data, { recursive: true, force: true }); process.exit(0)
}
process.on('SIGTERM', stop); process.on('SIGINT', stop)
api.once('exit', code => { if (!stopping) { console.error(`acceptance API exited ${code}`); stop() } })
