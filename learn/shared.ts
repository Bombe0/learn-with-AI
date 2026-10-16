/**
 * Shared runtime for the ported `learn` plugins.
 *
 * The pi originals talked to a TUI (`ctx.ui.custom`) to ask the user questions.
 * OpenCode server plugins have no UI, but the server exposes a session *form*
 * API that every client renders natively. These helpers wrap that API so the
 * quiz / ask_user_question tools keep their original behaviour:
 *
 *   - one question per call, options with labels + descriptions
 *   - `quiz` grades the answer instantly and returns ✓/✗ plus the explanation
 *   - `ask_user_question` has no correct answer and always allows "Other"
 *
 * Deliberately dependency-free: it talks to the local service over `fetch`
 * using the registration file that `opencode service` already maintains, so it
 * works against the shared background service and a `--standalone` run alike.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// ── Service discovery ────────────────────────────────────────────────────────

interface ServiceInfo {
  url: string
  password?: string
}

function serviceFile(): string {
  const state = process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state")
  return path.join(state, "opencode", "service.json")
}

export function service(): ServiceInfo {
  const override = process.env.OPENCODE_SERVER_URL
  const raw = (() => {
    if (override) return { url: override } as ServiceInfo
    return JSON.parse(fs.readFileSync(serviceFile(), "utf8")) as ServiceInfo
  })()
  if (!raw.url) throw new Error("no OpenCode service URL available")
  return raw
}

function authHeaders(info: ServiceInfo): Record<string, string> {
  if (!info.password) return {}
  const encoded = Buffer.from(`opencode:${info.password}`).toString("base64")
  return { authorization: `Basic ${encoded}` }
}

async function api<T>(info: ServiceInfo, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, info.url), {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(info), ...(init?.headers ?? {}) },
  })
  const body = (await response.json()) as { data?: T } & Record<string, unknown>
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body.data as T
}

// ── Forms ────────────────────────────────────────────────────────────────────

export interface FormOption {
  value: string
  label: string
  description?: string
}

export type FormField =
  | {
      key: string
      type: "multiselect"
      title?: string
      description?: string
      required?: boolean
      options: FormOption[]
      minItems?: number
      maxItems?: number
      custom?: boolean
    }
  | {
      key: string
      type: "string"
      title?: string
      description?: string
      required?: boolean
      placeholder?: string
      /** Turns the field into a choice list rather than free text. */
      options?: FormOption[]
      custom?: boolean
    }

interface FormInfo {
  id: string
}

export type FormOutcome =
  | { status: "answered"; answer: Record<string, unknown> }
  | { status: "cancelled"; message?: string }

const POLL_INTERVAL_MS = 250

/**
 * Create a form on the session and resolve once the client answers it.
 *
 * Resolves `{ status: "cancelled" }` when the client dismisses the form, and
 * when no interactive client is attached at all (a headless `opencode run`)
 * the server cancels the form immediately — which is exactly the
 * "no interactive UI" signal the pi versions raised.
 */
export async function askForm(
  sessionID: string,
  input: { title: string; fields: FormField[] },
  signal?: AbortSignal,
): Promise<FormOutcome> {
  const info = service()
  const form = await api<FormInfo>(info, `/api/session/${sessionID}/form`, {
    method: "POST",
    body: JSON.stringify(input),
  })

  for (;;) {
    if (signal?.aborted) {
      await api(info, `/api/session/${sessionID}/form/${form.id}?message=interrupted`, {
        method: "DELETE",
      }).catch(() => {})
      return { status: "cancelled", message: "interrupted" }
    }
    const detail = await api<{ state: { status: string; answer?: Record<string, unknown>; message?: string } }>(
      info,
      `/api/session/${sessionID}/form/${form.id}`,
    )
    if (detail.state.status === "answered") return { status: "answered", answer: detail.state.answer ?? {} }
    if (detail.state.status === "cancelled") return { status: "cancelled", message: detail.state.message }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// ── Option helpers (shared by quiz and ask_user_question) ─────────────────────

export interface ChoiceOption {
  label: string
  value: string
  description?: string
}

export const DONT_KNOW_VALUE = "__dont_know__"
export const DONT_KNOW_LABEL = "I don't know"
export const OTHER_VALUE = "__other__"

export function normalizeOptions(
  options: Array<{ label: string; value?: string; description?: string }> | undefined,
): ChoiceOption[] {
  const seen = new Set<string>()
  return (options ?? [])
    .map((option) => ({
      label: option.label.trim(),
      value: option.value?.trim() || option.label.trim(),
      description: option.description?.trim() || undefined,
    }))
    .filter((option) => {
      if (option.label.length === 0) return false
      if (seen.has(option.value)) throw new Error(`duplicate option value "${option.value}"`)
      seen.add(option.value)
      return true
    })
}

/** Fisher-Yates over a copy. Grading is keyed by value, so order is display-only. */
export function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * The choice list for `quiz` and `ask_user_question`.
 *
 * Two renderer details drive the shape of this, both verified against the
 * client's form component (`packages/tui/src/routes/session/form.tsx`):
 *
 *  1. The heading above the choices renders `field.description ?? field.title`.
 *    The description therefore wins, so the *question* goes there and `title`
 *    stays a short tab/label — that is what makes the question the prominent
 *    line instead of the small muted form title.
 *  2. The client only treats a form as "single" (no tab bar, no Confirm step)
 *    when it has one field of type `boolean` or a `string` with `options`. A
 *    `multiselect` with `maxItems: 1` is therefore *not* single-select to the
 *    client: it still renders the tab bar and needs an explicit confirm. So
 *    single-select uses a `string` field with `options` here, which submits on
 *    pick, while multi-select keeps the multiselect and its tab bar.
 *
 * `extra` is appended as the final row: the "I don't know" opt-out for `quiz`,
 * the "Other" free-text escape for `ask_user_question`.
 */
export function selectionField(
  key: string,
  label: string,
  question: string | undefined,
  options: ChoiceOption[],
  extra: ChoiceOption,
  multiple: boolean,
): FormField {
  const choices = [...options.map((o) => ({ value: o.value, label: o.label, description: o.description })), extra]
  const heading = { ...(question ? { description: question } : {}), required: true }
  return multiple
    ? { key, type: "multiselect", title: label, ...heading, options: choices, minItems: 1 }
    : { key, type: "string", title: label, ...heading, options: choices }
}

export function readSelection(answer: Record<string, unknown>, key: string): string[] {
  const raw = answer[key]
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "string" && raw.length > 0) return [raw]
  return []
}

