// Dependency-free PNG decode/encode + pixel diff for cross-fork visual diffing.
// Supports 8-bit non-interlaced RGB(2)/RGBA(6) PNGs (what Playwright emits).

import fs from "node:fs"
import zlib from "node:zlib"

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG")
  let off = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString("ascii", off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === "IDAT") idat.push(data)
    else if (type === "IEND") break
    off += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error("interlaced PNG unsupported")
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (!channels) throw new Error(`unsupported color type ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      cur[i] = v & 0xff
    }
    cur.copy(prev)
    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (channels === 4) {
        out[d] = cur[s]
        out[d + 1] = cur[s + 1]
        out[d + 2] = cur[s + 2]
        out[d + 3] = cur[s + 3]
      } else if (channels === 3) {
        out[d] = cur[s]
        out[d + 1] = cur[s + 1]
        out[d + 2] = cur[s + 2]
        out[d + 3] = 255
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[s]
        out[d + 3] = 255
      }
    }
  }
  return { width, height, rgba: out }
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))])
}

export function diffPng(fileA, fileB, { threshold = 12, diffPath } = {}) {
  const a = decodePng(fs.readFileSync(fileA))
  const b = decodePng(fs.readFileSync(fileB))
  const result = { widthA: a.width, heightA: a.height, widthB: b.width, heightB: b.height, dimsDiffer: a.width !== b.width || a.height !== b.height }
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const total = w * h
  let changed = 0
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < total; i++) {
    const d = i * 4
    const dr = Math.abs(a.rgba[d] - b.rgba[d])
    const dg = Math.abs(a.rgba[d + 1] - b.rgba[d + 1])
    const db = Math.abs(a.rgba[d + 2] - b.rgba[d + 2])
    const diff = Math.max(dr, dg, db)
    if (diff > threshold) {
      changed++
      out[d] = 255
      out[d + 1] = 60
      out[d + 2] = 0
      out[d + 3] = 255
    } else {
      const g = Math.round((a.rgba[d] + a.rgba[d + 1] + a.rgba[d + 2]) / 6 + 180)
      out[d] = out[d + 1] = out[d + 2] = g
      out[d + 3] = 255
    }
  }
  result.changedPixels = changed
  result.totalPixels = total
  result.ratio = total ? +(changed / total).toFixed(4) : 0
  if (diffPath) {
    fs.writeFileSync(diffPath, encodePng(out, w, h))
    result.diffPath = diffPath
  }
  return result
}
