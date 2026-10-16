/**
 * ask_user_question — ask one question, no notion of right or wrong.
 *
 * Ported from `.pi/extensions/ask-user-question.ts`, kept alongside OpenCode's
 * built-in `question` tool because the two differ: `question` is the general
 * clarification tool, while this one is shaped for the teaching loop — a
 * single question, optional options, and an explicit free-text "Other" escape
 * hatch on every options call.
 *
 * Like the pi original it never grades: if the question has a right answer,
 * use `quiz` instead.
 */

import {
  askForm,
  normalizeOptions,
  OTHER_VALUE,
  readSelection,
  selectionField,
  type ChoiceOption,
} from "../learn/shared.js"

const GUIDELINES = [
  "Ask exactly one question per tool call.",
  "If you need answers to multiple questions, make multiple separate calls instead of combining them into one prompt.",
  "Omit `options` for a free-form answer. When options are given, 'Other' is always available for custom input.",
  'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
  "Use multiSelect: true only when you need multiple answers to the same question.",
  "Prefer this over guessing when requirements, preferences, or implementation choices are unclear.",
]

const OPTION_SCHEMA = {
  type: "object",
  properties: {
    label: {
      type: "string",
      description: 'Display label for the option. If you recommend an option, place it first and append "(Recommended)".',
    },
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
    question: { type: "string", description: "The single question to ask the user. Ask exactly one question per tool call." },
    details: { type: "string", description: "Optional extra context or instructions shown under the question." },
    options: {
      type: "array",
      description:
        "Optional multiple-choice options. Omit or pass an empty array for free-form text input. 'Other' is always available for custom input when options are provided.",
      items: OPTION_SCHEMA,
    },
    multiSelect: { type: "boolean", description: "Set to true to allow multiple answers to a question." },
  },
  required: ["question"],
  additionalProperties: false,
} as const

export default {
  id: "learn.ask-user-question",
  async setup(ctx: any) {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "ask_user_question",
        description:
          "Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate calls over bundling unrelated questions together. Omit `options` for a free-form answer.\n\nGuidelines:\n" +
          GUIDELINES.map((line, i) => `${i + 1}. ${line}`).join("\n"),
        input: INPUT_SCHEMA,
        options: { permission: "ask_user_question" },
        execute: async (input: any, toolCtx: any) => {
          const options = normalizeOptions(input.options)
          const context = input.details?.trim() || undefined
          const multiple = input.multiSelect === true
          const otherLabel = options.some((o) => o.label.toLowerCase() === "other") ? "Other (custom)" : "Other"

          if (options.length === 0) {
            const outcome = await askForm(
              toolCtx.sessionID,
              {
                title: "Question",
                fields: [
                  {
                    key: "answer",
                    type: "string",
                    title: input.question,
                    ...(context ? { description: context } : {}),
                    required: true,
                  },
                ],
              },
              toolCtx.signal,
            )
            if (outcome.status === "cancelled") return "User cancelled the question."
            const text = typeof outcome.answer.answer === "string" ? outcome.answer.answer.trim() : ""
            return {
              content: text ? `User answered: ${text}` : "User submitted an empty response.",
              metadata: { question: input.question, mode: "text", answers: text ? [text] : [], context },
            }
          }

          const outcome = await askForm(
            toolCtx.sessionID,
            {
              title: context ? `Question — ${context}` : "Question",
              fields: [
                // Question rides in `description`, which the client renders as
                // the bright heading above the choices. Single-select submits on
                // pick, so no tab bar and no Submit tab.
                selectionField(
                  "answer",
                  multiple ? "Select all that apply" : "Pick one",
                  input.question,
                  options,
                  { value: OTHER_VALUE, label: otherLabel },
                  multiple,
                ),
              ],
            },
            toolCtx.signal,
          )
          if (outcome.status === "cancelled") return "User cancelled the question."

          const picks = readSelection(outcome.answer, "answer")
          const real = picks.filter((v) => v !== OTHER_VALUE)
          const custom = picks.includes(OTHER_VALUE)
            ? String(outcome.answer.other ?? "").trim() || (typeof outcome.answer.answer === "string" ? "" : "")
            : ""

          const labelOf = (value: string) => options.find((o: ChoiceOption) => o.value === value)?.label ?? value
          const answers = [...real.map(labelOf), ...(custom ? [`Other: ${custom}`] : [])]

          return {
            content:
              answers.length > 0
                ? multiple
                  ? `User selected:\n${answers.map((a) => `- ${a}`).join("\n")}`
                  : `User selected: ${answers[0]}`
                : "User selected nothing.",
            metadata: { question: input.question, mode: multiple ? "multi-select" : "single-select", answers, context },
          }
        },
      })
    })
  },
}