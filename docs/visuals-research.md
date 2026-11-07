# Visuals research: diagrams and charts in the transcript

The ask: agents should be able to *show* what they mean (a diagram of how three repos talk, a chart of test timings, a table that is really a timeline) instead of writing long blocks of text. Visualization comes first. Interactivity (sliders, clicking something to ask a follow-up) is a second step.

This note covers what ChatGPT and similar products do, how it works where that is known, and what fits this manager.

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

This is meant for products like Figma or a booking app, which bring their own UI. For "the agent explains with a picture", A and B are the right fit. C is the standard to copy for the bridge between the view and the host.

## 3. What this manager already has, and its limits

- **The transcript is a document** (`docs/ui-design.md`): prose blocks, with tools folded into work logs. Some tool calls are already pulled out of the work log into their own block. `ui/src/blocks.ts` does this for `propose_tracks` → plan and `ask_user` → questions. A visual tool fits that same slot.
- **History comes from Claude's session files.** A tool call's input (the visual's code) and a fenced block in the reply are both stored there. Visuals therefore survive restarts, fork and rewind without any new state. That fits the "transcripts are not copied" rule.
- **Markdown** goes through one `Markdown` component (`react-markdown` + GFM + highlight.js) in `Transcript.tsx`, which the Files panel reuses. Anything rendered there also shows in findings files and other `.md` files in the Files panel.
- **No partial streaming.** Messages arrive whole, so a visual appears in one go when its tool call arrives. Until then the step shows "running". That is fine for a first version.
- **Only chats get the `manager` MCP server** (`buildOptions` in `src/manager.ts`). Experts get only their own folder's setup, and only experts get appended instructions (`prompts/expert.md`). Any feature that should work for every agent needs its tool and guidance added in both places.
- **Security groundwork exists.** Raw files are already served with a sandboxing CSP (`src/server.ts`). The UI keeps the API token in the page, so model-written code must never run in the UI's origin.
- **Theme tokens** live as CSS variables in `ui/src/styles.css` (light, system dark, pinned dark). They can be handed to a visual as they are.

## 4. Options

| Option | What the agent writes | Renders | Cost to build | Good for | Limits |
|---|---|---|---|---|---|
| **1. Mermaid fences** | A ` ```mermaid ` block in its reply | Inline, by the UI (lazy-loaded `mermaid`, themed from our tokens, `securityLevel: 'strict'`). The code stays one click away. | Small, UI only | Flowcharts, sequence, state, ER, Gantt, architecture of repos and services. Few tokens. Also renders in `.findings.md` files in the Files panel. | Layout is Mermaid's. No charts with real axes, no interactivity. |
| **2. Chart spec fences** | A ` ```vega-lite ` (or Chart.js JSON) block | Inline, by the UI, with our palette | Small to medium | Bar, line, scatter, timings, counts, token use | One more library. Only charts. |
| **3. `show_visual` tool** (the ChatGPT / Claude feature) | A tool call with `title` + SVG or HTML+JS | Its own transcript block: a sandboxed iframe sized to its content | Medium: one MCP tool, one block kind, an iframe host with a small bridge | Anything: custom diagrams, annotated layouts, small simulations. Interactivity *inside* the visual (sliders, tabs, hover) works from day one. | Most output tokens (a rich visual is several thousand). Needs a design guide for the model, or results look generic. |
| **4. Component catalog** (A2UI-like) | JSON naming our own components (stat row, timeline, comparison, tree) | Native React components | Medium to large, grows per component | Consistent, on-design summaries | Only what we build. Designing the catalog is the work. |
| **5. MCP Apps host** | Nothing: the agent calls third-party MCP tools that carry UI | Iframes from those servers | Large, and possibly blocked | Using other people's MCP apps | The MCP connections live inside the Claude Code process, not the manager. The manager would need `resources/read` on them, and I have not checked whether the Agent SDK exposes that. |

## 5. Recommendation

Build 1 and 3, in that order, and shape the iframe bridge in 3 like MCP Apps so 5 stays open.

**Step 1: Mermaid in Markdown.** A ` ```mermaid ` code fence renders as a diagram in the `Markdown` component, with a toggle to show the source and the source shown if it fails to parse. It is themed from the CSS variables, using the ink and neutral hues plus the state and repo hues only where they mean something (`ui-design.md`). Mermaid is loaded only when a diagram appears. Agents need one or two lines telling them it renders. This is the cheapest big win, because most of what an orchestrator explains (which repo calls which, the order of a handoff, a plan's dependencies) is a diagram.

**Step 2: `show_visual`, the real feature.**
- **Tool:** a new in-process MCP server `display`, given to *every* agent, with `show_visual({ title, kind: 'svg' | 'html', code })`. It is allowed like `mcp__manager`. It returns at once ("shown to the user"), so the turn goes on.
- **Block:** `blocks.ts` takes it out of the work log as a `visual` block, the same way it handles plans. Its frame follows `ui-design.md` (no card chrome, a quiet title line, a "source" toggle, "open large").
- **Sandbox:** an `<iframe sandbox="allow-scripts">` without `allow-same-origin`, so the code gets an opaque origin: it can't read the token, the page or `/api`. The `srcdoc` adds a CSP meta of `default-src 'none'`, allowing only inline scripts and styles, and scripts from a few libraries the manager serves itself (for example d3 or Chart.js), with no network.
- **Bridge, named after MCP Apps:** the host sends the theme and our CSS variables on start and on every theme change (`host-context-changed`). The view reports its height (`size-changed`). Nothing else at first.
- **Guidance:** the tool description holds the rules: use the given variables and no other colours, transparent background, fit the column width, labels at 12px or larger, no emoji or gradients. It also sets *when* to draw: when structure, comparison or change over time is the point, not for decoration. A longer per-kind guide can be returned by a second tool if the description gets too long. Claude's own visuals load their guidance that way.

**Step 3: talking back.** Add `sendPrompt` (MCP Apps `ui/message`): a button in a visual sends a follow-up to the agent. It arrives as a message labelled as coming from the visual, like the existing source labels. Whether it sends at once or fills the composer is a decision for you (see below). Later, `ui/update-model-context` could let a visual pass a selection back without a message.

**Later:** options 2 and 4 if Mermaid plus `show_visual` turn out too loose for charts and summaries. Option 5 once it is clear whether the SDK can reach Claude Code's MCP resources.

## 6. Risks and costs

- **Tokens.** An SVG or HTML visual costs several thousand output tokens (rough estimate, not measured), while a Mermaid block is a few hundred. The guidance should steer toward Mermaid for plain structure and keep `show_visual` for things Mermaid can't draw.
- **Security.** Model-written code is untrusted. The sandbox must stay opaque-origin with no network, and the bridge must not grow a way to reach `/api`. `sendPrompt` sends only text, never a tool call.
- **Readability over time.** Claude treats inline visuals as temporary. Ours stay in history, which is good for an orchestrator's record, but a long chat full of iframes is heavy. Rendering only visuals near the viewport and showing the rest as their title line keeps it light.
- **Experts.** Experts mostly hand back findings files, so Mermaid in `.findings.md` (step 1) may matter more there than `show_visual`.

## 7. Open questions for you

1. Should *every* agent get the visual tool and its guidance, or chats only? Experts would need an appended line in `prompts/expert.md`. Chats have no appended prompt today, so they would need one, or the guidance lives only in the tool description.
2. When a visual's button sends a prompt (step 3), should it send at once like a message from you, or fill the composer for you to send? Sending at once is how Claude and ChatGPT do it. The "decisions never mix with chat" rule argues for a clearly labelled message of its own.
3. Should visuals be exportable (save SVG/PNG, open in a window), or only live in the transcript?

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
