# Visuals: diagrams, cards and comparisons in the transcript

The ask: agents should be able to *show* what they mean (a diagram of how three repos talk, the result of a task, two options side by side) instead of writing long blocks of text. Visualization comes first. Interactivity (sliders, clicking something to ask a follow-up) is a second step.

This note covers what ChatGPT and similar products do and how it works where that is known (sections 1 to 3), then the decisions for this manager and the plan to build it (sections 4 to 7).

## 1. What the products do

| Product | What the user sees | How it is triggered | Source |
|---|---|---|---|
| ChatGPT **Visualize** (preview) | Diagrams, charts, maps and interactive tools (calculators, simulations, explanations with sliders) inside the reply. Refining it means asking in the chat, and a follow-up may produce a new version instead of editing the old one. Results are snapshots, not live dashboards. Generation can take a minute. | ChatGPT picks it when a visual clearly helps, or the user tags `@Visualize`. | [OpenAI docs](https://learn.chatgpt.com/docs/visualizations) |
| ChatGPT **Intelligent UI** (Oct 2026, with GPT-6) | The answer's *format* is chosen per question: comparisons side by side, explanations with diagrams whose inputs you can change. Chat only, not Codex. | Automatic. | [citybiz](https://www.citybiz.co/article/915814/openai-adds-interactive-charts-and-visual-tools-to-chatgpt-with-gpt-6/), [ed.events](https://www.ed.events/post/chatgpt-adds-interactive-explanations-and-visual-answers), [Dataconomy](https://dataconomy.com/2026/10/08/openai-chatgpt-gpt-6-interactive-visuals/) |
| ChatGPT **dynamic visual explanations** (Mar 2026) | 70+ fixed math and science modules (Pythagoras, Ohm's law, compound interest) where you change a variable and the result updates. | Asking about one of those topics. | [TechCrunch](https://www.techcrunch.com/2026/03/10/chatgpt-can-now-create-interactive-visuals-to-help-you-understand-math-and-science-concepts) |
| ChatGPT **interactive charts** (data analysis) | Bar, line, pie and scatter charts from uploaded or described data, with hover and switching. Other kinds come back as static images. | Asking for a chart. | [Powerdrill overview](https://powerdrill.ai/blog/chatgpt-intelligent-ui) |
| ChatGPT **apps** (Apps SDK) | Third-party widgets (maps, booking, product lists) inline in the chat, from an MCP server. | The model calls the app's tool. | [OpenAI: MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt) |
| Claude **inline visuals** (beta, Mar 2026) | Charts, diagrams, flowcharts and small interactive pieces inline in the reply. They are explicitly *temporary* aids that change or disappear as the chat moves on. Artifacts are the separate, permanent, shareable kind. | Claude decides, or the user asks ("draw this as a diagram"). | [Anthropic](https://claude.com/blog/claude-builds-visuals) |
| Gemini interactive diagrams (Nov 2025) | The same idea for study topics. | Automatic. | [TechCrunch](https://www.techcrunch.com/2026/03/10/chatgpt-can-now-create-interactive-visuals-to-help-you-understand-math-and-science-concepts) (mention) |

**What they share:**
1. The visual sits *in the reply*, between paragraphs, not in a side panel.
2. The model decides when to draw. The user can also ask for one.
3. It is refined by chatting, not by editing the visual itself.
4. Charts and diagrams come first. Interactivity is built on the same rendering.

## 2. How it works

OpenAI does not document how Visualize or Intelligent UI render. Three mechanisms are visible across the products, and they can be combined.

**A. The model writes code and the host runs it in a sandbox.** This is how Claude's inline visuals work: the model calls a visual tool with a title and a piece of SVG or HTML (with scripts). The host renders it inline, isolated from the page. The host gives the code its theme as CSS variables, so the visual matches light and dark. It also offers a `sendPrompt(text)` function, so a click inside the visual can send a follow-up message as the user. Before drawing, the model loads design guidance for the kind of visual it is making (diagram, chart, interactive), so the system prompt stays small. This is the most expressive approach (anything a web page can draw), and it costs the most output tokens.

**B. The model writes a declarative spec and the host draws it with its own components.** Mermaid for diagrams and chart specs (Vega-Lite, a Chart.js config) are the familiar forms. [A2UI](https://a2ui.org/) (Google with CopilotKit) generalizes this: the agent sends JSON naming components from a **catalog** the client approved, and the client renders its own native widgets ([CopilotKit docs](https://docs.copilotkit.ai/teams/strands/generative-ui/a2ui)). It is safe, cheap in tokens, always on-brand and streams well, but it can only show what the catalog has.

**C. A tool server ships a UI template and the host renders it with the tool's result.** OpenAI's Apps SDK did this first. It is now the open **MCP Apps** extension ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp), [spec](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)), and OpenAI's docs now point new work at it, keeping `window.openai` as a compatibility layer ([OpenAI](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)). The parts worth borrowing:
- A tool names its template with `_meta.ui.resourceUri` (a `ui://` resource, MIME type `text/html;profile=mcp-app`). `_meta.ui.csp` declares the only domains it may reach.
- The view runs in a sandboxed iframe on a different origin. It talks to the host over JSON-RPC through `postMessage`: `ui/initialize`, `ui/notifications/initialized`, `ui/notifications/size-changed` (its height), and `ui/notifications/host-context-changed` (theme, `styles.variables` with CSS custom properties, display mode `inline` / `fullscreen` / `pip`).
- The way back: `ui/message` (send a message into the chat), `ui/update-model-context` (add context for the next turn), and `tools/call`. Each one is a capability the host may withhold or ask the user to approve. Tools can be marked visible to the app only.

This is meant for products like Figma or a booking app, which bring their own UI. For "the agent explains with a picture", B fits best (section 4). C's ideas matter later, if visuals ever run code.

## 3. What this manager already has, and its limits

- **The transcript is a document** (`docs/ui-design.md`): prose blocks, with tools folded into work logs. Some tool calls are already pulled out of the work log into their own block. `ui/src/blocks.ts` does this for `propose_tracks` → plan and `ask_user` → questions. A visual tool fits that same slot.
- **History comes from Claude's session files.** A tool call's input (the visual's code) and a fenced block in the reply are both stored there. Visuals therefore survive restarts, fork and rewind without any new state. That fits the "transcripts are not copied" rule.
- **Markdown** goes through one `Markdown` component (`react-markdown` + GFM + highlight.js) in `Transcript.tsx`, which the Files panel reuses. Anything rendered there also shows in findings files and other `.md` files in the Files panel.
- **No partial streaming.** Messages arrive whole, so a visual appears in one go when its tool call arrives. Until then the step shows "running". That is fine for a first version.
- **Only chats get the `manager` MCP server** (`buildOptions` in `src/manager.ts`). Experts get only their own folder's setup, and only experts get appended instructions (`prompts/expert.md`). Any feature that should work for every agent needs its tool and guidance added in both places.
- **Security groundwork exists.** Raw files are already served with a sandboxing CSP (`src/server.ts`). The UI keeps the API token in the page, so model-written code must never run in the UI's origin.
- **Theme tokens** live as CSS variables in `ui/src/styles.css` (light, system dark, pinned dark). They can be handed to a visual as they are.

## 4. Decisions

| Question | Decision | Why |
|---|---|---|
| Code (SVG/HTML) or a description the UI draws? | **A description** made of a few building blocks the UI draws itself. | Models are bad at placing boxes and arrows by hand. With a description, the design rules (`ui-design.md`) hold automatically, and nodes can link to experts and files. It also costs fewer tokens and runs no model-written code, so no sandbox is needed. SVG/HTML stays a possible escape hatch for later. |
| Many block types or a few that nest? | **Three that nest:** `Row`, `Column` and `Card`. Cards can hold children. | A flow node is a small card, a group is a card with children, and a branch is a row. Stats, lists and comparisons are also rows and columns of cards. Fewer types make a shorter guide and fewer mistakes. |
| How are arrows chosen? | **A flag on the container** (`arrows`) and a label on the child they point to (`arrow="..."`). No free arrows from one box to another. | Container arrows cover small flows. Free arrows mean measuring and routing lines around boxes, which looks messy. Diagrams that need them use Mermaid. |
| JSON or markup? | **JSX-like markup**: tags and string attributes only, never run as code. | It is shorter than JSON. A closing tag names what it closes, and text goes inside the tag. Models know `<Card icon title>` from docs sites (Mintlify, MDX). |
| Code block in the reply or a tool call? | **A tool call**, `show_visual({ markup })`. | The manager parses the markup and returns exact errors, so the agent fixes them in the same turn. The tool description teaches the format to every agent that has the tool, so chats need no appended prompt. Text and tool calls already arrive in order, so the visual still sits between the agent's paragraphs. The cost is one extra round trip per visual. |
| Also in Markdown files? | **No.** Visual markup only exists in tool calls. | Files are also read by other programs, which would show the markup as noise. |
| Complex diagrams? | **Mermaid** code blocks in the reply. | Sequence diagrams, state machines, data models and big graphs need real graph layout. Mermaid is a standard that GitHub and editors render too, so it is fine in files as well. |
| MCP Apps (other servers' UIs)? | **Not now.** | The MCP connections live inside the Claude Code process. It is unchecked whether the Agent SDK lets the manager read their UI resources. |

## 5. The plan

### 5.1 The markup

Three elements. Text inside a `Card` is its body; elements inside it are its children, stacked top to bottom.

| Element | Attributes | Notes |
|---|---|---|
| `<Column>` | `arrows` (flag), `arrow` | Children top to bottom. With `arrows`, an arrow between each child and the next. |
| `<Row>` | `arrows` (flag), `arrow` | Children side by side; at most 4, more wrap. Stacks at a narrow width (arrows then point down). |
| `<Card>` | `title` (required), `icon`, `tone`, `badge`, `value`, `repo`, `link`, `arrow` | `value` makes it a key number with `title` as its label. |

- `icon`: a name from a fixed list of about 60 `lucide-react` icons (in the tool description).
- `tone`: `accent`, `ok`, `warn`, `bad` or `running`, mapped to the aqua accent and the state hues. No tone means neutral.
- `repo`: a repo name, drawn with that repo's hue like expert marks.
- `link`: `expert:<name>` (one of the caller's experts) opens its transcript; `file:<path>` (inside the agent's folders) opens it in the Files panel; `https://...` opens a new tab.
- `arrow`: the label of the arrow leading into this element, when its parent has `arrows`. An arrow into a `Row` points at the row as a whole.
- Body text is plain text with inline `` `code` ``.

The screenshot that started this:

```xml
<Column arrows>
  <Card icon="brain" title="AI model">Chooses which interface to show</Card>
  <Card title="Your MCP tools" badge="Existing + new" arrow="MCP tool call">
    <Card icon="list-checks" title="show_task_card" />
    <Card icon="circle-help" title="ask_question" />
    <Card icon="workflow" title="show_simple_diagram" badge="New" tone="accent" />
  </Card>
  <Card icon="layout-template" title="Your host UI renderer">Selects the correct React component</Card>
  <Row>
    <Card icon="list-checks" title="TaskCard" />
    <Card icon="circle-help" title="Question" />
    <Card icon="git-branch" title="Diagram" />
  </Row>
</Column>
```

A result card:

```xml
<Card icon="circle-check" tone="ok" title="Auth fix merged" badge="PR 42" repo="auth" link="expert:auth-fixer">
  Token refresh no longer races the logout call.
  <Card icon="flask-conical" title="128 tests passed" />
  <Card icon="file-diff" title="4 files changed" link="file:src/auth/refresh.ts" />
</Card>
```

A comparison and a row of numbers:

```xml
<Row>
  <Card title="Redis" badge="Recommended" tone="accent">
    <Card icon="check" tone="ok" title="Survives restarts" />
    <Card icon="x" tone="bad" title="Needs a new service" />
  </Card>
  <Card title="In-memory">
    <Card icon="x" tone="bad" title="Lost on restart" />
    <Card icon="check" tone="ok" title="No setup" />
  </Card>
</Row>

<Row>
  <Card title="Tests" value="128" tone="ok" />
  <Card title="Failed" value="0" />
  <Card title="Duration" value="42 s" />
</Row>
```

A branch with labels:

```xml
<Column arrows>
  <Card icon="key-round" title="Check token" />
  <Row>
    <Card icon="server" title="Call the API" arrow="valid" />
    <Card icon="circle-x" title="Show 401 page" tone="bad" arrow="expired" />
  </Row>
</Column>
```

**Limits**, checked by the parser: at most 4 levels of nesting, 40 elements, 4 children per row before wrapping (a warning, not an error), titles up to 60 characters and body text up to 300.

### 5.2 The parser (`src/visual.ts`)

One module with no Node dependencies, used by the tool and by the UI (the UI already imports `src/types.ts`). It turns markup into a tree:

```ts
type VisualNode =
  | { type: 'row' | 'column'; arrows: boolean; arrow?: string; children: VisualNode[] }
  | { type: 'card'; title: string; icon?: string; text?: string; value?: string; tone?: Tone;
      badge?: string; repo?: string; link?: string; arrow?: string; children: VisualNode[] };
```

- A small tag parser of its own: tags, quoted string attributes, flags, text and `/>`. No HTML parser and nothing inserted as HTML. `&lt;`, `&gt;`, `&amp;` and `&quot;` are decoded.
- Errors carry a line number and say what to do: "line 5: `<Crad>` is not an element; use Row, Column or Card", "line 3: icon `rocket-ship` is unknown; see the icon list", "line 9: `</Row>` closes `<Card>` from line 6".

### 5.3 The tool (`show_visual`)

- A new in-process MCP server `display`, given to **every** agent (chats and experts) and allowed like `mcp__manager`. It is created per agent, so it can check `expert:` links against the caller's experts and `file:` links against its folders.
- Input: `{ title?: string, markup: string }`. On errors it returns them with `isError`, and the agent tries again. On success it returns "Shown to the user." plus one line telling the agent not to repeat the visual's contents in its text (agents tended to explain everything twice), so it adds almost no context.
- The description holds everything the agent needs: when to draw (structure, steps, results, comparisons; not decoration, not for one fact), the three elements and their attributes, the icon list, the limits, three short examples, and one line saying that bigger diagrams go in a ` ```mermaid ` block in the reply.

### 5.4 The renderer

- `blocks.ts` lifts a successful `show_visual` call out of the work log into a `visual` block, as it does for plans. Failed calls stay in the work log as ordinary failed steps.
- `Visual.tsx` draws the tree with React and CSS flexbox, plus small SVG arrows with their labels.
- **The look comes from depth, not from the agent.** A top-level card gets a hairline border. Cards inside a card draw as rows without a box when they are one line, and on a soft tile when they have a body, children or a number. Value cards show a large number over a small label. Spacing and type sizes come from `styles.css`. Colour appears only through `tone` and `repo`.
- A visual is as wide as the transcript column. Rows stack below a set width, so the narrow layout and split view work.
- A quiet title line with a "Source" toggle that shows the markup.
- Links: `expert:` selects the agent, `file:` opens the Files panel through the existing link events in `fileStore.ts`, and URLs open a new tab.
- `docs/ui-design.md` gets a section on visual blocks in the same commit.

### 5.5 Mermaid

- ` ```mermaid ` code blocks render as diagrams in the `Markdown` component, so in replies and in `.md` files in the Files panel.
- Mermaid is loaded only when a diagram appears, with `securityLevel: 'strict'`.
- Its theme variables are filled from the computed CSS variables, and the diagram re-renders when the theme changes.
- If a diagram fails to parse, its source shows as an ordinary code block. A toggle shows the source of a working diagram.

### 5.6 Steps

| # | Step | Status |
|---|---|---|
| 1 | `src/visual.ts`: markup parser, limits, icon list and error messages, checked with a script over good and broken examples | done |
| 2 | `display` MCP server with `show_visual` for every agent (`src/display.ts`); README | done |
| 3 | `Visual.tsx` and the `visual` block in the transcript; links; `ui-design.md` | done |
| 4 | Mermaid blocks in `Markdown` (`Mermaid.tsx`) | done |
| 5 | Try it with real agents, tune the tool description and the limits | ongoing |
| 6 | Second round of elements (5.7), from the mockup in `docs/mockups/visuals-proposals.html` | done |

### 5.7 Second round: elements for planning and investigating

The two main uses are planning an implementation with the user (options, reasoning, how it lands) and investigating a bug (hypotheses, evidence, where it breaks). The mockup `docs/mockups/visuals-proposals.html` shows each element; this round built them:

- **`<More>`** in a Card or an Item: details the user opens with a chevron at the end of the line. Text and `<Code>` only, never boxes, so it never hides structure. An Item with children can't have one (its row folds the children).
- **Card attributes:** `meta` (quiet text on the right), `change` (next to a `value`), `progress` (`60`, `60%` or `3/5`, a thin meter; its label shows as meta).
- **`<Tree>` with nested `<Item>`:** folder layouts, call trees, component trees. Flat paths were considered and dropped: nested items work for any hierarchy, not only files. Rows fold (the `collapsed` flag starts one folded; a folded row says how many items it hides). Links are optional per item, so existing and planned code mix: a leaf with a link opens it when clicked, and a row with children shows the location (`logout.ts:40`) on the right. New things use `tone="accent"`; moves and removals are words in `meta`, not git letters. Six levels deep.
- **`<Timeline>` with `<Item when>`:** incidents, runs, the PRs of a plan. Items after the `running` one get a hollow dot. Items don't nest.
- **Separate elements, not `Column` flags:** a flag would give one tag three meanings and make attributes like `when` valid in one place only. A name says what gets drawn, and agents know `Tree` and `Timeline` from component libraries.
- **`<Code file line mark lang>`:** an excerpt of at most 30 lines, taken literally up to `</Code>` (so `<` and `&` need no escaping) and dedented. `line` numbers it like the file; `mark` (`42`, `42-44`, `40, 43`) tints lines in the same numbers; `lang="diff"` tints `+` and `-` lines. The header opens the file at the first marked line. The tool compares the excerpt with the file and warns the agent when they differ (whitespace ignored, an `…` line stops the comparison), which catches made-up or stale evidence.
- **`<Bars>` with `<Bar>`**, **`<Image src="file:…">`** (an image in the agent's folders, through the Files API's raw route), and Mermaid chart colours: pie slices and xychart series use the repo identity hues.
- **File links take a line:** `file:src/a.ts:42` opens the Files panel at that line, marked in the accent tint.
- **Limits:** titles 80 characters (60 made agents retry on timeline steps), 60 elements, `<More>` text 600 characters. `note="…"` on an Item is accepted, since agents guess it.

Tested with Haiku on an investigation and a fix plan: it used every element, with a few retries for unknown attributes and long titles before the changes above. The tool description is now about 1,900 tokens.

**Later:** clicking a card to ask the agent about it (the interactive step), see question 1 below. An SVG/HTML escape hatch in a sandboxed iframe, built on the MCP Apps ideas in section 2, only if the three elements prove too limited.

## 6. Risks and costs

- **Overuse.** Agents may draw when a sentence would do. The tool description says when not to, and step 5 is there to tune it.
- **Round trips.** Each visual adds one model call to the turn. With the prompt cache this is a few seconds.
- **Description length.** The tool description goes into every agent's context. It is about 1,900 tokens after the second round (three examples: a flow, a plan, an investigation); keep it near that.
- **Ugly compositions.** Deep nesting or crowded rows still look bad. The limits and the depth-based look keep that in check.
- **Mermaid in the UI bundle.** It is large, hence the lazy load.

## 7. Open questions

1. When the user clicks a card (the interactive step), should it send a message to the agent at once, labelled as coming from the visual, or fill the composer?
2. Should visuals be exportable (copy as an image, open large), or only live in the transcript?

## Sources

- [OpenAI: Visualizations](https://learn.chatgpt.com/docs/visualizations)
- [citybiz: OpenAI adds interactive charts and visual tools with GPT-6](https://www.citybiz.co/article/915814/openai-adds-interactive-charts-and-visual-tools-to-chatgpt-with-gpt-6/)
- [Dataconomy: interactive visuals alongside GPT-6](https://dataconomy.com/2026/10/08/openai-chatgpt-gpt-6-interactive-visuals/)
- [ed.events: interactive explanations and visual answers](https://www.ed.events/post/chatgpt-adds-interactive-explanations-and-visual-answers)
- [TechCrunch: interactive visuals for math and science](https://www.techcrunch.com/2026/03/10/chatgpt-can-now-create-interactive-visuals-to-help-you-understand-math-and-science-concepts)
- [Powerdrill: ChatGPT Intelligent UI overview](https://powerdrill.ai/blog/chatgpt-intelligent-ui)
- [Anthropic: Claude builds visuals](https://claude.com/blog/claude-builds-visuals)
- [SEP-1865: MCP Apps](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
- [MCP Apps specification (ext-apps)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
- [OpenAI: MCP Apps in ChatGPT](https://developers.openai.com/apps-sdk/mcp-apps-in-chatgpt)
- [A2UI](https://a2ui.org/), [CopilotKit A2UI docs](https://docs.copilotkit.ai/teams/strands/generative-ui/a2ui)
