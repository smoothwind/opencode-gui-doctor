// Accessibility-tree snapshot + a compact line diff between two snapshots.
// `root` may be a Page or a FrameLocator (so the snapshot can be scoped to the
// app frame when it runs inside a container).

export async function a11ySnapshot(root) {
  try {
    const body = root.locator("body")
    if (typeof body.ariaSnapshot === "function") {
      const snap = await body.ariaSnapshot()
      if (snap) return snap
    }
  } catch {
    /* API absent or detached */
  }
  try {
    return await root.locator("body").innerText()
  } catch {
    try {
      return await root.content()
    } catch {
      return ""
    }
  }
}

export function diffText(a = "", b = "") {
  const la = String(a).split("\n")
  const lb = String(b).split("\n")
  let start = 0
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++
  let endA = la.length
  let endB = lb.length
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) {
    endA--
    endB--
  }
  const removed = la.slice(start, endA)
  const added = lb.slice(start, endB)
  return {
    changed: removed.length + added.length,
    removed: removed.slice(0, 20),
    added: added.slice(0, 20),
    atLine: start + 1,
  }
}
