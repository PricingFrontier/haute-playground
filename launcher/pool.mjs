// The playground's sessions: machines in the sessions app that wait in a pool,
// are claimed one per visitor, and are destroyed when the visit ends: when the
// visitor ends it, when its time is up, or when no page has held its live-sync
// connection open for a while (the tab was closed and said nothing). Fly keeps
// the record (each machine's state, and its sid and claim in metadata), so a
// restarted launcher rebuilds everything here from the machine list.
import { randomBytes } from 'node:crypto'

const ROLE = 'playground-session'
const TICK_MS = 3_000
const CREATE_SPACING_MS = 1_100 // Fly allows one create a second per app
const CREATES_PER_TICK = 3
const WARM_TIMEOUT_MS = 300_000 // a first start on a new host pulls the 1 GB image
const RESUME_TIMEOUT_MS = 30_000
const CLAIM_WAIT_MS = 60_000 // how long a visitor waits for a machine that is still warming
const CREATE_BACKOFF_MS = 30_000
const SETTLE_MS = 30_000 // a machine this new may not be in the list yet

const CLAIM_ATTEMPTS = 2 // a failing claim must not work its way through the whole pool

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A claim is one metadata value, since Fly rate-limits metadata writes per machine
const writeClaim = m => JSON.stringify({ expiresAt: new Date(m.expiresAt).toISOString(), clientIp: m.clientIp })
function readClaim(value) {
  if (!value) return null
  try {
    const { expiresAt, clientIp } = JSON.parse(value)
    const at = Date.parse(expiresAt)
    return Number.isFinite(at) ? { expiresAt: at, clientIp: clientIp ?? null } : null
  } catch {
    return null
  }
}

// Phases: warming (booting, not serving yet), ready (serving, waiting in the pool),
// suspending, suspended (paused in the pool), claiming, claimed, ending.
const IN_POOL = new Set(['warming', 'ready', 'suspending', 'suspended'])
const IN_USE = new Set(['claiming', 'claimed'])

