// Fast, dependency-free unit tests for the pure runtime modules. No browser,
// no network — safe for CI. Integration suites live in run-scenario / run-cdp.

import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const lib = (p) => pathToFileURL(path.join(here, "..", "runtime", "lib", p)).href

const { matchUrlPattern } = await import(lib("urlmatch.mjs"))
const policy = await import(lib("policy.mjs"))
const { parseNdjson, eachNdjson } = await import(lib("zip.mjs"))
const { encodePng, decodePng, diffPng } = await import(lib("pngdiff.mjs"))
const { decodeSourceMap, originalPositionFor } = await import(lib("sourcemap.mjs"))
const { resolveContainer, frameSelector, cdpBannerExpression } = await import(lib("container.mjs"))
const { normalizeExpression } = await import(lib("util.mjs"))
const { resolveProbeExpression, presetNames } = await import(lib("presets.mjs"))

const results = []
const check = (name, fn) => {
  try {
    fn()
    results.push({ name, ok: true })
    console.log(`PASS  ${name}`)
  } catch (err) {
    results.push({ name, ok: false, detail: err.message })
    console.log(`FAIL  ${name}  -> ${err.message}`)
  }
}

// --- urlmatch ---------------------------------------------------------------
check("urlmatch: wildcard scheme/host/port", () => {
  assert.equal(matchUrlPattern("*", "https://anything.example/x"), true)
  assert.equal(matchUrlPattern("http://localhost:*", "http://localhost:3000/app"), true)
  assert.equal(matchUrlPattern("http://localhost:*", "http://127.0.0.1:3000/app"), false)
  assert.equal(matchUrlPattern("*://*:*", "ws://127.0.0.1:9222/devtools"), true)
  assert.equal(matchUrlPattern("https://staging.myapp.com", "https://staging.myapp.com/path"), true)
  assert.equal(matchUrlPattern("http://localhost:*", "https://localhost:3000"), false)
  assert.equal(matchUrlPattern("http://localhost:80", "http://localhost/"), true)
})

// --- policy -----------------------------------------------------------------
const P = policy.mergePolicy({})

check("policy: isUrlAllowed honours allowlist", () => {
  assert.equal(policy.isUrlAllowed("http://127.0.0.1:5173/app", P), true)
  assert.equal(policy.isUrlAllowed("http://example.com/", P), false)
  const extended = policy.mergePolicy({ allowedOrigins: ["https://staging.myapp.com"] })
  assert.equal(policy.isUrlAllowed("https://staging.myapp.com/x", extended), true)
})

check("policy: isPathAllowed sandbox", () => {
  const roots = [os.tmpdir()]
  assert.equal(policy.isPathAllowed(path.join(os.tmpdir(), "sub", "file.txt"), roots), true)
  assert.equal(policy.isPathAllowed(path.join(os.tmpdir(), "..", "elsewhere"), roots), false)
  assert.equal(policy.isPathAllowed("", roots), true)
})

check("policy: redactValue masks sensitive keys and token patterns", () => {
  const out = policy.redactValue(
    { password: "hunter2", Authorization: "Bearer abcdef0123456789abcdef0123456789", jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef123456", note: "keep me", nested: { apiKey: "xyz" } },
    P
  )
  assert.equal(out.password, policy.REDACTED)
  assert.equal(out.Authorization, policy.REDACTED)
  assert.equal(out.jwt, policy.REDACTED)
  assert.equal(out.apiKey, undefined)
  assert.equal(out.nested.apiKey, policy.REDACTED)
  assert.equal(out.note, "keep me")
})

check("policy: redactUrl masks sensitive query params", () => {
  const out = policy.redactUrl("https://x.test/cb?code=abc123&state=xyz", P)
  assert.match(out, /code=(%5B|\[)REDACTED(%5D|\])/)
  assert.match(out, /state=xyz/)
})

check("policy: limitValue trims oversized output", () => {
  const big = { items: Array.from({ length: 500 }, (_, i) => `item-${i}`) }
  const out = policy.limitValue(big, 1024)
  assert.equal(out.truncated, true)
  assert.ok(out.value.items.length < 500)
  assert.equal(policy.limitValue({ a: 1 }, 1024).truncated, undefined)
})

check("policy: mergePolicy deep-merges redaction/timeouts", () => {
  const m = policy.mergePolicy({ redaction: { entropyHeuristic: true }, timeouts: { step: 5000 } })
  assert.equal(m.redaction.entropyHeuristic, true)
  assert.equal(m.redaction.enabled, true)
  assert.equal(m.timeouts.step, 5000)
  assert.equal(m.timeouts.harness, 240000)
})

// --- zip ----------------------------------------------------------------------
check("zip: parseNdjson tolerates garbage and blank lines", () => {
  const rows = parseNdjson('{"a":1}\n\nnot json\n{"b":2}\n')
  assert.deepEqual(rows, [{ a: 1 }, { b: 2 }])
  let count = 0
  eachNdjson('{"a":1}\n{"b":2}\n{"c":3}', () => count++)
  assert.equal(count, 3)
})

// --- pngdiff ------------------------------------------------------------------
check("pngdiff: encode/decode round-trip", () => {
  const w = 3
  const h = 2
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 255
    rgba[i * 4 + 3] = 255
  }
  const png = encodePng(rgba, w, h)
  const decoded = decodePng(png)
  assert.equal(decoded.width, w)
  assert.equal(decoded.height, h)
  assert.equal(decoded.rgba[0], 255)
  assert.equal(decoded.rgba[1], 0)
  assert.equal(decoded.rgba[3], 255)
})

