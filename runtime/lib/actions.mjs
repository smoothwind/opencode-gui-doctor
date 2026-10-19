// Deterministic UI step engine shared by record / replay / fork modes.
import { normalizeExpression } from "./util.mjs"
import { frameSelector, evalInApp, appFrame, navigateApp, waitForAppUrl, waitForAppLoadState } from "./container.mjs"

// Resolve a page locator, optionally scoped to a container frame and/or an
// explicit iframe chain (step.frame).
function scopeRoot(page, step, ctx = {}) {
  const frames = step.frame == null ? [] : Array.isArray(step.frame) ? step.frame : [step.frame]
  let root = page
  if (ctx.container?.kind === "iframe") root = root.frameLocator(frameSelector(ctx.container))
  for (const f of frames) root = root.frameLocator(f)
  return root
}

// A step targets an element via selector/ref or a data-testid (both spellings
// accepted: the plugin schema exposes camelCase `testId`, the runtime
// historically read lowercase `testid`).
function hasTarget(step) {
  return Boolean(step?.selector || step?.ref || step?.target || step?.testid || step?.testId)
}

function resolveLocator(page, step, ctx = {}) {
  const root = scopeRoot(page, step, ctx)
  const testid = step.testid ?? step.testId
  if (testid) return root.getByTestId(testid)
  const ref = step.selector ?? step.ref ?? step.target
  if (!ref) throw new Error(`step requires 'selector'/'ref'/'testId': ${JSON.stringify(step)}`)
  return root.locator(ref)
}

