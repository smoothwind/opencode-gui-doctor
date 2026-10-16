// Visible, labelled container for the target under test.
//
// Two flavours:
//   - kind "iframe": (web targets) the app runs inside a real <iframe> that is
//     wrapped by a labelled toolbar + accent border, so the run is visibly
//     scoped inside its own container.
//   - kind "banner": (electron / cdp targets) the native window cannot be
//     wrapped in DOM, so a fixed, labelled banner + accent border are overlaid
//     on top of the live page instead.
//
// Enabled by default; pass `container: false` (job / --no-container) to opt out.

export const CONTAINER_FRAME_ID = "gui-doctor-frame"
export const CONTAINER_FRAME_NAME = "gui-doctor-frame"

const DEFAULT_LABEL = "gui-doctor"
const DEFAULT_ACCENT = "#38bdf8"
const DEFAULT_BORDER = 3
export const TOOLBAR_HEIGHT = 34

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}

// Normalise the job's `container` option into a concrete config, or null when
// disabled. Default is enabled, matching the plugin's default-on behaviour.
export function resolveContainer(job) {
  const raw = job?.container
  if (raw === false) return null
  const cfg = raw && typeof raw === "object" ? raw : {}
  if (cfg.enabled === false) return null
  const target = job?.target ?? "web"
  return {
    ...cfg,
    kind: target === "web" ? (cfg.kind ?? "iframe") : "banner",
    target,
    frameId: cfg.frameId ?? CONTAINER_FRAME_ID,
    frameName: cfg.frameName ?? CONTAINER_FRAME_NAME,
    label: cfg.label ?? DEFAULT_LABEL,
    accent: cfg.accent ?? DEFAULT_ACCENT,
    border: Number.isFinite(cfg.border) ? cfg.border : DEFAULT_BORDER,
    stripFrameAncestors: cfg.stripFrameAncestors !== false,
  }
}

export function frameSelector(cfg) {
  return `#${cfg.frameId}`
}

