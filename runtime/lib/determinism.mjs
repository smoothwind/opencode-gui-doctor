// Deterministic replay: seeded randomness, frozen clock and HAR-backed network
// so forks differ only by the hypothesis under test.

import fs from "node:fs"

// mulberry32 seeded PRNG, injected before any page script runs.
export function seedInitScript(seed) {
  const s = (Number(seed) >>> 0) || 1
  return `(() => {
    let a = ${s};
    Math.random = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();`
}

export function loadHar(harPath) {
  const har = JSON.parse(fs.readFileSync(harPath, "utf8"))
  return {
    entries: (har.log?.entries ?? []).map((e) => ({
      method: e.request?.method,
      url: e.request?.url,
      status: e.response?.status ?? 200,
      statusText: e.response?.statusText ?? "",
      headers: Object.fromEntries((e.response?.headers ?? []).map((h) => [h.name, h.value])),
      mimeType: e.response?.content?.mimeType,
      text: e.response?.content?.text,
      encoding: e.response?.content?.encoding,
      used: false,
    })),
  }
}

const normalize = (u) => {
  try {
    const x = new URL(u)
    return `${x.origin}${x.pathname}${x.search}`
  } catch {
    return u
  }
}

// Returns a Playwright route handler that serves recorded HAR responses.
// Register BEFORE routeMocks so mocks (registered later) take precedence.
export function makeHarHandler(har, stats = { served: 0, passed: 0 }) {
  return async (route, request) => {
    const method = request.method()
    const url = request.url()
    let entry = har.entries.find((e) => !e.used && e.method === method && normalize(e.url) === normalize(url))
    if (!entry) entry = har.entries.find((e) => e.method === method && normalize(e.url) === normalize(url))
    if (!entry) {
      stats.passed++
      return route.continue()
    }
    entry.used = true
    stats.served++
    const headers = { ...entry.headers }
    delete headers["content-encoding"]
    delete headers["content-length"]
    delete headers["Content-Encoding"]
    delete headers["Content-Length"]
    const body = entry.text != null ? (entry.encoding === "base64" ? Buffer.from(entry.text, "base64") : Buffer.from(entry.text)) : undefined
    await route.fulfill({ status: entry.status, headers, contentType: entry.mimeType, body })
  }
}
