// The playground launcher. On play.<domain> it starts and ends sessions for the
// site's playground page; on <sid>.play.<domain> it proxies the visitor's traffic,
// WebSockets included, to that session's machine over Fly's private network.
// Session machines have no public address of their own.
import { readFileSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { machinesApi } from './fly.mjs'
import { createPool } from './pool.mjs'

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}
function whole(name) {
  const value = Number(required(name))
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, not "${process.env[name]}"`)
  return value
}

const settings = {
  domain: required('SESSION_DOMAIN'),
  image: required('SESSION_IMAGE'),
  region: required('SESSION_REGION'),
  cpuKind: required('SESSION_CPU_KIND'),
  cpus: whole('SESSION_CPUS'),
  memoryMb: whole('SESSION_MEMORY_MB'),
  sessionMs: whole('SESSION_MINUTES') * 60_000,
  idleMs: whole('SESSION_IDLE_SECONDS') * 1_000,
  poolRunning: whole('POOL_RUNNING'),
  poolSuspended: whole('POOL_SUSPENDED'),
  maxSessions: whole('MAX_SESSIONS'),
  maxPerIp: whole('MAX_SESSIONS_PER_IP'),
}
const playgroundPage = required('PLAYGROUND_PAGE')
const allowedOrigins = new Set([`https://${settings.domain}`, ...required('ALLOWED_ORIGINS').split(',').map(o => o.trim())])
const log = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))

const api = machinesApi({ app: required('SESSIONS_APP'), token: required('SESSIONS_API_TOKEN') })
const pool = createPool({ api, settings, log })
const testPage = readFileSync(new URL('./test.html', import.meta.url))
const endedPage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session ended</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#131621;color:#e6e3e2;font:16px system-ui,sans-serif">
<p>This session has ended.</p>`

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade']
function endToEnd(headers) {
  const kept = { ...headers }
  for (const name of HOP_BY_HOP) delete kept[name]
  return kept
}

// "<sid>.play.<domain>" -> sid; any other host is the launcher's own
const sessionSuffix = `.${settings.domain}`
function sidOf(req) {
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
  return host.endsWith(sessionSuffix) ? host.slice(0, -sessionSuffix.length) : null
}

const upstream = new http.Agent({ keepAlive: true, maxSockets: 256 })

function proxy(req, res, machine) {
  pool.seen(machine)
  const up = http.request(
    { host: machine.ip, port: 8080, method: req.method, path: req.url, headers: endToEnd(req.headers), agent: upstream },
    upRes => {
      res.writeHead(upRes.statusCode, endToEnd(upRes.headers))
      upRes.pipe(res)
    },
  )
  up.on('error', err => {
    log('proxy_error', { id: machine.id, error: err.message })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end()
  })
  res.on('close', () => {
    if (!res.writableFinished) up.destroy()
  })
  req.pipe(up)
}

async function launcherRequest(req, res) {
  const url = new URL(req.url, 'http://launcher')
  const origin = req.headers.origin
  const cors = allowedOrigins.has(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}
  const send = (status, body = '', headers = {}) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...cors, ...headers })
    res.end(body)
  }
  const json = (status, value) => send(status, JSON.stringify(value), { 'content-type': 'application/json' })
  const ending = url.pathname.match(/^\/sessions\/([0-9a-f]+)$/)
  // A page that is closing can only send a beacon, which is always a POST
  const beacon = url.pathname.match(/^\/sessions\/([0-9a-f]+)\/end$/)
  try {
    if (req.method === 'OPTIONS') return send(204, '', { 'access-control-allow-methods': 'POST, DELETE', 'access-control-max-age': '600' })
    if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok')
    if (req.method === 'GET' && url.pathname === '/status') return json(200, pool.status())
    if (req.method === 'GET' && url.pathname === '/test') return send(200, testPage, { 'content-type': 'text/html; charset=utf-8' })
    if (req.method === 'GET' && url.pathname === '/') return send(302, '', { location: playgroundPage })
    if (req.method === 'POST' && url.pathname === '/sessions') {
      // A page on another site can't start sessions through its visitors' browsers
      if (origin && !cors['access-control-allow-origin']) return json(403, { error: 'origin-not-allowed' })
      const clientIp = req.headers['fly-client-ip'] ?? req.socket.remoteAddress
      try {
        return json(201, await pool.claim(clientIp))
      } catch (err) {
        if (err.status) return json(err.status, { error: err.code })
        throw err
      }
    }
    if ((req.method === 'DELETE' && ending) || (req.method === 'POST' && beacon)) {
      await pool.end((ending ?? beacon)[1])
      return send(204)
    }
    return send(404, 'not found')
  } catch (err) {
    log('request_failed', { path: url.pathname, error: err.message })
    return json(500, { error: 'failed' })
  }
}

const server = http.createServer((req, res) => {
  const sid = sidOf(req)
  if (sid === null) return launcherRequest(req, res)
  const machine = pool.route(sid)
  if (!machine) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    return res.end(endedPage)
  }
  proxy(req, res, machine)
})

// WebSockets (Haute's live sync): replay the upgrade request to the session and splice the sockets
server.on('upgrade', (req, socket, head) => {
  const sid = sidOf(req)
  const machine = sid && pool.route(sid)
  if (!machine) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  const up = net.connect({ host: machine.ip, port: 8080 })
  // An open live-sync connection means a page still shows the session
  let counted = false
  const close = () => {
    up.destroy()
    socket.destroy()
    if (counted) pool.disconnected(machine)
    counted = false
  }
  up.on('connect', () => {
    pool.connected(machine)
    counted = true
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    up.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) up.write(head)
    socket.pipe(up).pipe(socket)
  })
  for (const s of [up, socket]) {
    s.setNoDelay(true)
    s.on('error', close)
    s.on('close', close)
  }
})

server.listen(8080, () => log('listening', { ...settings, playgroundPage, allowedOrigins: [...allowedOrigins] }))
pool.start()
process.on('SIGTERM', () => {
  pool.stop()
  server.close()
  process.exit(0)
})
