import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

export const nowIso = () => new Date().toISOString()

// Structured progress channel. The harness streams one JSON object per line to
// stdout, prefixed with a marker so the plugin (which streams stdout live) can
// tell progress apart from the final JSON result and from ordinary logging.
export const PROGRESS_MARKER = "@@gui-progress@@"

export function emitProgress(payload) {
  try {
    process.stdout.write(`${PROGRESS_MARKER}${JSON.stringify(payload)}\n`)
  } catch {
    /* progress is best-effort and must never break a run */
  }
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8")
}

export function truncate(value, max = 4000) {
  if (value == null) return value
  const text = typeof value === "string" ? value : safeStringify(value)
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text
}

export function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

// Resolve a module from a set of candidate roots, falling back to global probes.
export function resolveModule(names, roots = []) {
  const tried = []
  for (const root of roots.filter(Boolean)) {
    const req = createRequire(path.join(root, "noop.js"))
    for (const name of names) {
      try {
        return { name, path: req.resolve(name), root }
      } catch {
        tried.push(path.join(root, name))
      }
    }
  }
  // Environment override
  if (process.env.GUI_DOCTOR_PLAYWRIGHT) {
    return { name: "env", path: process.env.GUI_DOCTOR_PLAYWRIGHT, root: null }
  }
  const err = new Error(
    `Could not resolve any of [${names.join(", ")}]. Tried:\n${tried.map((t) => `  - ${t}`).join("\n")}\n` +
      `Install with: npm i -D playwright  (or set GUI_DOCTOR_PLAYWRIGHT=/abs/path/to/playwright/index.js)`
  )
  err.code = "MODULE_NOT_FOUND"
  err.tried = tried
  throw err
}

export async function importModule(absPath) {
  const url = absPath.startsWith("file:") ? absPath : pathToFileURL(absPath).href
  return import(url)
}

// Playwright's page.evaluate treats a bare function-expression string as an
// expression that yields a function (serialized to undefined). Wrap function
// forms so probes actually run.
export function normalizeExpression(expr) {
  const t = String(expr ?? "").trim()
  if (!t) return t
  const isFunc = /^(async\s+function|function)\b/.test(t) || /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(t)
  return isFunc ? `(${t})()` : t
}

export function isTruthyEnv(name) {
  const value = process.env[name]
  return value != null && value !== "" && value !== "0" && value.toLowerCase() !== "false"
}

export function withTimeout(promise, ms, label = "operation") {
  if (!ms || ms <= 0) return promise
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms)
    }),
  ])
}

// Cross-platform executable lookup on PATH.
export function findExecutable(names) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext)
        try {
          if (fs.existsSync(candidate)) return candidate
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null
}

const BROWSER_CANDIDATES = {
  win32: {
    chrome: ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"],
    edge: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"],
  },
  darwin: {
    chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
    edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
  },
  linux: { chrome: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"], edge: ["/usr/bin/microsoft-edge"] },
}

export function detectBrowserChannel() {
  const table = BROWSER_CANDIDATES[process.platform] ?? {}
  const chrome = (table.chrome ?? []).find((p) => fs.existsSync(p)) ?? null
  const edge = (table.edge ?? []).find((p) => fs.existsSync(p)) ?? null
  return { chrome, edge, channelSuggestion: edge ? "msedge" : chrome ? "chrome" : null }
}
