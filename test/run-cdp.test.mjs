import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const runtime = path.join(here, "..", "runtime")
const fixtures = path.join(here, "fixtures")
const outRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gui-doctor-cdp-"))

const results = []
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail })
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  -> ${detail}`}`)
}

function findEdge() {
  const candidates = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]
  return candidates.find((p) => fs.existsSync(p))
}

function startServer(htmlFile) {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/data") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ msg: "ok" }))
    res.writeHead(200, { "content-type": "text/html" }).end(fs.readFileSync(htmlFile, "utf8"))
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })))
}

async function waitForCdp(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

async function main() {
  const edge = findEdge()
  if (!edge) {
    console.log("SKIP  CDP test (no Edge browser found)")
    return
  }
  const { server, port: httpPort } = await startServer(path.join(fixtures, "app.html"))
  const url = `http://127.0.0.1:${httpPort}/app.html`

  const cdpPort = 20000 + Math.floor(Math.random() * 20000)
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gui-doctor-edge-"))
  const child = spawn(edge, [`--headless=new`, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"], {
    stdio: "ignore",
  })

  try {
    const ready = await waitForCdp(cdpPort)
    check("edge: remote debugging reachable", ready, `port ${cdpPort}`)
    if (!ready) return

    const work = fs.mkdtempSync(path.join(outRoot, "run-"))
    const jobPath = path.join(work, "job.json")
    const outPath = path.join(work, "out.json")
    fs.writeFileSync(
      jobPath,
      JSON.stringify({
        cdp: { endpoint: `http://127.0.0.1:${cdpPort}` },
        goto: url,
        duration: 800,
        container: { label: "e2e-cdp" },
        probes: [{ name: "title", expression: "document.title" }, { name: "banner", expression: "!!document.getElementById('gui-doctor-banner')" }],
        perf: { enabled: true },
        policy: { allowJsProbes: true },
        outputDir: path.join(outRoot, "cdp"),
      })
    )
    const code = await new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join(runtime, "cdp-perf.mjs"), jobPath, outPath], { cwd: path.resolve(here, "..") })
      c.on("close", resolve)
    })
    const data = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null
    check("cdp: harness succeeded", code === 0 && data?.ok, data?.error ?? `exit ${code}`)
    check("cdp: probe read title", data?.probes?.[0]?.value === "GUI Doctor Fixture", JSON.stringify(data?.probes?.[0]))
    check("cdp: container banner injected", data?.probes?.[1]?.value === true && data?.container?.kind === "banner", JSON.stringify(data?.probes?.[1]) + JSON.stringify(data?.container))
    check("cdp: perf trace written", data?.perfTraceFile && fs.existsSync(data.perfTraceFile) && fs.statSync(data.perfTraceFile).size > 100, data?.perfTraceFile ?? "missing")
    if (data?.perfTraceFile && fs.existsSync(data.perfTraceFile)) {
      const head = fs.readFileSync(data.perfTraceFile, "utf8").slice(0, 200)
      check("cdp: perf trace looks like DevTools trace", /traceEvents|"cat"|"name"/.test(head), head.slice(0, 120))
    }
  } finally {
    child.kill()
    server.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