check("pngdiff: diffPng flags differing pixels", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gui-doctor-unit-"))
  const solid = (r, g, b) => {
    const buf = Buffer.alloc(4)
    buf[0] = r
    buf[1] = g
    buf[2] = b
    buf[3] = 255
    return encodePng(Buffer.concat(Array.from({ length: 4 }, () => buf)), 2, 2)
  }
  const a = path.join(dir, "a.png")
  const b = path.join(dir, "b.png")
  const d = path.join(dir, "diff.png")
  fs.writeFileSync(a, solid(255, 0, 0))
  fs.writeFileSync(b, solid(0, 0, 255))
  const same = diffPng(a, a)
  assert.equal(same.ratio, 0)
  const res = diffPng(a, b, { diffPath: d })
  assert.equal(res.ratio, 1)
  assert.ok(fs.existsSync(d))
})

// --- sourcemap ------------------------------------------------------------------
check("sourcemap: originalPositionFor decodes a simple mapping", () => {
  const map = decodeSourceMap({ version: 3, sources: ["src/app.ts"], names: [], mappings: "AAAA" })
  const pos = originalPositionFor(map, 1, 0)
  assert.equal(pos.source, "src/app.ts")
  assert.equal(pos.line, 1)
  assert.equal(pos.column, 0)
  assert.equal(originalPositionFor(map, 5, 0), null)
})

// --- container ------------------------------------------------------------------
check("container: resolveContainer defaults (web=iframe, cdp/electron=banner)", () => {
  const web = resolveContainer({ target: "web" })
  assert.equal(web.kind, "iframe")
  assert.equal(web.stripFrameAncestors, true)
  assert.equal(web.label, "gui-doctor")
  const cdp = resolveContainer({ target: "cdp" })
  assert.equal(cdp.kind, "banner")
  const el = resolveContainer({ target: "electron" })
  assert.equal(el.kind, "banner")
  assert.equal(resolveContainer({ target: "web", container: false }), null)
  assert.equal(resolveContainer({ target: "web", container: { enabled: false } }), null)
  assert.equal(frameSelector(web), "#gui-doctor-frame")
  assert.match(cdpBannerExpression(web, "http://x"), /gui-doctor-banner/)
  assert.match(cdpBannerExpression(web, "http://x"), /DOMContentLoaded/)
})

// --- util / presets ---------------------------------------------------------------
check("util: normalizeExpression wraps function forms only", () => {
  assert.equal(normalizeExpression("() => 1"), "(() => 1)()")
  assert.equal(normalizeExpression("function f() { return 1 }"), "(function f() { return 1 })()")
  assert.equal(normalizeExpression("1 + 1"), "1 + 1")
  assert.equal(normalizeExpression(""), "")
})

check("presets: resolveProbeExpression resolves and validates presets", () => {
  assert.match(resolveProbeExpression({ preset: "storage" }), /localStorage/)
  assert.match(resolveProbeExpression({ expression: "() => 1" }), /\(\) => 1/)
  assert.throws(() => resolveProbeExpression({ preset: "nope" }), /unknown probe preset/)
  assert.ok(presetNames().includes("vue") && presetNames().includes("pinia") && presetNames().includes("react"))
})

// --- actions (mock page) -------------------------------------------------------
const actions = await import(lib("actions.mjs"))
await (async () => {
  const calls = []
  const mkLocator = () => ({ click: async () => {}, press: async () => {}, waitFor: async () => {}, innerText: async () => "x", scrollIntoViewIfNeeded: async () => {} })
  const page = {
    locator: (ref) => {
      calls.push(`locator:${ref}`)
      return mkLocator()
    },
    getByTestId: (tid) => {
      calls.push(`testid:${tid}`)
      return mkLocator()
    },
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    mouse: { wheel: async () => {} },
  }

  await actions.runStep(page, { action: "click", testId: "submit-btn" }, { index: 0 })
  check("actions: plugin-style camelCase testId resolves via getByTestId", () => assert.ok(calls.includes("testid:submit-btn"), JSON.stringify(calls)))

  await actions.runStep(page, { action: "click", testid: "submit-btn" }, { index: 0 })
  check("actions: lowercase testid still resolves", () => assert.equal(calls.filter((c) => c === "testid:submit-btn").length, 2, JSON.stringify(calls)))

  // runStep records missing-target failures on its result rather than throwing.
  const res = await actions.runStep(page, { action: "click" }, { index: 0 })
  check("actions: missing target fails with a hint", () => {
    assert.equal(res.ok, false)
    assert.match(res.error ?? "", /selector|testId/)
  })
})()

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) process.exit(1)
