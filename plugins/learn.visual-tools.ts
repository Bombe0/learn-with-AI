/**
 * visual-tools — the authoring loops for the visual-maker subagents.
 *
 * Ported from `.pi/extensions/visual-tools/`. Two trios, each a write → edit →
 * render loop over one managed source file:
 *
 *   write_mermaid / edit_mermaid / render_mermaid   structural diagrams
 *   write_svg      / edit_svg      / render_svg      spatial & geometric
 *
 * In pi these were registered as a special extension so that
 * `interactive-subagents` could hand them to a spawned child process. In
 * OpenCode a plugin tool is registered once and the agent's own `permissions`
 * decide who may call it, so there is no equivalent indirection: the makers
 * declare these six names in their permissions and everything else stays
 * denied.
 *
 * Rendering:
 *   - Mermaid via the bundled @mermaid-js/mermaid-cli, pointed at an installed
 *     Chrome so no Chromium download is needed.
 *   - SVG via @resvg/resvg-js. The pi original shelled out to rsvg-convert with
 *     an ImageMagick fallback, both Unix-only; resvg is a cross-platform native
 *     module with no system binary to install, which keeps the maker loop
 *     working on Windows.
 *
 * `render_*` returns the PNG as a file part so the maker genuinely *sees* it
 * and can iterate — that verify-by-looking loop is the whole point.
 */

import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const STAGING_ROOT = path.join(os.tmpdir(), "opencode-visual-tools")
const VIZ_DIR = "viz"
const RENDER_TIMEOUT_MS = 120_000

const CHROME_CANDIDATES = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter((x): x is string => typeof x === "string")

function findChrome(): string | undefined {
  return CHROME_CANDIDATES.find((candidate) => {
    try {
      return fs.existsSync(candidate)
    } catch {
      return false
    }
  })
}

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === "win32",
      env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" },
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, RENDER_TIMEOUT_MS)
    child.stdout?.on("data", (d) => (stdout += String(d)))
    child.stderr?.on("data", (d) => (stderr += String(d)))
    child.on("error", (err) => {
      clearTimeout(timer)
      resolveRun({ code: null, stdout, stderr: stderr + String(err), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr, timedOut })
    })
  })
}

/**
 * Where the renderers live: their own install under `.opencode/renderers/`, so
 * the learning project never carries a node_modules. Resolved relative to this
 * file rather than the project, because the plugin is what needs them.
 */
const RENDERER_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderers")

/** Resolve `mmdc` from the renderer install, falling back to npx. */
function mermaidCommand(): { cmd: string; args: string[] } {
  const name = process.platform === "win32" ? "mmdc.cmd" : "mmdc"
  const local = path.join(RENDERER_ROOT, "node_modules", ".bin", name)
  if (fs.existsSync(local)) return { cmd: local, args: [] }
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", args: ["--yes", "@mermaid-js/mermaid-cli"] }
}

/**
 * Exact-match single replacement, matching OpenCode's built-in edit:
 * `old_text` must appear exactly once, or the call fails and nothing changes.
 */
function applyEdit(current: string, oldText: string, newText: string): { updated: string; index: number } {
  if (oldText === "") throw new Error("`old_text` must be non-empty.")
  if (oldText === newText) throw new Error("`old_text` and `new_text` are identical.")
  const first = current.indexOf(oldText)
  if (first === -1) throw new Error("`old_text` not found in the current source — match it exactly.")
  if (current.indexOf(oldText, first + 1) !== -1) {
    let count = 0
    let i = current.indexOf(oldText)
    while (i !== -1) {
      count++
      i = current.indexOf(oldText, i + oldText.length)
    }
    throw new Error(`\`old_text\` appears ${count} times — add surrounding context to make it unique.`)
  }
  return {
    updated: current.slice(0, first) + newText + current.slice(first + oldText.length),
    index: first,
  }
}

