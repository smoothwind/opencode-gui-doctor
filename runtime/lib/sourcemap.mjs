// Minimal Source Map v3 decoder (base64 VLQ) + best-effort stack resolver.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
const CHAR = Object.fromEntries([...B64].map((c, i) => [c, i]))

function decodeVLQ(str) {
  const out = []
  let shift = 0
  let value = 0
  for (const ch of str) {
    const digit = CHAR[ch]
    if (digit === undefined) continue
    const cont = digit & 0x20
    value += (digit & 0x1f) << shift
    if (cont) {
      shift += 5
    } else {
      const negate = value & 1
      value >>= 1
      out.push(negate ? -value : value)
      value = 0
      shift = 0
    }
  }
  return out
}

export function parseMappings(mappings) {
  const lines = []
  let srcIdx = 0
  let origLine = 0
  let origCol = 0
  let nameIdx = 0
  for (const lineStr of mappings.split(";")) {
    let genCol = 0
    const segs = []
    for (const segStr of lineStr.split(",")) {
      if (!segStr) continue
      const f = decodeVLQ(segStr)
      genCol += f[0]
      const seg = { genCol }
      if (f.length >= 4) {
        srcIdx += f[1]
        origLine += f[2]
        origCol += f[3]
        seg.srcIdx = srcIdx
        seg.origLine = origLine
        seg.origCol = origCol
        if (f.length >= 5) {
          nameIdx += f[4]
          seg.nameIdx = nameIdx
        }
      }
      segs.push(seg)
    }
    lines.push(segs)
  }
  return lines
}

// line: 1-based generated line; column: 0-based generated column.
export function originalPositionFor(map, line, column) {
  if (!map || !map._parsed) return null
  const segs = map._parsed[line - 1]
  if (!segs || segs.length === 0) return null
  let best = null
  for (const seg of segs) {
    if (seg.genCol <= column && seg.srcIdx !== undefined) best = seg
    else if (seg.genCol > column) break
  }
  if (!best) return null
  return {
    source: map.sources?.[best.srcIdx] ?? null,
    line: best.origLine + 1,
    column: best.origCol,
    name: best.nameIdx !== undefined ? map.names?.[best.nameIdx] : undefined,
  }
}

export function decodeSourceMap(jsonText) {
  const map = typeof jsonText === "string" ? JSON.parse(jsonText) : jsonText
  map._parsed = parseMappings(map.mappings ?? "")
  return map
}

// Resolves a Chrome-style stack to original positions where source maps exist.
export async function resolveStack(stackText, { fetchMap, cache = new Map() } = {}) {
  if (!stackText || typeof stackText !== "string" || !fetchMap) return { frames: [], mappedStack: stackText }
  const frames = []
  const re = /(?:at\s+(.*?)\s+\()?((?:https?|file|webpack|blob)[^()\s]*?):(\d+):(\d+)\)?/g
  let m
  while ((m = re.exec(stackText))) {
    const [, fn, url, lineStr, colStr] = m
    const frame = { function: fn ?? null, url, line: Number(lineStr), column: Number(colStr), original: null }
    try {
      const base = url.replace(/[?#].*$/, "")
      if (!cache.has(base)) {
        const text = await fetchMap(`${base}.map`)
        cache.set(base, text ? decodeSourceMap(text) : null)
      }
      const map = cache.get(base)
      if (map) frame.original = originalPositionFor(map, frame.line, frame.column)
    } catch {
      /* best-effort */
    }
    frames.push(frame)
  }
  const mappedStack = stackText + (frames.some((f) => f.original) ? `\n--- source-mapped ---\n${frames.filter((f) => f.original).map((f) => `at ${f.function ?? "<anon>"} (${f.original.source}:${f.original.line}:${f.original.column})`).join("\n")}` : "")
  return { frames, mappedStack }
}

// Playwright APIRequestContext-based fetcher (shares cookies/storage with the page).
export function makeContextFetcher(request) {
  return async (url) => {
    try {
      const res = await request.get(url, { timeout: 4000 })
      if (!res.ok()) return null
      const text = await res.text()
      if (!text.trim().startsWith("{")) return null
      return text
    } catch {
      return null
    }
  }
}
