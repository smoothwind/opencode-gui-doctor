// Minimal Chrome DevTools Protocol client over the WebSocket available in
// Node >= 22 (global WebSocket). No third-party dependency required.

export async function fetchJson(url, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Accepts "http://host:port", "host:port" or a ws:// debugger url.
export function normalizeEndpoint(endpoint) {
  if (!endpoint) return null
  if (/^wss?:\/\//i.test(endpoint)) return endpoint
  if (/^https?:\/\//i.test(endpoint)) return endpoint.replace(/\/+$/, "")
  return `http://${endpoint.replace(/\/+$/, "")}`
}

export async function listTargets(endpoint) {
  const base = normalizeEndpoint(endpoint)
  if (/^wss?:\/\//i.test(base)) return [{ webSocketDebuggerUrl: base, type: "unknown" }]
  const list = await fetchJson(`${base}/json/list`)
  return Array.isArray(list) ? list : []
}

export async function resolveTargetWsUrl(endpoint, { match } = {}) {
  const base = normalizeEndpoint(endpoint)
  if (/^wss?:\/\//i.test(base)) return base
  const targets = await listTargets(base)
  const pick =
    targets.find((t) => t.type === "page" && (!match || (t.url || "").includes(match))) ??
    targets.find((t) => t.type === "page") ??
    targets.find((t) => t.webSocketDebuggerUrl)
  if (!pick || !pick.webSocketDebuggerUrl) {
    throw new Error(`No CDP target found at ${endpoint}. Start Chrome with --remote-debugging-port=9222`)
  }
  return pick.webSocketDebuggerUrl
}

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Map()
    this.ws = null
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      const onError = (e) => reject(new Error(`CDP connect failed: ${e?.message ?? "unknown"}`))
      ws.addEventListener("open", () => {
        ws.removeEventListener("error", onError)
        resolve()
      })
      ws.addEventListener("error", onError)
      ws.addEventListener("close", () => {
        for (const { reject } of this.pending.values()) reject(new Error("CDP socket closed"))
        this.pending.clear()
      })
      ws.addEventListener("message", (ev) => this._onMessage(ev.data))
    })
    return this
  }

  _onMessage(data) {
    let msg
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString())
    } catch {
      return
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`))
      else resolve(msg.result)
    } else if (msg.method) {
      const handlers = this.listeners.get(msg.method)
      if (handlers) for (const h of handlers) h(msg.params, msg.method)
      const anyHandlers = this.listeners.get("*")
      if (anyHandlers) for (const h of anyHandlers) h(msg.params, msg.method)
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`CDP timeout: ${method}`))
          }, timeoutMs)
        : null
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event).push(handler)
    return this
  }

  waitFor(event, { predicate, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP waitFor timeout: ${event}`)), timeoutMs)
      const handler = (params) => {
        if (!predicate || predicate(params)) {
          clearTimeout(timer)
          this.listeners.set(
            event,
            (this.listeners.get(event) ?? []).filter((h) => h !== handler)
          )
          resolve(params)
        }
      }
      this.on(event, handler)
    })
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }
}

export async function connectCdp(endpoint, options) {
  const wsUrl = await resolveTargetWsUrl(endpoint, options)
  const client = new CDP(wsUrl)
  await client.connect()
  return client
}
