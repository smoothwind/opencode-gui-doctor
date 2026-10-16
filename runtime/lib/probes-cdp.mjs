// CDP debugger breakpoint probes: pause at a (url,line) and read locals/scope
// via Debugger.evaluateOnCallFrame, then resume. Chromium-only; best-effort.

export async function installBreakpointProbes(page, specs, { log = () => {}, resumeTimeoutMs = 5000 } = {}) {
  const out = { results: [], errors: [] }
  if (!specs || specs.length === 0) return out

  let session
  try {
    session = await page.context().newCDPSession(page)
  } catch (err) {
    out.errors.push(`CDP session unavailable: ${err.message}`)
    return out
  }

  const bpMeta = new Map()
  const hits = new Map()

  const handlePause = async (params) => {
    const frame = params.callFrames?.[0]
    if (!frame) {
      await safeResume()
      return
    }
    const bpId = (params.hitBreakpoints ?? []).find((id) => bpMeta.has(id))
    const spec = bpId ? bpMeta.get(bpId) : specs[0]
    const values = {}
    for (const expr of spec.expressions ?? []) {
      try {
        const r = await session.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: expr, returnByValue: true, silent: true })
        values[expr] = r.exceptionDetails ? { error: r.exceptionDetails.text ?? "eval error" } : r.result?.value
      } catch (err) {
        values[expr] = { error: err.message }
      }
    }
    out.results.push({
      spec: spec.name ?? spec.urlRegex ?? spec.url,
      functionName: frame.functionName,
      url: frame.url,
      line: (frame.location?.lineNumber ?? 0) + 1,
      reason: params.reason,
      values,
    })
    if (bpId) {
      const count = (hits.get(bpId) ?? 0) + 1
      hits.set(bpId, count)
      if (count >= (spec.maxHits ?? 1) && session) {
        try {
          await session.send("Debugger.removeBreakpoint", { breakpointId: bpId })
        } catch {
          /* ignore */
        }
      }
    }
    await safeResume()
  }

  let resumeTimer = null
  const safeResume = async () => {
    if (resumeTimer) clearTimeout(resumeTimer)
    try {
      await session.send("Debugger.resume")
    } catch {
      /* already resumed / closed */
    }
  }

  try {
    await session.send("Debugger.enable")
    session.on("Debugger.paused", (params) => {
      // Safety: never let the page hang paused.
      resumeTimer = setTimeout(() => void safeResume(), resumeTimeoutMs)
      handlePause(params).catch((err) => out.errors.push(err.message))
    })
    for (const spec of specs) {
      const args = { columnNumber: spec.column ?? 0, lineNumber: (spec.line ?? 1) - 1 }
      if (spec.urlRegex) args.urlRegex = spec.urlRegex
      else if (spec.url) args.url = spec.url
      else {
        out.errors.push(`breakpointProbe '${spec.name ?? "?"}' requires urlRegex or url`)
        continue
      }
      const res = await session.send("Debugger.setBreakpointByUrl", args)
      bpMeta.set(res.breakpointId, spec)
      log(`[gui-doctor] breakpoint set @ ${spec.urlRegex ?? spec.url}:${args.lineNumber + 1}`)
    }
  } catch (err) {
    out.errors.push(err.message)
  }

  out.session = session
  return out
}

export async function disposeBreakpointProbes(probes) {
  try {
    await probes?.session?.detach()
  } catch {
    /* ignore */
  }
}
