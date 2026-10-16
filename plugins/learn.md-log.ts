/**
 * md-log — mirror the session to a Markdown file for comfortable reading.
 *
 * Ported from `.pi/extensions/md-log.ts`.
 *
 * Built for long teaching sessions, where the terminal is hard on the eyes and
 * markdown/math/PNG don't render. The linked `.md` is meant to be read
 * *rendered* (Obsidian), so assistant prose with $...$ math, fenced code,
 * mermaid blocks and image embeds all render natively — nothing is converted
 * here.
 *
 * Captures only reading-relevant content: user prompts, assistant prose, and
 * quiz / ask_user_question Q&A blocks. Tool noise (shell, read, write) is
 * omitted.
 *
 * The pi version mirrored a TUI event stream. OpenCode plugins get a typed
 * server event stream instead (`session.text.ended`, `session.tool.called`,
 * `session.tool.success`), which is a closer fit: those events carry the final
 * text and the tool metadata directly, so the log gets the same content with
 * less guesswork.
 *
 * Commands (registered as plugin commands, so they run as real commands rather
 * than prompts):
 *   /md-log <filepath>  — link a markdown file and backfill the session
 *   /md-unlog           — stop logging
 */

import * as fs from "node:fs"
import * as path from "node:path"

const QA_TOOLS = new Set(["quiz", "ask_user_question"])

/** Serialize appends: events fire close together and order matters. */
let writeLock: Promise<void> = Promise.resolve()
function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = writeLock
  let release: () => void
  writeLock = new Promise<void>((resolve) => {
    release = resolve
  })
  return previous.then(fn).finally(() => release!())
}

// ── Obsidian callout formatting ──────────────────────────────────────────────

function callout(type: string, title: string, bodyLines: string[]): string {
  const lines = [`> [!${type}] ${title}`]
  for (const line of bodyLines) lines.push(line.length === 0 ? ">" : `> ${line}`)
  return lines.join("\n")
}

const userBlock = (text: string) => `> [!quote] YOU\n\n${text}`
const assistantBlock = (text: string) => `> [!abstract] ASSISTANT\n\n${text}`

function questionCallout(
  label: string,
  question: string,
  context: string | undefined,
  options: Array<{ label: string }>,
): string {
  const body: string[] = []
  for (const line of String(question).split("\n")) body.push(line)
  if (context) {
    body.push("")
    for (const line of context.split("\n")) body.push(line)
  }
  if (options.length > 0) {
    body.push("")
    body.push(...options.map((o, i) => `${i + 1}. ${o.label}`))
  }
  return callout("question", label, body)
}

/**
 * Grade a quiz answer. `metadata` is what the quiz tool attaches to its
 * result, so the correct answer and explanation are known to be the real ones.
 */
function quizAnswerBlock(metadata: any): string {
  if (!metadata) return callout("warning", "Quiz — no result", ["(no metadata)"])
  const selected: string[] = Array.isArray(metadata.selected) ? metadata.selected : []
  const correctValues: string[] = Array.isArray(metadata.correctValues) ? metadata.correctValues : []
  const options: Array<{ label: string; value: string }> = Array.isArray(metadata.options) ? metadata.options : []

  const dontKnow = metadata.dontKnow === true
  const title = dontKnow
    ? "Quiz — I don't know"
    : metadata.correct === true
      ? "Quiz — correct ✓"
      : "Quiz — incorrect ✗"
  const type = dontKnow ? "question" : metadata.correct === true ? "success" : "failure"

  const body: string[] = []
  body.push(dontKnow ? "Your answer: I don't know" : `Your answer: ${selected.join(", ") || "(none)"}`)

  const correctLabels = correctValues.map(
    (value) => options.find((o) => o.value === value)?.label ?? value,
  )
  body.push(`Correct answer: ${correctLabels.join(", ") || "(unknown)"}`)

  if (metadata.explanation) {
    body.push("")
    for (const line of String(metadata.explanation).split("\n")) body.push(line)
  }
  return callout(type, title, body)
}

