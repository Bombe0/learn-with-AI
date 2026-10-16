# learn

My AI learning system, ported from [amosblomqvist/learn](https://github.com/amosblomqvist/learn) (originally a [pi](https://github.com/earendil-works/pi) configuration) to OpenCode.

The teaching philosophy is encoded in a skill, a few small plugins provide the interactive tools, and agent definitions cover the subagents the system delegates to.

## What's in it

- `skills/` — `teach` (the philosophy and the process), `visualize` (adds a correct, minimal diagram to a lesson when an idea is clearer as a picture), `bpmn-diagram` (turns a process description into validated BPMN 2.0 XML)
- `plugins/learn.quiz.ts` — graded questions with instant feedback (✓/✗, correct answer, explanation)
- `plugins/learn.ask-user-question.ts` — the agent asks you questions through a popup
- `plugins/learn.md-log.ts` — link a markdown file to the session (`/md-log <path>`, `/md-unlog`)
- `plugins/learn.visual-tools.ts` — tools for the visualization subagents
- `agent/` — `researcher`, `svg-maker`, `mermaid-maker`: the subagents the system delegates to
- `renderers/` — isolated `npm install` for the two renderers (see Requirements)
- `learn/shared.ts` — form plumbing shared by `quiz` and `ask_user_question`
- `opencode.jsonc` — registers the `skills/` source and allows the plugin tools and the three subagents

Everything lives under `.opencode/`; the project root holds only `.opencode/` and `.gitignore`. Generated diagrams land in `viz/` at the root, which is gitignored.

## Requirements

- OpenCode v2 (`opencode --version` → 2.x)
- Chrome installed, for Mermaid rendering (`mmdc` uses it via puppeteer instead of downloading Chromium)

`@opencode/plugin` is a peer of the OpenCode runtime and does not need to be installed here — the plugins import no OpenCode packages, only `node:` builtins.

### Renderers

The visualization tools need two native renderers. They live in their own install under `renderers/`, resolved by the plugin relative to itself, so the learning project itself never carries a `node_modules`:

```bash
npm install --prefix .opencode/renderers
```

| Package | Used for |
| --- | --- |
| `@mermaid-js/mermaid-cli` | `render_mermaid` |
| `@resvg/resvg-js` | `render_svg` |

Only needed if you use the `visualize` skill or the maker subagents. `teach`, `quiz`, `ask_user_question` and `md-log` have no dependencies.

## Notes

- `quiz` and `ask_user_question` use OpenCode's session **form** API, which every client renders natively. In a headless `opencode run` (no interactive client attached) the server cancels the form immediately, so the tools report a cancellation rather than hanging — that matches the pi originals, which also refused to run without a TUI.
- The built-in `question` tool overlaps with `ask_user_question`. Both are kept: `ask_user_question` always offers an "Other" free-text option, which matters when the learner's goal is still half-formed. The `teach` skill uses `ask_user_question` for that reason.
- Visual tools publish into `<project>/viz`, and the `md-log` plugin mirrors the session into a linked Markdown file, so `![[viz-….png|500]]` embeds resolve by filename in Obsidian.
- You can run the system without subagents. The main session does the teaching. You just lose the researcher (truth verification) and the generated visuals.
- The teaching skill is written for one learner (me). Edit the skill to fit how you learn best.