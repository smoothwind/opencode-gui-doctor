import fs from "node:fs"
import zlib from "node:zlib"

// Minimal ZIP archive reader. Supports STORE (0) and DEFLATE (8) entries,
// which covers Playwright's `trace.zip` output. Avoids adding a dependency.

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

export function readZip(file, filter) {
  const buf = fs.readFileSync(file)
  const eocd = findEOCD(buf)
  if (eocd < 0) throw new Error(`Not a ZIP archive (no EOCD): ${file}`)

  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)

  const entries = new Map()
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== CD_SIG) break
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen

    const wanted = !filter || filter(name)
    if (!wanted) {
      entries.set(name, { name, method, data: null, size: compressedSize, skipped: true })
      continue
    }

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else data = null

    entries.set(name, { name, method, data, size: compressedSize })
  }
  return entries
}

// Only inflates entries matching `filter` (perf/memory: skip screenshots & blobs).
export function readZipText(file, filter) {
  const entries = readZip(file, filter)
  const out = new Map()
  for (const [name, entry] of entries) {
    if (entry.data && !name.endsWith("/")) out.set(name, entry.data.toString("utf8"))
  }
  return out
}

// Parse newline-delimited JSON, tolerating blank/garbage lines.
export function parseNdjson(text) {
  const rows = []
  eachNdjson(text, (row) => rows.push(row))
  return rows
}

// Stream newline-delimited JSON without materialising an intermediate array of
// strings or rows (keeps memory flat on large traces).
export function eachNdjson(text, cb) {
  const len = text.length
  let start = 0
  while (start < len) {
    let end = text.indexOf("\n", start)
    if (end === -1) end = len
    const line = text.slice(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      cb(JSON.parse(line))
    } catch {
      // skip malformed line
    }
  }
}