function containerHtml(cfg, appUrl) {
  const label = escapeHtml(cfg.label)
  const url = escapeHtml(appUrl ?? "about:blank")
  const accent = escapeHtml(cfg.accent)
  const border = cfg.border
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${label}</title>
<style>
  html,body{margin:0;height:100%}
  body{display:flex;flex-direction:column;height:100vh;background:#0d1117;font-family:system-ui,Segoe UI,Roboto,sans-serif}
  .gd-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;height:${TOOLBAR_HEIGHT}px;box-sizing:border-box;padding:0 12px;background:${accent};color:#04121a;font-size:12px;font-weight:600}
  .gd-dot{width:9px;height:9px;border-radius:50%;background:#f59e0b;flex:0 0 auto}
  .gd-label{letter-spacing:.2px}
  .gd-url{font-weight:400;opacity:.8;max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .gd-spacer{flex:1}
  .gd-frame-wrap{flex:1;position:relative;box-sizing:border-box;border:${border}px solid ${accent};border-top:none}
  #${cfg.frameId}{width:100%;height:100%;border:none;background:#fff}
</style></head>
<body>
  <div class="gd-toolbar" id="gui-doctor-toolbar">
    <span class="gd-dot" id="gui-doctor-dot"></span>
    <span class="gd-label">${label}</span>
    <span class="gd-url" id="gui-doctor-url">${url}</span>
    <span class="gd-spacer"></span>
    <span id="gui-doctor-clock"></span>
  </div>
  <div class="gd-frame-wrap">
    <iframe id="${cfg.frameId}" name="${cfg.frameName}" src="${url}"
      allow="camera; microphone; clipboard-read; clipboard-write; autoplay"
      referrerpolicy="strict-origin-when-cross-origin"></iframe>
  </div>
<script>
  (function(){
    var urlEl=document.getElementById('gui-doctor-url');
    var dot=document.getElementById('gui-doctor-dot');
    var clock=document.getElementById('gui-doctor-clock');
    function tick(){ clock.textContent=new Date().toLocaleTimeString(); }
    tick(); setInterval(tick,1000);
    var f=document.getElementById('${cfg.frameId}');
    if(f){ f.addEventListener('load', function(){ dot.style.background='#22c55e'; urlEl.textContent=f.src; }); }
  })();
</script>
</body></html>`
}

function bannerHtml(cfg, info) {
  const label = escapeHtml(cfg.label)
  const detail = escapeHtml(info ?? "")
  const accent = escapeHtml(cfg.accent)
  const border = cfg.border
  return (
    `<div id="gui-doctor-banner" style="position:fixed;top:0;left:0;right:0;height:${TOOLBAR_HEIGHT}px;z-index:2147483647;box-sizing:border-box;` +
    `background:${accent};color:#04121a;font:600 12px/1 system-ui,Segoe UI,Roboto,sans-serif;display:flex;align-items:center;gap:10px;padding:0 12px;pointer-events:none">` +
    `<span>${label}</span><span style="font-weight:400;opacity:.8">${detail}</span></div>` +
    `<div id="gui-doctor-border" style="position:fixed;inset:0;border:${border}px solid ${accent};z-index:2147483646;pointer-events:none"></div>`
  )
}

function bannerInfo(job, cfg) {
  const target = job?.target ?? "web"
  const url = job?.url || job?.cdp?.endpoint || ""
  return `${target}${url ? ` · ${url}` : ""}`
}

// Remove any previously-injected banner (idempotent), then add the current one.
// Works both when evaluated immediately (document.body exists) and when injected
// as an init script / addScriptToEvaluateOnNewDocument (body not yet created).
const BANNER_SCRIPT = (html) =>
  `(() => { try {
    var mount=function(){ try { document.getElementById('gui-doctor-banner')?.remove(); document.getElementById('gui-doctor-border')?.remove(); var t=document.createElement('div'); t.innerHTML=${JSON.stringify(
      html
    )}; (document.body||document.documentElement).appendChild(t); document.documentElement.setAttribute('data-gui-doctor','1'); } catch(e){} };
    if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
  } catch(e){} })()`

// Persist the banner across navigations (web/electron contexts) and paint it now.
// The persisted script uses the real label/detail so post-navigation paints keep
// the same identifier as the initial one.
export async function installBanner(page, context, cfg, job) {
  const html = bannerHtml(cfg, bannerInfo(job, cfg))
  try {
    await context?.addInitScript?.({ content: BANNER_SCRIPT(html) })
  } catch {
    /* best-effort */
  }
  try {
    await page.evaluate(BANNER_SCRIPT(html))
  } catch {
    /* page may be mid-navigation */
  }
  return { kind: "banner" }
}

export async function installWebContainer(page, cfg, appUrl, { timeout } = {}) {
  await page.setContent(containerHtml(cfg, appUrl), { waitUntil: "domcontentloaded", timeout })
  await waitForAppFrame(page, cfg, { timeout })
  return { kind: "iframe" }
}

// Resolve the current app Frame (may be replaced across cross-origin navigations).
export function appFrame(page, cfg) {
  return page.frame({ name: cfg.frameName })
}

async function waitForAppFrame(page, cfg, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const f = appFrame(page, cfg)
    if (f && !f.isDetached?.() && f.url() && f.url() !== "about:blank") return f
    if (Date.now() > deadline) throw new Error(`container: app frame did not load (expected inside '${cfg.label}')`)
    await page.waitForTimeout(100)
  }
}

export async function evalInApp(page, cfg, code, arg) {
  const f = appFrame(page, cfg)
  if (!f) throw new Error("container: app frame not found")
  return f.evaluate(code, arg)
}

// Navigate the embedded app (used for goto/navigate steps while wrapping).
export async function navigateApp(page, cfg, url, { waitUntil = "load", timeout } = {}) {
  if (!url) return
  await page.evaluate(({ sel, u }) => {
    const f = document.querySelector(sel)
    if (f) f.setAttribute("src", u)
  }, { sel: frameSelector(cfg), u: url })
  const deadline = Date.now() + (timeout ?? 15000)
  for (;;) {
    const f = appFrame(page, cfg)
    if (f && !f.isDetached?.() && f.url() && f.url() !== "about:blank") {
      await f.waitForLoadState(waitUntil, { timeout }).catch(() => {})
      return f
    }
    if (Date.now() > deadline) throw new Error(`container: app frame did not navigate to ${url}`)
    await page.waitForTimeout(100)
  }
}

export async function waitForAppUrl(page, cfg, url, { timeout } = {}) {
  const f = appFrame(page, cfg)
  if (!f) throw new Error("container: app frame not found")
  await f.waitForURL(url, { timeout, waitUntil: "load" })
  return f
}

export async function waitForAppLoadState(page, cfg, state = "networkidle", { timeout } = {}) {
  const f = appFrame(page, cfg)
  if (f) await f.waitForLoadState(state, { timeout }).catch(() => {})
}

// Strip X-Frame-Options / CSP frame-ancestors from document responses so the app
// can be embedded. Registered before user route mocks so route.fallback() lets
// those (registered later) win.
export async function stripFrameGuards(context, appUrl) {
  let origin
  try {
    origin = new URL(appUrl).origin
  } catch {
    return
  }
  await context.route(
    (url) => url.origin === origin,
    async (route) => {
      if (route.request().resourceType() !== "document") return route.fallback()
      try {
        const response = await route.fetch()
        const headers = { ...response.headers() }
        delete headers["x-frame-options"]
        const csp = headers["content-security-policy"]
        if (csp) {
          const kept = csp
            .split(";")
            .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
            .join(";")
          if (kept.trim()) headers["content-security-policy"] = kept
          else delete headers["content-security-policy"]
        }
        await route.fulfill({ response, headers })
      } catch {
        await route.fallback()
      }
    }
  )
}

// CDP variant: paint the banner into the attached page via Runtime.evaluate.
export function cdpBannerExpression(cfg, info) {
  return BANNER_SCRIPT(bannerHtml(cfg, info))
}
