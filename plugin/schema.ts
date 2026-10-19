import { tool } from "@opencode-ai/plugin"

// Tool argument schemas, split out of the plugin entry point so index.ts stays
// focused on gating + dispatch.

export const stepSchema = tool.schema
  .object({
    action: tool.schema
      .string()
      .describe(
        "goto|click|dblclick|fill|type|press|hover|check|uncheck|select|setInputFiles|dragTo|reload|goBack|scroll|scrollIntoViewIfNeeded|clear|focus|waitForSelector|waitForTimeout|waitForLoadState|waitForFunction|screenshot|evaluate|expectText|expectVisible|expectCount"
      ),
    selector: tool.schema.string().optional().describe("Playwright selector (css, text=, role=...)"),
    frame: tool.schema.array(tool.schema.string()).optional().describe("iframe chain (frameLocator selectors) to scope the target"),
    testId: tool.schema.string().optional().describe("data-testid value"),
    value: tool.schema.string().optional().describe("text/URL/key/expected value"),
    expect: tool.schema.string().optional().describe("expected value for expect* actions"),
    optional: tool.schema.boolean().optional().describe("do not abort the run when this step fails"),
    timeout: tool.schema.number().optional(),
    waitForIdle: tool.schema.boolean().optional(),
    waitUntil: tool.schema.string().optional(),
    state: tool.schema.string().optional(),
    mode: tool.schema.string().optional(),
  })
  .passthrough()

export const probeSchema = tool.schema.object({
  name: tool.schema.string().optional(),
  expression: tool.schema.string().optional().describe('JS function/eval string, e.g. "() => window.__STATE__" (requires allowJsProbes)'),
  preset: tool.schema.enum(["vue", "pinia", "react", "storage"]).optional().describe("built-in state reader (alternative to expression)"),
})

export const forkSchema = tool.schema.object({
  id: tool.schema.string().optional().describe("unique id; name one 'baseline' to diff against"),
  forkAt: tool.schema.number().optional().describe("replay steps[0..forkAt) then diverge"),
  initScripts: tool.schema.array(tool.schema.string()).optional().describe("inline JS or absolute file path, injected before page scripts (requires allowJsProbes)"),
  routeMocks: tool.schema
    .array(
      tool.schema.object({
        url: tool.schema.string(),
        status: tool.schema.number().optional(),
        body: tool.schema.any().optional(),
        contentType: tool.schema.string().optional(),
        abort: tool.schema.boolean().optional(),
      })
    )
    .optional(),
  patchAfterLoad: tool.schema
    .array(tool.schema.object({ expression: tool.schema.string() }))
    .optional()
    .describe("patches applied after the replay prefix, before probes (requires allowJsProbes)"),
  probes: tool.schema.array(probeSchema).optional(),
  steps: tool.schema.array(stepSchema).optional().describe("extra steps executed after the fork point"),
})

export const determinismSchema = tool.schema
  .object({
    record: tool.schema.boolean().optional().describe("record network to network.har (record mode)"),
    recordFileName: tool.schema.string().optional(),
    harPath: tool.schema.string().optional().describe("replay responses from a recorded HAR (fork/bisect mode)"),
    seed: tool.schema.number().optional().describe("seed for Math.random (mulberry32)"),
    clockTime: tool.schema.string().optional().describe("freeze the page clock at this time (ISO or epoch ms)"),
  })
  .partial()

export const breakpointProbeSchema = tool.schema.object({
  name: tool.schema.string().optional(),
  url: tool.schema.string().optional().describe("script url to break on"),
  urlRegex: tool.schema.string().optional().describe("script url regex to break on"),
  line: tool.schema.number().describe("1-based line number"),
  column: tool.schema.number().optional(),
  maxHits: tool.schema.number().optional().default(1),
  expressions: tool.schema.array(tool.schema.string()).describe("expressions evaluated on the paused call frame"),
})

// Run the target inside a visible, labelled container (default ON). Pass
// `false` to disable; pass an object to tweak the label/accent/border.
export const containerSchema = tool.schema
  .union([
    tool.schema.boolean(),
    tool.schema
      .object({
        enabled: tool.schema.boolean().optional(),
        label: tool.schema.string().optional().describe("toolbar/banner label (clear identifier)"),
        accent: tool.schema.string().optional().describe("accent colour for the toolbar/border"),
        border: tool.schema.number().optional().describe("container border width in px"),
        stripFrameAncestors: tool.schema.boolean().optional().describe("strip X-Frame-Options / CSP frame-ancestors so the app can be embedded"),
      })
      .passthrough(),
  ])
  .optional()
  .describe("Wrap the target in a visible, labelled container (default on). Set false to disable.")

export function normalizeContainer(c: any): any {
  if (c === false) return false
  if (c === true || c == null) return { enabled: true }
  return { enabled: c.enabled !== false, ...c }
}
