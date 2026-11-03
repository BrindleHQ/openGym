// Local-only production PWA preview, with real API proxies. Stop this process
// after the service worker is ready to exercise a complete network outage.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
if (process.env.REPPEN_ACCEPTANCE !== '1') throw Error('Run only with REPPEN_ACCEPTANCE=1')
const root = fileURLToPath(new URL('../frontend/dist/', import.meta.url))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/') || req.url.startsWith('/reppen/')) {
    const reppen = req.url.startsWith('/reppen/')
    const upstream = http.request({ hostname: '127.0.0.1', port: reppen ? 5338 : 5340,
      path: reppen ? req.url.slice('/reppen'.length) : req.url, method: req.method,
      headers: { ...req.headers, origin: 'http://127.0.0.1:5327' },
    }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res) })
    upstream.on('error', () => req.socket.destroy()); req.pipe(upstream); return
  }
  let file
  try { file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)) } catch { res.writeHead(400); res.end(); return }
  if (file !== root.slice(0, -1) && !file.startsWith(root)) { res.writeHead(404); res.end(); return }
  if (file === root.slice(0, -1) || req.url === '/') file = path.join(root, 'index.html')
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
})
server.listen(5328, '127.0.0.1', () => console.log('production PWA acceptance preview ready on 127.0.0.1:5328'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
