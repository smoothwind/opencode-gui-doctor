import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { resolveModule, writeJson, detectBrowserChannel } from "./lib/util.mjs"

// usage: node env-check.mjs <projectDir> <out.json>
const [projectDir, outFile] = process.argv.slice(2)
const selfDir = path.dirname(fileURLToPath(import.meta.url))

const roots = [projectDir, selfDir, process.env.GUI_DOCTOR_PLUGIN_ROOT, process.cwd()].filter(Boolean)
const report = { ok: true, node: process.version, platform: process.platform, playwright: null, browsers: {}, hints: [] }

try {
  const resolved = resolveModule(["playwright", "playwright-core", "@playwright/test"], roots)
  report.playwright = { name: resolved.name, path: resolved.path, root: resolved.root }
} catch (err) {
  report.playwright = { error: err.message, tried: err.tried }
  report.hints.push("Install Playwright: `npm i -D playwright` (then `npx playwright install chromium`), or use a system browser channel msedge/chrome.")
}

const detected = detectBrowserChannel()
report.browsers = { chrome: detected.chrome, edge: detected.edge, channelSuggestion: detected.channelSuggestion, platform: process.platform }

if (!report.browsers.channelSuggestion) report.hints.push("No system Chrome/Edge detected — install a browser (`npx playwright install chromium`) after installing Playwright.")

const payload = JSON.stringify(report, null, 2)
if (outFile) writeJson(path.resolve(outFile), report)
process.stdout.write(`${payload}\n`)