function askAnswerBlock(metadata: any): string {
  if (!metadata) return callout("warning", "Question — no result", ["(no metadata)"])
  const answers: string[] = Array.isArray(metadata.answers) ? metadata.answers : []
  return callout("example", "Answer", answers.length > 0 ? answers : ["(no answer)"])
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default {
  id: "learn.md-log",
  async setup(ctx: any) {
    // sessionID -> linked file. Keyed per session so several sessions can be
    // logged at once, and so a restart restores each one.
    const stored = await ctx.storage.get("links")
    const links = new Map<string, string>(
      stored && typeof stored === "object" ? Object.entries(stored as Record<string, string>) : [],
    )
    const persist = () => ctx.storage.set("links", Object.fromEntries(links))

    // Only the sessions with an actual linked file are logged. Quiz shuffles
    // its options and publishes the true display order through progress, so
    // the question block uses the settled metadata rather than the raw input
    // whenever it is available.
    function append(sessionID: string, text: string): void {
      if (!links.has(sessionID)) return
      void withLock(() => {
        const file = links.get(sessionID)!
        try {
          const current = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : ""
          const prefix = current.trim().length > 0 ? "\n\n" : ""
          fs.writeFileSync(file, current + prefix + text + "\n", "utf-8")
        } catch {
          // File may have been deleted or locked externally; skip this block.
        }
      })
    }

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const type = (event as any).type as string
        const data = (event as any).data ?? {}
        const sessionID: string | undefined = data.sessionID
        if (!sessionID || !links.has(sessionID)) continue

        if (type === "session.text.ended") {
          const text = String(data.text ?? "").trim()
          if (text) append(sessionID, assistantBlock(text))
          continue
        }

        if (type === "session.tool.called") {
          const name = String(data.tool ?? "")
          if (!QA_TOOLS.has(name)) continue
          const input = data.input ?? {}
          append(
            sessionID,
            questionCallout(
              name === "quiz" ? "Quiz" : "Question",
              input.question ?? "",
              input.details?.trim() || undefined,
              Array.isArray(input.options) ? input.options : [],
            ),
          )
          continue
        }

        if (type === "session.tool.success") {
          const name = String(data.tool ?? "")
          if (!QA_TOOLS.has(name)) continue
          const metadata = (data.metadata ?? {}) as any
          const block = !metadata || metadata.question === undefined
            ? callout("warning", "Question — no result", ["(no metadata)"])
            : name === "quiz"
              ? quizAnswerBlock(metadata)
              : askAnswerBlock(metadata)
          append(sessionID, block)
        }
      }
    })().catch(() => {})

    // ── Commands ────────────────────────────────────────────────────────────

    async function link(sessionID: string, raw: string): Promise<string> {
      const trimmed = raw.trim()
      if (!trimmed) return "Usage: /md-log <filepath>"

      const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(ctx.location.directory, trimmed)
      // Link into an existing note; never create one. A typo'd path should not
      // silently scatter new files around the vault.
      if (!fs.existsSync(resolved)) return `File does not exist: ${resolved}`
      if (!fs.statSync(resolved).isFile()) return `Not a file: ${resolved}`

      links.set(sessionID, resolved)
      await persist()

      const messages = await ctx.session.context({ sessionID })
      const blocks: string[] = []
      for (const message of messages as readonly any[]) {
        if (message.type === "user") {
          const text = String(message.text ?? "").trim()
          if (text) blocks.push(userBlock(text))
        } else if (message.type === "assistant") {
          for (const part of message.content ?? []) {
            if (part.type === "text" && part.text?.trim()) blocks.push(assistantBlock(part.text.trim()))
          }
        }
      }
      if (blocks.length > 0) {
        await withLock(() => fs.writeFileSync(resolved, blocks.join("\n\n") + "\n", "utf-8"))
      }
      return `Linked: ${resolved} (${messages.length} messages backfilled)`
    }

    async function unlink(sessionID: string): Promise<string> {
      const file = links.get(sessionID)
      if (!file) return "No file linked"
      links.delete(sessionID)
      await persist()
      return `Unlinked: ${path.basename(file)}`
    }

    await ctx.command.transform((editor: any) => {
      editor.add({
        name: "md-log",
        description: "Mirror this session to a markdown file (backfills history)",
        execute: async (input: any) => {
          const sessionID: string = input.sessionID
          const args = String(input.prompt?.text ?? "").trim()
          await ctx.session.synthetic({ sessionID, text: await link(sessionID, args) })
        },
      })
      editor.add({
        name: "md-unlog",
        description: "Stop mirroring this session to a markdown file",
        execute: async (input: any) => {
          await ctx.session.synthetic({ sessionID: input.sessionID, text: await unlink(input.sessionID) })
        },
      })
    })

    return () => controller.abort()
  },
}