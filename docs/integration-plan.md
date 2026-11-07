# Integration with other front ends

At work there is a dashboard (the "AW hub") that shows the automatic implementation system: which tasks agents are working on, which steps they are in, which dev containers run. The work flow is: plan across repos with an orchestrator and experts (this manager), split the plan into one task per repo, push the tasks to the implementation system, follow them in the hub. The two should feel like one tool.

The core stays generic: it offers ways to be embedded and read, and ways to show outside status. Everything that knows about the hub lives in the work repo.

**Status:** not planned yet. The likely first step is embedding (2); the rest is decided once that is in use.

## The integration points, from cheap to expensive

### 1. Links (core: nothing new)
The hub links to a chat with `http://<manager>/#agent=<id>` (the hash already follows the focused pane). The manager links to a hub task by URL in a chat message or a visual. Works today, but it is two tabs.

### 2. Embed mode (core, small)
The hub shows the manager UI in an iframe.
- `?embed=1` (or `&view=agent`) hides the sidebar and shows one agent, or a chat with its experts.
- `?theme=light|dark`, and a `postMessage` channel for theme changes and "open agent X" from the host, and "agent X needs input" back to it.
- Config `frameAncestors: ["https://hub.example"]` sets the `Content-Security-Policy: frame-ancestors` header; by default framing is refused.
- Token: the hub passes it in the URL (as today) or, better, gets a short-lived one from the manager. Same host and port issues as running in a container.

The fastest way to "one tool", with no shared code, and it keeps working when the UI changes, because the hub only knows the URL.

### 3. A stable, documented API (core, medium)
The hub draws its own widgets (a "planning" column next to "implementing", counts of chats waiting for the user) from the manager's HTTP API and SSE.
- Version it: `/api/v1/...`, with the current routes as v1, and a changelog. Today the API is internal and changes with the UI.
- `allowedOrigins` in config for CORS, and the token in an `Authorization` header (EventSource can't set headers, so SSE keeps `?token=`, or uses a fetch-based stream).
- A small summary endpoint (`GET /api/v1/summary`: agents with state, waiting decisions, running tracks) so a widget doesn't have to replay the whole `snapshot`.
- A typed client (`centurion/client`): the types from `src/types.ts` and the SSE store without React. The UI's `store.ts` already is most of this.

### 4. Outside status inside the manager (core, medium)
The other direction: when an orchestrator pushes tasks to the implementation system, the round tracker should show their status, not just "pushed".
- An agent tool can already push a task; that is a work MCP server (in the work repo, through `.mcp.json` or the config's per-role MCP servers), not core code.
- Core adds a generic **external track**: a track whose status comes from outside, set through the API (`POST /api/v1/tracks/:id/status { state, label, url }`) by the hub or a small work-side bridge. The tracker shows it like any track, with a link to the hub.
- The same shape could serve "links to the user's own agentic dev system" at home.

### 5. Shared components (core, large)
Publish UI pieces (transcript, plan, questions, visuals) as a library the hub renders itself.
- As **React components**: only works if the hub is React with a compatible version, and the components need the manager's store, CSS variables and fonts. Every internal refactor becomes a breaking change.
- As **web components** (`<agent-transcript agent="..." base-url="..." token="...">`, React inside Shadow DOM): framework-agnostic, styles isolated, still a public surface to keep stable.
Worth it only if the iframe is clearly not enough (for example the hub needs the transcript inline in its own layout with its own interactions).

## Recommendation

1. Embed mode (2) and the versioned API with CORS and a summary endpoint (3): together they cover "see planning and implementation in one place" with little public surface.
2. External tracks (4) when tasks start being pushed from a plan: that is the real link between the two halves of the flow.
3. Components (5) only after the above, and as web components unless the hub is React and staying React.

Work side (in the work repo, not here): the MCP server that pushes tasks, the bridge that reports their status back, and the hub's iframe page or widgets.

## Open questions

- What is the hub built with (framework, hosting)? Does it run where the manager runs (the same container network, localhost), or centrally? A central hub reaching a manager in someone's dev container needs a way in (port forward, tunnel) and real auth, not a shared token.
- Which one is the main shell at work: the hub with the manager inside, or the manager with hub status inside? Both are possible; the first matches "the hub already exists".
- One manager per developer, or one per team? The manager is single-user today (one token, one `~/.claude` login).
