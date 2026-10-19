// Shared job scanning: which features need page JavaScript, and which URLs the
// job navigates to. Single source of truth for three consumers that must never
// drift apart: the plugin's permission gate, the CLI's policy builder, and the
// harness-side policy assert.

export function stepsHaveEval(steps) {
  return (steps ?? []).some((s) => s?.action === "evaluate" || s?.action === "eval")
}

export function jsFeaturesRequested(job) {
  return (
    (job?.probes ?? []).length > 0 ||
    (job?.initScripts ?? []).length > 0 ||
    (job?.routeMocks ?? []).length > 0 ||
    stepsHaveEval(job?.steps) ||
    (job?.breakpointProbes ?? []).length > 0 ||
    !!(job?.afterEachProbe || job?.until) ||
    (job?.forks ?? []).some((f) => (f.probes ?? []).length || (f.initScripts ?? []).length || (f.patchAfterLoad ?? []).length || stepsHaveEval(f.steps))
  )
}

export function collectNavUrls(job) {
  const urls = []
  if (job?.url) urls.push(job.url)
  const scan = (steps) => {
    for (const s of steps ?? []) if (["goto", "navigate", "waitForURL"].includes(s?.action)) urls.push(s.value ?? s.url)
  }
  scan(job?.steps)
  for (const f of job?.forks ?? []) scan(f.steps)
  return urls.filter(Boolean)
}
