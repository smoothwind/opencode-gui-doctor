// Optional probe presets. Each is a best-effort reader that returns null when
// the framework/devtools hook is absent, so they are safe on any project.
// Presets are JavaScript and therefore gated by allowJsProbes like any probe.

const PRESETS = {
  vue: `() => {
    const hook = window.__VUE_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return null;
    const apps = hook.apps || (hook.appMap ? [...hook.appMap.values()] : []);
    const out = [];
    for (const app of apps) {
      const inst = app && app._instance ? app._instance : app;
      const proxy = inst && inst.proxy ? inst.proxy : null;
      out.push({ name: (app && app._component && app._component.name) || null, data: proxy ? proxy.$data : null });
    }
    return out.length ? out : null;
  }`,

  pinia: `() => {
    const p = window.__PINIA__ || window.$pinia || window.__pinia;
    if (!p) return null;
    try { return JSON.parse(JSON.stringify(p.state.value ?? p.state)); } catch (e) { return '[unserializable]'; }
  }`,

  react: `() => {
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers) return null;
    const ids = hook.renderers.keys ? [...hook.renderers.keys()] : Object.keys(hook.renderers);
    const roots = {};
    for (const id of ids) {
      try { roots[id] = hook.getFiberRoots ? [...hook.getFiberRoots(id)].length : null; } catch (e) { roots[id] = null; }
    }
    return { renderers: ids, roots };
  }`,

  storage: `() => {
    const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
    return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
  }`,
}

export function presetNames() {
  return Object.keys(PRESETS)
}

export function resolveProbeExpression(probe) {
  if (!probe) return null
  if (probe.expression) return probe.expression
  if (probe.preset) {
    const expr = PRESETS[probe.preset]
    if (!expr) throw new Error(`unknown probe preset '${probe.preset}' (known: ${presetNames().join(", ")})`)
    return expr
  }
  throw new Error(`probe '${probe.name ?? "?"}' requires 'expression' or 'preset'`)
}
