/**
 * quiz — a GRADED sibling of ask_user_question.
 *
 * Ported from `.pi/extensions/quiz.ts`. The pi version drove a bespoke TUI
 * popup; OpenCode has no server-side UI, so this uses a session form, which
 * every client renders natively. Everything the original guaranteed is kept:
 *
 *   - the correct answer is keyed by option *value*, never by position, so a
 *     shuffle can never cause a wrong grade and a typo is a hard error
 *   - options are shuffled before display
 *   - "I don't know" is always offered and is never counted as correct — it is
 *     a knowledge gap, not a wrong guess
 
 *   - the explanation is only ever returned *after* the user has answered, so
 *     it can never leak into the transcript pre-answer
 */

import {
  askForm,
  DONT_KNOW_LABEL,
  DONT_KNOW_VALUE,
  normalizeOptions,
  readSelection,
  selectionField,
  shuffle,
  type ChoiceOption,
} from "../learn/shared.js"

const GUIDELINES = [
  "quiz is GRADED; ask_user_question and question are not. If the question has a correct answer, use quiz.",
  'correctAnswer is REQUIRED and is the option value, not a position number. Single-select: one string (e.g. "mercury"). Multi-select: an array of strings (e.g. ["belize", "niue"]).',
  "explanation is REQUIRED — always say why the correct answer is correct.",
  "Multi-select is graded as an exact-set match: the user is correct only if they select every correct option and no incorrect ones.",
  "An 'I don't know' choice is ALWAYS added automatically — provide ONLY the real, gradable options (at least two). Never add your own uncertainty/opt-out option; that is handled for you and a manual one would be gradable-as-wrong.",
  "If a result comes back dontKnow, the user honestly did not know and did NOT guess — treat it as a genuine knowledge gap to teach into, not as a wrong answer.",
  
  "Treat each wrong answer (distractor) as a diagnostic probe, not just filler: make it a specific, believable mistake the user might actually hold — a common misconception, or an adjacent/easily-confused concept — so that WHICH wrong answer they pick reveals WHICH nuance of their understanding is off.",
  "Guardrail: every distractor must be unambiguously wrong on the intended reading — tempting, but a real error, not a defensible alternative. Don't drift into trick questions.",
  "Anti-guessing hygiene: don't let the correct answer stand out by form (longest, most precise, most hedged, or the only one in the right format). Keep options similar in length, specificity, and phrasing so it can't be picked from shape alone.",
  "Set multiSelect: true only when more than one option is correct.",
  "Options are shuffled before display by default, so don't worry about which position you list the correct answer in.",
  "Don't leak the answer through formatting: keep option phrasing/length even and don't hint which is correct.",
]

const OPTION_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string", description: "Display label for the answer option." },
    value: {
      type: "string",
      description: "Optional machine-readable value returned for the option. Defaults to the label.",
    },
    description: { type: "string", description: "Optional extra detail shown below the option." },
  },
  required: ["label"],
  additionalProperties: false,
} as const

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The single quiz question to ask. Ask exactly one question per tool call." },
    details: { type: "string", description: "Optional extra context or instructions shown under the question." },
    options: {
      type: "array",
      description:
        "The answer options (2 or more). Options only — there is no free-text mode. Give each option a stable `value`; you reference the correct one by that value in correctAnswer.",
      items: OPTION_SCHEMA,
      minItems: 2,
    },
    multiSelect: {
      type: "boolean",
      description: "Set to true when more than one option is correct and the user must select all of them.",
    },
    correctAnswer: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      description:
        'REQUIRED. The correct answer as the option value(s) — the `value` field of the option you intend. Single-select: a single string. Multi-select: an array of strings. Always pass the value, not a position number — this is self-checking and prevents miscounting.',
    },
    explanation: {
      type: "string",
      description:
        "REQUIRED. Explanation revealed AFTER the user answers (shown whether they got it right or wrong). Use it to reinforce why the correct answer is correct.",
    },
    shuffle: {
      type: "boolean",
      description:
        "Defaults to true: options are randomly reordered before display. Set to false only when option order is meaningful (ordered numeric values, or an 'All/None of the above' option that must stay last).",
    },
  },
  required: ["question", "options", "correctAnswer", "explanation"],
  additionalProperties: false,
} as const

/** Some providers flatten a union into a JSON-encoded string; recover the array. */
function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer
  const trimmed = correctAnswer.trim()
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      /* not JSON — treat as a literal value */
    }
  }
  return [correctAnswer]
}

function resolveCorrect(correctAnswer: string | string[], options: ChoiceOption[]): { values: string[]; error?: string } {
  const wanted = coerceCorrectAnswer(correctAnswer)
  if (wanted.length === 0) return { values: [], error: "correctAnswer is required" }
  const known = new Set(options.map((o) => o.value))
  for (const value of wanted) {
    if (!known.has(value.trim())) {
      return { values: [], error: `correctAnswer "${value}" does not match any option value (${[...known].join(", ")})` }
    }
  }
  return { values: [...new Set(wanted.map((v) => v.trim()))] }
}