export async function runStep(page, step, ctx = {}) {
  const action = step.action
  const timeout = step.timeout ?? ctx.defaultTimeout
  const started = Date.now()
  const result = { index: ctx.index ?? null, action, ok: true, error: null, durationMs: 0 }
  const opts = timeout ? { timeout } : undefined

  try {
    if (action === "goto" || action === "navigate") {
      const url = step.value ?? step.url
      if (ctx.container?.kind === "iframe") {
        await navigateApp(page, ctx.container, url, { waitUntil: step.waitUntil ?? "load", timeout })
        if (step.waitForIdle) await waitForAppLoadState(page, ctx.container, "networkidle", { timeout })
      } else {
        await page.goto(url, { waitUntil: step.waitUntil ?? "load", timeout })
        if (step.waitForIdle) await page.waitForLoadState("networkidle", { timeout }).catch(() => {})
      }
    } else if (action === "waitForURL") {
      if (ctx.container?.kind === "iframe") await waitForAppUrl(page, ctx.container, step.value ?? step.url, { timeout })
      else await page.waitForURL(step.value ?? step.url, opts)
    } else if (action === "click") {
      await resolveLocator(page, step, ctx).click(opts)
    } else if (action === "dblclick") {
      await resolveLocator(page, step, ctx).dblclick(opts)
    } else if (action === "hover") {
      await resolveLocator(page, step, ctx).hover(opts)
    } else if (action === "fill" || action === "type") {
      const loc = resolveLocator(page, step, ctx)
      if (action === "fill") await loc.fill(step.value ?? "", opts)
      else {
        await loc.click(opts)
        // `type()` is deprecated in favour of pressSequentially (Playwright 1.38+).
        if (typeof loc.pressSequentially === "function") await loc.pressSequentially(step.value ?? "", opts)
        else await loc.type(step.value ?? "", opts)
      }
    } else if (action === "press") {
      if (hasTarget(step)) {
        await resolveLocator(page, step, ctx).press(step.value, opts)
      } else {
        // Global key press: with an iframe container, route the key into the app
        // frame by focusing it first, otherwise the key lands on the wrapper.
        if (ctx.container?.kind === "iframe") await page.locator(frameSelector(ctx.container)).focus().catch(() => {})
        await page.keyboard.press(step.value, opts)
      }
    } else if (action === "check" || action === "uncheck") {
      await resolveLocator(page, step, ctx)[action](opts)
    } else if (action === "select") {
      await resolveLocator(page, step, ctx).selectOption(step.value ?? { label: step.label }, opts)
    } else if (action === "setInputFiles") {
      await resolveLocator(page, step, ctx).setInputFiles(step.value, opts)
    } else if (action === "dragTo") {
      const dest = scopeRoot(page, step, ctx).locator(step.targetSelector ?? step.to)
      await resolveLocator(page, step, ctx).dragTo(dest, opts)
    } else if (action === "waitForSelector") {
      const state = step.state ?? "visible"
      await resolveLocator(page, step, ctx).waitFor({ state, timeout })
    } else if (action === "waitForTimeout" || action === "wait") {
      const ms = Number(step.value ?? step.ms ?? 500)
      if (hasTarget(step)) await resolveLocator(page, step, ctx).waitFor({ state: step.state ?? "visible", timeout: ms })
      else await page.waitForTimeout(ms)
    } else if (action === "waitForLoadState") {
      if (ctx.container?.kind === "iframe") await waitForAppLoadState(page, ctx.container, step.value ?? "networkidle", { timeout })
      else await page.waitForLoadState(step.value ?? "networkidle", { timeout }).catch(() => {})
    } else if (action === "reload") {
      if (ctx.container?.kind === "iframe") {
        const src = await page.evaluate((sel) => document.querySelector(sel)?.src, frameSelector(ctx.container))
        await navigateApp(page, ctx.container, src, { waitUntil: step.waitUntil ?? "load", timeout })
      } else {
        await page.reload({ waitUntil: step.waitUntil ?? "load", timeout })
      }
    } else if (action === "goBack") {
      if (ctx.container?.kind === "iframe") {
        await evalInApp(page, ctx.container, "() => history.back()")
        await waitForAppLoadState(page, ctx.container, step.waitUntil ?? "load", { timeout })
      } else {
        await page.goBack({ waitUntil: step.waitUntil ?? "load", timeout })
      }
    } else if (action === "scroll") {
      if (hasTarget(step)) await resolveLocator(page, step, ctx).scrollIntoViewIfNeeded(opts)
      else await page.mouse.wheel(Number(step.dx ?? 0), Number(step.dy ?? step.value ?? 300))
    } else if (action === "scrollIntoViewIfNeeded") {
      await resolveLocator(page, step, ctx).scrollIntoViewIfNeeded(opts)
    } else if (action === "clear") {
      await resolveLocator(page, step, ctx).fill("", opts)
    } else if (action === "focus") {
      await resolveLocator(page, step, ctx).focus(opts)
    } else if (action === "waitForFunction") {
      // normalizeExpression turns "() => cond" into "(() => cond)()", which
      // waitForFunction re-evaluates on every poll until truthy.
      const code = normalizeExpression(step.function ?? step.value)
      if (ctx.container?.kind === "iframe") {
        const f = appFrame(page, ctx.container)
        if (!f) throw new Error("container: app frame not found")
        await f.waitForFunction(code, step.arg, { timeout })
      } else {
        await page.waitForFunction(code, step.arg, { timeout })
      }
    } else if (action === "screenshot") {
      result.file = ctx.screenshotPath?.(result.index) ?? step.path
      if (result.file) await page.screenshot({ path: result.file, fullPage: !!step.fullPage })
    } else if (action === "evaluate" || action === "eval") {
      const code = normalizeExpression(step.function ?? step.value)
      result.value = ctx.container?.kind === "iframe" ? await evalInApp(page, ctx.container, code, step.arg) : await page.evaluate(code, step.arg)
    } else if (action === "expectText") {
      const expected = String(step.value ?? step.expect ?? "")
      const mode = step.mode ?? "contains"
      const limit = timeout ?? 5000
      const deadline = Date.now() + limit
      const loc = resolveLocator(page, step, ctx)
      // innerText throws when the element is missing, so wait for it to attach
      // first, then poll its text (short per-read timeout) until the deadline.
      await loc.waitFor({ state: "attached", timeout: limit }).catch(() => {})
      let actual = ""
      for (;;) {
        try {
          actual = (await loc.innerText({ timeout: 250 })).trim()
        } catch {
          actual = ""
        }
        if (mode === "equals" ? actual === expected : actual.includes(expected)) break
        if (Date.now() > deadline) throw new Error(`expectText(${mode}) failed within ${limit}ms: expected "${expected}", got "${actual || "<no element>"}"`)
        await page.waitForTimeout(100)
      }
      result.value = actual
    } else if (action === "expectVisible") {
      // Auto-wait instead of an instantaneous isVisible() so assertions are not
      // flaky by construction.
      const loc = resolveLocator(page, step, ctx)
      try {
        await loc.waitFor({ state: "visible", timeout: timeout ?? 5000 })
        result.value = true
      } catch {
        result.value = false
        throw new Error(`expectVisible failed for ${step.selector ?? step.ref} within ${timeout ?? 5000}ms`)
      }
    } else if (action === "expectCount") {
      const expected = Number(step.value ?? step.expect)
      const deadline = Date.now() + (timeout ?? 5000)
      let count = 0
      for (;;) {
        count = await scopeRoot(page, step, ctx).locator(step.selector ?? step.ref).count()
        if (count === expected) break
        if (Date.now() > deadline) throw new Error(`expectCount failed within ${timeout ?? 5000}ms: expected ${expected}, got ${count}`)
        await page.waitForTimeout(100)
      }
      result.value = count
    } else {
      throw new Error(`unknown action: ${action}`)
    }
  } catch (err) {
    result.ok = false
    result.error = err && err.message ? err.message : String(err)
  }

  result.durationMs = Date.now() - started
  return result
}

export async function runSteps(page, steps, ctx = {}) {
  const results = []
  for (let i = 0; i < steps.length; i++) {
    const stepCtx = { ...ctx, index: i }
    ctx.onStepStart?.(steps[i], i)
    const res = await runStep(page, steps[i], stepCtx)
    if (!res.ok && ctx.screenshotOnFailure) {
      const file = ctx.screenshotOnFailure(i)
      if (file) {
        try {
          await page.screenshot({ path: file })
          res.failureScreenshot = file
        } catch {
          /* page may be closed */
        }
      }
    }
    results.push(res)
    ctx.onStep?.(res, i)
    if (!res.ok && stepCtx.stopOnFailure !== false && steps[i].optional !== true && ctx.stopOnFailure !== false) break
  }
  return results
}