export function createPool({ api, settings, log }) {
  const machines = new Map() // id -> machine
  let creating = 0
  let createBlockedUntil = 0
  let ticking = false
  let timer = null

  const count = phase => [...machines.values()].filter(m => m.phase === phase).length
  const inUse = () => [...machines.values()].filter(m => IN_USE.has(m.phase))
  const poolSize = () => [...machines.values()].filter(m => IN_POOL.has(m.phase)).length + creating
  const maxMachines = settings.poolRunning + settings.poolSuspended + settings.maxSessions

  function add(fields) {
    // sockets: the session's open live-sync connections; lastSeen: its last sign of a visitor
    const m = { since: Date.now(), expiresAt: null, clientIp: null, sockets: 0, lastSeen: Date.now(), ...fields }
    machines.set(m.id, m)
    return m
  }

  async function healthy(m, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://[${m.ip}]:8080/`, { signal: AbortSignal.timeout(2_000) })
        if (res.ok) return true
      } catch {}
      await sleep(1_000)
    }
    return false
  }

  async function reachState(m, state, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await api.get(m.id)).state === state) return true
      await sleep(500)
    }
    return false
  }

  async function destroy(m, reason) {
    m.phase = 'ending'
    try {
      await api.destroy(m.id)
    } catch (err) {
      log('destroy_failed', { id: m.id, reason, error: err.message })
    }
    machines.delete(m.id)
    log('machine_destroyed', { id: m.id, reason })
  }

  // A new or adopted machine: wait until Haute serves, then keep it running or pause it
  async function warm(m) {
    if (!(await healthy(m, WARM_TIMEOUT_MS))) return destroy(m, 'never served')
    if (m.phase !== 'warming') return
    if (count('ready') < settings.poolRunning) {
      m.phase = 'ready'
      log('machine_ready', { id: m.id })
      return
    }
    m.phase = 'suspending'
    try {
      await api.suspend(m.id)
      if (!(await reachState(m, 'suspended', 60_000))) throw new Error('did not reach suspended')
      if (m.phase !== 'suspending') return
      m.phase = 'suspended'
      log('machine_suspended', { id: m.id })
    } catch (err) {
      log('suspend_failed', { id: m.id, error: err.message })
      await destroy(m, 'suspend failed')
    }
  }

  async function createOne() {
    if (machines.size + creating >= maxMachines) {
      log('machine_limit_reached', { machines: machines.size, creating, max: maxMachines })
      return false
    }
    // The session's address is its only key, so it must be unguessable: 80 random bits
    const sid = randomBytes(10).toString('hex')
    creating++
    try {
      const machine = await api.create({
        region: settings.region,
        config: {
          image: settings.image,
          env: { PUBLIC_ORIGIN: `https://${sid}.${settings.domain}` },
          guest: { cpu_kind: settings.cpuKind, cpus: settings.cpus, memory_mb: settings.memoryMb },
          restart: { policy: 'no' },
          auto_destroy: true,
          metadata: { role: ROLE, sid },
        },
      })
      const m = add({ id: machine.id, sid, ip: machine.private_ip, phase: 'warming' })
      log('machine_created', { id: m.id })
      warm(m)
      return true
    } catch (err) {
      createBlockedUntil = Date.now() + CREATE_BACKOFF_MS
      log('create_failed', { error: err.message })
      return false
    } finally {
      creating--
    }
  }

  // Bring memory in line with Fly's list: adopt machines we don't know (after a
  // restart), and drop or end those that have gone or broken.
  async function sync() {
    const listed = new Map()
    for (const machine of await api.list()) {
      if (machine.config?.metadata?.role === ROLE) listed.set(machine.id, machine)
    }
    for (const [id, machine] of listed) {
      const meta = machine.config.metadata
      const m = machines.get(id)
      if (!m) {
        const fields = { id, sid: meta.sid, ip: machine.private_ip }
        const claimed = readClaim(meta.claim)
        if (claimed && machine.state === 'started') {
          add({ ...fields, phase: 'claimed', ...claimed })
          log('adopted', { id, phase: 'claimed' })
        } else if (!meta.claim && machine.state === 'suspended') {
          add({ ...fields, phase: 'suspended' })
          log('adopted', { id, phase: 'suspended' })
        } else if (!meta.claim && ['created', 'starting', 'started'].includes(machine.state)) {
          warm(add({ ...fields, phase: 'warming' }))
          log('adopted', { id, phase: 'warming' })
        } else {
          await destroy(add({ ...fields, phase: 'ending' }), `found ${machine.state}`)
        }
        continue
      }
      m.ip = machine.private_ip
      if (broken(m, machine.state)) {
        const fresh = await lookup(id)
        if (!fresh || broken(m, fresh.state)) await destroy(m, `${m.phase} but ${fresh?.state ?? 'gone'}`)
      }
    }
    for (const m of [...machines.values()]) {
      if (listed.has(m.id) || m.phase === 'ending' || Date.now() - m.since <= SETTLE_MS) continue
      const fresh = await lookup(m.id)
      if (!fresh || fresh.state === 'destroyed') {
        machines.delete(m.id)
        log('machine_gone', { id: m.id, phase: m.phase })
      } else {
        log('list_missed', { id: m.id, state: fresh.state })
      }
    }
  }

  // A machine whose state doesn't fit what it is for
  function broken(m, state) {
    return (
      (m.phase === 'claimed' && state !== 'started') ||
      (m.phase === 'ready' && state !== 'started') ||
      (m.phase === 'suspended' && !['suspended', 'starting', 'started'].includes(state))
    )
  }

  // Fly's list can lag or leave a machine out, so only a direct lookup counts as proof
  // that a machine has gone or broken; null when Fly no longer knows it
  async function lookup(id) {
    try {
      return await api.get(id)
    } catch (err) {
      if (/: 404 /.test(err.message)) return null
      throw err
    }
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await sync()
      for (const m of inUse()) {
        if (m.phase !== 'claimed') continue
        if (m.expiresAt <= Date.now()) await destroy(m, 'expired')
        else if (m.sockets === 0 && Date.now() - m.lastSeen > settings.idleMs) await destroy(m, 'visitor left')
      }
      const wanted = settings.poolRunning + settings.poolSuspended
      for (let i = 0; i < CREATES_PER_TICK && poolSize() < wanted && Date.now() >= createBlockedUntil; i++) {
        if (!(await createOne())) break
        await sleep(CREATE_SPACING_MS)
      }
      // Too few running and too many paused (a running one was claimed and the refill
      // paused, or after a restart): wake a paused one to run
      if (count('ready') + count('warming') < settings.poolRunning && count('suspended') > settings.poolSuspended) {
        const m = [...machines.values()].find(x => x.phase === 'suspended')
        m.phase = 'warming'
        try {
          await api.start(m.id)
          warm(m)
          log('machine_woken', { id: m.id })
        } catch (err) {
          log('wake_failed', { id: m.id, error: err.message })
          await destroy(m, 'wake failed')
        }
      }
      // More waiting than wanted (the pool was made smaller): let the extras go
      for (const [phase, keep] of [['suspended', settings.poolSuspended], ['ready', settings.poolRunning]]) {
        while (poolSize() > wanted && count(phase) > keep) {
          await destroy([...machines.values()].find(m => m.phase === phase), 'pool is smaller')
        }
      }
    } catch (err) {
      log('tick_failed', { error: err.message })
    } finally {
      ticking = false
    }
  }

  // Take the fastest waiting machine: a running one, then a paused one
  function take() {
    for (const phase of ['ready', 'suspended']) {
      for (const m of machines.values()) if (m.phase === phase) return m
    }
    return null
  }

  async function claim(clientIp) {
    if (inUse().filter(m => m.clientIp === clientIp).length >= settings.maxPerIp) {
      throw Object.assign(new Error('too many sessions from this address'), { status: 429, code: 'too-many' })
    }
    const deadline = Date.now() + CLAIM_WAIT_MS
    for (let attempts = 0; ; ) {
      if (inUse().length >= settings.maxSessions) {
        throw Object.assign(new Error('every session is in use'), { status: 503, code: 'busy' })
      }
      const m = take()
      if (m) {
        const wasSuspended = m.phase === 'suspended'
        const now = Date.now()
        Object.assign(m, { phase: 'claiming', clientIp, expiresAt: now + settings.sessionMs })
        tick()
        attempts++
        try {
          await api.setMetadata(m.id, 'claim', writeClaim(m))
          if (wasSuspended) {
            await api.start(m.id)
            if (!(await reachState(m, 'started', RESUME_TIMEOUT_MS))) throw new Error('did not resume')
          }
          if (!(await healthy(m, RESUME_TIMEOUT_MS))) throw new Error('did not serve after resuming')
        } catch (err) {
          log('claim_failed', { id: m.id, attempt: attempts, error: err.message })
          await destroy(m, 'claim failed')
          if (attempts >= CLAIM_ATTEMPTS) {
            throw Object.assign(new Error('could not start a session'), { status: 503, code: 'failed' })
          }
          continue
        }
        m.phase = 'claimed'
        m.lastSeen = Date.now()
        log('session_claimed', { id: m.id, resumed: wasSuspended, ms: Date.now() - now })
        return { sid: m.sid, url: `https://${m.sid}.${settings.domain}/`, expiresAt: m.expiresAt, ms: m.expiresAt - Date.now() }
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error('no session came free in time'), { status: 503, code: 'busy' })
      }
      await sleep(500)
    }
  }

  async function end(sid) {
    const m = inUse().find(x => x.sid === sid)
    if (!m) return false
    await destroy(m, 'ended by visitor')
    tick()
    return true
  }

  // The machine behind a session's address, while the session is live
  function route(sid) {
    for (const m of machines.values()) if (m.sid === sid && m.phase === 'claimed') return m
    return null
  }

  function status() {
    const phases = {}
    for (const m of machines.values()) phases[m.phase] = (phases[m.phase] ?? 0) + 1
    return { phases, creating, inUse: inUse().length, maxSessions: settings.maxSessions, maxMachines }
  }

  return {
    start() {
      tick()
      timer = setInterval(tick, TICK_MS)
    },
    stop: () => clearInterval(timer),
    claim,
    end,
    route,
    status,
    // The proxy reports what it sees of a session's visitor
    seen: m => {
      m.lastSeen = Date.now()
    },
    connected: m => {
      m.sockets++
      m.lastSeen = Date.now()
    },
    disconnected: m => {
      m.sockets = Math.max(0, m.sockets - 1)
      m.lastSeen = Date.now()
    },
  }
}