function snippetAround(content: string, index: number, contextLines = 3): string {
  const lines = content.split("\n")
  const hitLine = content.slice(0, index).split("\n").length - 1
  const start = Math.max(0, hitLine - contextLines)
  const end = Math.min(lines.length - 1, hitLine + contextLines)
  const width = String(end + 1).length
  return lines
    .slice(start, end + 1)
    .map((line, i) => `${String(start + i + 1).padStart(width)}  ${line}`)
    .join("\n")
}

/** Copy a rendered PNG into <directory>/viz with a unique, slugified name. */
function publish(pngPath: string, slug: string, directory: string): { filename: string; path: string } {
  const dir = path.join(directory, VIZ_DIR)
  fs.mkdirSync(dir, { recursive: true })
  const clean =
    slug
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "viz"
  const filename = `viz-${clean}-${Date.now()}.png`
  const dest = path.join(dir, filename)
  fs.copyFileSync(pngPath, dest)
  return { filename, path: dest }
}

function fileUri(absolutePath: string): string {
  return `file:///${absolutePath.replace(/\\/g, "/").replace(/^\/+/, "")}`
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default {
  id: "learn.visual-tools",
  async setup(ctx: any) {
    // One managed source file per group. Keyed by session so two makers never
    // stomp on each other's draft.
    const sources = new Map<string, { workDir: string; bodyPath: string }>()

    function writeSource(sessionID: string, group: string, bodyFile: string, source: string) {
      const workDir = path.join(STAGING_ROOT, `${group}-${sessionID}`)
      fs.mkdirSync(workDir, { recursive: true })
      const bodyPath = path.join(workDir, bodyFile)
      fs.writeFileSync(bodyPath, source, "utf8")
      const entry = { workDir, bodyPath }
      sources.set(`${sessionID}:${group}`, entry)
      return entry
    }

    function readSource(sessionID: string, group: string, tool: string) {
      const entry = sources.get(`${sessionID}:${group}`)
      if (!entry || !fs.existsSync(entry.bodyPath)) {
        throw new Error(`${tool}: no source yet — call the matching write_* tool first.`)
      }
      return entry
    }

    function editSource(sessionID: string, group: string, tool: string, oldText: string, newText: string) {
      const entry = readSource(sessionID, group, tool)
      const current = fs.readFileSync(entry.bodyPath, "utf8")
      const { updated, index } = applyEdit(current, oldText, newText)
      fs.writeFileSync(entry.bodyPath, updated, "utf8")
      return { updated, index }
    }

    /**
     * Shared tail for render_*: publish-or-preview, then hand back the PNG.
     *
     * The PNG comes back both as a file part and as a path. Not every client
     * surfaces an inline file part as an image — Code Mode collapses tool
     * results to text — so the text always names the path and tells the maker
     * to `read` it. That keeps the verify-by-looking loop intact either way.
     */
    function renderResult(pngPath: string, saveAs: unknown, instruction: string, directory: string) {
      const see = (target: string) =>
        `LOOK at the rendered PNG to confirm it is correct before returning it. If the image is not shown inline above, read it with \`read\` on this exact path:\n${target}`
      if (saveAs) {
        const { filename, path: dest } = publish(pngPath, String(saveAs), directory)
        return {
          content: [
            { type: "text", text: `Published to ${VIZ_DIR}/.\nfilename: ${filename}\npath: ${dest}\n\n${see(dest)}` },
            { type: "file", uri: fileUri(dest), mime: "image/png", name: filename },
          ],
          metadata: { ok: true, published: true, filename, path: dest },
        }
      }
      return {
        content: [
          { type: "text", text: `Preview render (not saved). ${instruction}\n\n${see(pngPath)}` },
          { type: "file", uri: fileUri(pngPath), mime: "image/png" },
        ],
        metadata: { ok: true, published: false, path: pngPath },
      }
    }

    await ctx.tool.transform((editor: any) => {
      // ── Mermaid ────────────────────────────────────────────────────────────

      editor.add({
        name: "write_mermaid",
        description:
          "Write the FULL Mermaid source to this session's managed file (your first draft or a complete rewrite). You do NOT name the file — edit_mermaid and render_mermaid act on the same one.\n\n`source` is a complete Mermaid diagram: `graph TD`/`graph LR`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`, `classDiagram`, `mindmap`, or `timeline`. Writing does NOT render — call render_mermaid when ready. For a small fix, prefer edit_mermaid over rewriting.",
        input: {
          type: "object",
          properties: { source: { type: "string", description: "The complete Mermaid diagram source (starts with the diagram type, e.g. `graph TD`)." } },
          required: ["source"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const source = String(input.source ?? "").trim()
          if (!source) throw new Error("`write_mermaid` requires a non-empty `source`.")
          const entry = writeSource(toolCtx.sessionID, "mermaid", "diagram.mmd", source)
          return {
            content: [
              {
                type: "text",
                text: `Wrote ${source.split("\n").length}-line Mermaid source.\nCall render_mermaid to render it, or edit_mermaid to tweak it.`,
              },
            ],
            metadata: { ok: true, path: entry.bodyPath },
          }
        },
      })

      editor.add({
        name: "edit_mermaid",
        description:
          "Make a single exact-match replacement in this session's Mermaid source. `old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. Call write_mermaid first. Editing does NOT render.",
        input: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "Exact substring of the current source to replace (must match once)." },
            new_text: { type: "string", description: "Replacement text for `old_text`." },
          },
          required: ["old_text", "new_text"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const { updated, index } = editSource(toolCtx.sessionID, "mermaid", "edit_mermaid", String(input.old_text ?? ""), String(input.new_text ?? ""))
          return {
            content: [{ type: "text", text: `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_mermaid to see it.` }],
            metadata: { ok: true },
          }
        },
      })

      editor.add({
        name: "render_mermaid",
        description:
          "Render the CURRENT session Mermaid source to a PNG and return it inline so you can SEE the diagram and iterate. You do NOT pass the source here — it comes from the managed file; call write_mermaid first.\n\nIterate freely with no `save_as` (preview only). When the diagram is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into the project's `viz` folder with a unique filename and returns the filename to embed.",
        input: {
          type: "object",
          properties: {
            save_as: {
              type: "string",
              description:
                "Short kebab-case topic slug (e.g. 'internet-packets'). When set, the rendered PNG is published to <project>/viz as viz-<slug>-<timestamp>.png. Omit for a preview-only render.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const entry = readSource(toolCtx.sessionID, "mermaid", "render_mermaid")
          fs.mkdirSync(entry.workDir, { recursive: true })

          const chrome = findChrome()
          const cfgPath = path.join(entry.workDir, "puppeteer.json")
          fs.writeFileSync(
            cfgPath,
            JSON.stringify(chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] }),
            "utf8",
          )

          const outPath = path.join(entry.workDir, `render-${Date.now()}.png`)
          const { cmd, args } = mermaidCommand()
          const res = await run(
            cmd,
            [...args, "-i", entry.bodyPath, "-o", outPath, "-p", cfgPath, "-s", "2", "-b", "white"],
            entry.workDir,
          )

          if (res.code !== 0 || !fs.existsSync(outPath)) {
            const detail = (res.stderr || res.stdout || "unknown error").split("\n").slice(-30).join("\n")
            return {
              content: [
                {
                  type: "text",
                  text: `${res.timedOut ? "Mermaid render timed out.\n\n" : ""}Mermaid render FAILED — no image produced${chrome ? "" : " (no Chrome found — install Chrome or set CHROME_PATH)"}. Fix the source with edit_mermaid and call render_mermaid again.\n\nError:\n${detail}`,
                },
              ],
              metadata: { ok: false },
            }
          }
          return renderResult(
            outPath,
            input.save_as,
            "LOOK: are arrows/relationships correct, labels right, nothing cramped? Fix with edit_mermaid, or re-render with `save_as` to publish.",
            ctx.location.directory,
          )
        },
      })

      // ── SVG ────────────────────────────────────────────────────────────────

      editor.add({
        name: "write_svg",
        description:
          "Write the FULL SVG source to this session's managed file (your first draft or a complete rewrite). You do NOT name the file — edit_svg and render_svg act on the same one.\n\n`source` is a complete `<svg ...>…</svg>` document with an explicit width/height (or viewBox), readable font sizes, and a light or transparent background. Writing does NOT render — call render_svg when ready. For a small fix, prefer edit_svg over rewriting.",
        input: {
          type: "object",
          properties: { source: { type: "string", description: "The complete SVG document, from `<svg` to `</svg>`." } },
          required: ["source"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const source = String(input.source ?? "").trim()
          if (!source) throw new Error("`write_svg` requires a non-empty `source`.")
          if (!source.includes("<svg")) throw new Error("`write_svg`: source must be a complete <svg>…</svg> document.")
          const entry = writeSource(toolCtx.sessionID, "svg", "diagram.svg", source)
          return {
            content: [
              { type: "text", text: `Wrote ${source.split("\n").length}-line SVG source.\nCall render_svg to render it, or edit_svg to tweak it.` },
            ],
            metadata: { ok: true, path: entry.bodyPath },
          }
        },
      })

      editor.add({
        name: "edit_svg",
        description:
          "Make a single exact-match replacement in this session's SVG source. `old_text` must appear EXACTLY ONCE (include surrounding context for uniqueness); on 0 or >1 matches the call fails and nothing changes. Call write_svg first. Editing does NOT render.",
        input: {
          type: "object",
          properties: {
            old_text: { type: "string", description: "Exact substring of the current source to replace (must match once)." },
            new_text: { type: "string", description: "Replacement text for `old_text`." },
          },
          required: ["old_text", "new_text"],
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const { updated, index } = editSource(toolCtx.sessionID, "svg", "edit_svg", String(input.old_text ?? ""), String(input.new_text ?? ""))
          return {
            content: [{ type: "text", text: `Applied edit. Updated region:\n\`\`\`\n${snippetAround(updated, index)}\n\`\`\`\nCall render_svg to see it.` }],
            metadata: { ok: true },
          }
        },
      })

      editor.add({
        name: "render_svg",
        description:
          "Render the CURRENT session SVG source to a PNG and return it inline so you can SEE the picture and iterate. You do NOT pass the source here — it comes from the managed file; call write_svg first.\n\nIterate freely with no `save_as` (preview only). When the picture is correct and clean, call once more with `save_as` set to a short kebab-case topic slug: that publishes the PNG into the project's `viz` folder with a unique filename and returns the filename to embed.",
        input: {
          type: "object",
          properties: {
            save_as: {
              type: "string",
              description:
                "Short kebab-case topic slug (e.g. 'number-line'). When set, the rendered PNG is published to <project>/viz as viz-<slug>-<timestamp>.png. Omit for a preview-only render.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: any, toolCtx: any) => {
          const entry = readSource(toolCtx.sessionID, "svg", "render_svg")
          fs.mkdirSync(entry.workDir, { recursive: true })

          const source = fs.readFileSync(entry.bodyPath, "utf8")
          const outPath = path.join(entry.workDir, `render-${Date.now()}.png`)
          try {
            // resvg renders at 2x for legibility when embedded at ~500px.
            // Resolved by absolute path: it lives in the renderer install, not
            // anywhere on this module's own resolution path.
            const resvg = pathToFileURL(
              path.join(RENDERER_ROOT, "node_modules", "@resvg", "resvg-js", "index.js"),
            ).href
            const { Resvg } = (await import(resvg)) as any
            const png = new Resvg(source, { fitTo: { mode: "zoom", value: 2 }, background: "white" }).render().asPng()
            fs.writeFileSync(outPath, png)
          } catch (e: any) {
            return {
              content: [
                {
                  type: "text",
                  text: `SVG render FAILED — no image produced. Install the renderers with \`npm install\` in .opencode/renderers (it provides @resvg/resvg-js), fix the source with edit_svg, and call render_svg again.\n\nError:\n${String(e?.message ?? e)}`,
                },
              ],
              metadata: { ok: false },
            }
          }
          return renderResult(
            outPath,
            input.save_as,
            "LOOK: are coordinates, angles, directions, and proportions correct? Labels clear and unclipped? Fix with edit_svg, or re-render with `save_as` to publish.",
            ctx.location.directory,
          )
        },
      })
    })
  },
}