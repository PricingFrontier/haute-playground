// The Fly Machines API calls the pool makes, all on the sessions app.

const API = 'https://api.machines.dev/v1'

export function machinesApi({ app, token }) {
  const base = `${API}/apps/${app}/machines`
  // A macaroon token ("FlyV1 fm2_...") carries its own scheme; older tokens are bearer tokens
  const authorization = token.startsWith('FlyV1 ') ? token : `Bearer ${token}`

  async function call(method, path, body) {
    let res
    // Fly rate-limits each action (about one a second per machine or app). A 429
    // means nothing was done, so even a create is safe to retry after a pause.
    for (let wait = 500; ; wait *= 2) {
      res = await fetch(base + path, {
        method,
        headers: { authorization, ...(body && { 'content-type': 'application/json' }) },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status !== 429 || wait > 8_000) break
      await res.arrayBuffer()
      await new Promise(resolve => setTimeout(resolve, wait))
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Fly API ${method} ${path || '/'}: ${res.status} ${text.slice(0, 300)}`)
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return text
    }
  }

  return {
    list: () => call('GET', ''),
    get: id => call('GET', `/${id}`),
    create: spec => call('POST', '', spec),
    start: id => call('POST', `/${id}/start`),
    suspend: id => call('POST', `/${id}/suspend`),
    destroy: id => call('DELETE', `/${id}?force=true`),
    setMetadata: (id, key, value) => call('POST', `/${id}/metadata/${key}`, { value }),
  }
}
