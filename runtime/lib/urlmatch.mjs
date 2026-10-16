// Shared URL allowlist matcher, used by both the runtime policy (enforcement)
// and the plugin (permission gating) so the two can never drift apart.
//
// Patterns look like "http://localhost:*", "*://*:*" or a bare "*".

export const DEFAULT_PORTS = { http: "80", https: "443", ws: "80", wss: "443" }

export function matchUrlPattern(pattern, rawUrl) {
  if (pattern === "*") return true
  let target
  try {
    const x = new URL(String(rawUrl).includes("://") ? rawUrl : `http://${rawUrl}`)
    const scheme = x.protocol.replace(":", "").toLowerCase()
    target = { scheme, host: x.hostname.toLowerCase(), port: x.port || DEFAULT_PORTS[scheme] }
  } catch {
    return false
  }
  const m = /^(\*|[a-z]+):\/\/(\*|\[[^\]]+\]|[^:/]+)(?::(\*|\d+))?$/i.exec(String(pattern).trim())
  if (!m) return false
  const [, scheme, host, port] = m
  const schemeOk = scheme === "*" || scheme.toLowerCase() === target.scheme
  const hostOk = host === "*" || host.toLowerCase() === target.host
  const portOk = !port || port === "*" || port === target.port
  return schemeOk && hostOk && portOk
}