export default {
  id: "learn.quiz",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "quiz",
        description:
          "Ask the user a GRADED question with a known correct answer, then instantly grade and give feedback. Unlike ask_user_question and question (which collect preferences/decisions with no right answer), quiz always has a correct answer supplied by you, marks the user's selection right/wrong (✓/✗), reveals the correct answer, and shows an explanation. Use it to (1) assess what the learner already understands before teaching, and (2) run tight practice/retrieval loops after explaining, or probe understanding whenever you're unsure they've got it. Options-only: single-select or multi-select, plus an automatic 'I don't know' choice so the user can signal a genuine gap instead of guessing. Single-select submits the moment the user picks an option; multi-select shows a Submit tab. No free-text answers — for non-graded questions use ask_user_question.\n\nGuidelines:\n" +
          GUIDELINES.map((line, i) => `${i + 1}. ${line}`).join("\n"),
        input: INPUT_SCHEMA,
        options: { permission: "quiz" },
        execute: async (input: any, toolCtx: any) => {
          const options0 = normalizeOptions(input.options)
          const context = input.details?.trim() || undefined
          const explanation = String(input.explanation ?? "").trim()
          const multiple = input.multiSelect === true
          // Layout, per the client's form renderer:
          //   - field `description` becomes the bright heading above the choices,
          //     so the question goes there and stays a single clean line.
          //   - the form title is only a dim header, so it carries the kind of
          //     form plus any extra `details` context.
          //   - single-select is one `string`-with-options field, which the
          //     client treats as "single": no tab bar, and picking an option
          //     submits straight away. Multi-select needs a multiselect, which
          //     keeps the tab bar and its Submit tab.
          const header = multiple ? "Quiz — select all that apply" : "Quiz"
          const title = context ? `${header} — ${context}` : header

          if (options0.length < 2) {
            return { content: `quiz requires at least two options (got ${options0.length}).`, metadata: { ok: false } }
          }

          const options = input.shuffle === false ? options0 : shuffle(options0)
          const correct = resolveCorrect(input.correctAnswer, options)
          if (correct.error) return { content: correct.error, metadata: { ok: false } }

          // Tell the client the true display order before it blocks on the user,
          // so anything rendering the pending call (md-log) sees the same
          // numbering the user does. Deliberately omits the answer.
          await toolCtx.progress({
            question: input.question,
            options: options.map((o: ChoiceOption, i: number) => ({ index: i + 1, label: o.label })),
          })

          const outcome = await askForm(
            toolCtx.sessionID,
            {
              title,
              fields: [
                // One field only. The question rides in `description` so the
                // client renders it as the bright heading directly above the
                // choices; the form title stays a short dim header. Single-select
                // submits on pick, so there is no separate Submit button at all.
                selectionField("answer", multiple ? "Select all that apply" : "Pick one", input.question, options, {
                  value: DONT_KNOW_VALUE,
                  label: DONT_KNOW_LABEL,
                }, multiple),
              ],
            },
            toolCtx.signal,
          )

          if (outcome.status === "cancelled") {
            return {
              content: `Quiz cancelled (${outcome.message ?? "no answer"}).`,
              metadata: { question: input.question, cancelled: true },
            }
          }

          const selected = readSelection(outcome.answer, "answer")
          const dontKnow = selected.includes(DONT_KNOW_VALUE)
          const picks = selected.filter((v) => v !== DONT_KNOW_VALUE)

          const correctSet = [...correct.values].sort()
          const isCorrect =
            !dontKnow && picks.length === correctSet.length && picks.slice().sort().every((v, i) => v === correctSet[i])
          const labelOf = (value: string) => options.find((o) => o.value === value)?.label ?? value

          const lines: string[] = []
          if (dontKnow) {
            lines.push(
              `User selected "I don't know" — they did not attempt an answer (a genuine knowledge gap, not a wrong guess).`,
            )
          } else {
            lines.push(`User answered ${isCorrect ? "correctly" : "incorrectly"}.`)
            lines.push(`Selected: ${picks.map((v) => labelOf(v)).join(", ") || "(none)"}`)
          }
          lines.push(`Correct: ${correct.values.map(labelOf).join(", ")}`)
          if (explanation) lines.push(`Explanation: ${explanation}`)

          return {
            content: lines.join("\n"),
            metadata: {
              question: input.question,
              correct: isCorrect,
              dontKnow,
              selected: picks,
              correctValues: correct.values,
              options: options.map((o: ChoiceOption, i: number) => ({ index: i + 1, label: o.label })),
              explanation,
            },
          }
        },
      })
    })
  },
}