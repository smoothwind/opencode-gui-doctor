#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))

function run(command, { capture = false } = {}) {
  const res = spawnSync(command, {
    cwd: pkgDir,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    shell: true
  })
  if (res.status !== 0) {
    console.error(`\n✗ ${command} failed (exit ${res.status ?? "null"}${res.error ? `: ${res.error.message}` : ""})`)
    process.exit(res.status ?? 1)
  }
  return (res.stdout ?? "").trim()
}

console.log("\n▶ typecheck")
run("npm run typecheck")

const pkgPath = path.join(pkgDir, "package.json")
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
if (!args.has("--no-bump")) {
  const [x, y, z] = String(pkg.version).split(".").map((n) => Number.parseInt(n, 10) || 0)
  const next = `${x}.${y}.${z + 1}`
  pkg.version = next
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`\n▶ bump version ${x}.${y}.${z} -> ${next}`)
} else {
  console.log(`\n▶ version kept at ${pkg.version} (--no-bump)`)
}

const distDir = path.join(pkgDir, "dist")
fs.mkdirSync(distDir, { recursive: true })
console.log("\n▶ pack")
const packed = run("npm pack --pack-destination dist", { capture: true })
const tgz = packed
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.endsWith(".tgz"))
  .pop()
if (!tgz) {
  console.error(`\n✗ could not find packed tarball in output:\n${packed}`)
  process.exit(1)
}
const tgzPath = path.join(distDir, tgz)
console.log(`  -> ${tgzPath}`)

if (!args.has("--no-install")) {
  console.log("\n▶ global install")
  run(`npm install -g "${tgzPath}"`)
}

console.log(`\n✓ opencode-gui-doctor@${pkg.version} packaged${args.has("--no-install") ? "" : " and installed globally"}`)
console.log(`  tarball: ${tgzPath}`)
if (!args.has("--no-install")) {
  console.log("\n  Use it in another project (inside that project):")
  console.log("    PowerShell :  npm i -D \"$(npm root -g)\\opencode-gui-doctor\"")
  console.log("    bash/zsh   :  npm i -D \"$(npm root -g)/opencode-gui-doctor\"")
  console.log("    opencode.json: { \"plugin\": [\"./node_modules/opencode-gui-doctor/plugin/index.ts\"] }")
}
