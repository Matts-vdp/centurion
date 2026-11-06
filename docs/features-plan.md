# Skill autocomplete, cache countdown and image input

Three composer and header features. The file viewer with a project tree and a git panel (diff, staging, commit, merge) are separate, later plans.

## 1. Skill autocomplete

- **Where the list comes from:** a Claude Code process answers `supportedCommands()` without an API call, like `supportedModels()`. Skills depend on the folder (its `.claude/skills` plus `~/.claude`), so the manager keeps the list **per folder**: it learns it from every process that starts and from `commands_changed` events, and otherwise probes a prompt-less process in that folder (with the same `settingSources`), once, cached for the manager's lifetime.
- **API:** `GET /api/agents/:id/commands` → `{ name, description, argumentHint }[]`. Claude Code's own commands (`builtin`) are left out: most of them are terminal UI and do nothing in an SDK process.
- **Composer:** typing `/` as the first character opens a menu above the box, filtered by what follows (prefix matches first, then substring). ↑/↓ move, Tab or Enter fill in `/name `, Esc closes. Enter on text that already is `/name` sends it.

## 2. Cache countdown

- Claude Code caches the prompt with a 1-hour TTL on subscriptions (5 minutes otherwise); every request that reads the cache restarts the timer. The API doesn't say when it expires, so the manager estimates it.
- **Backend:** per turn, `AgentRuntime` notes the start of the last main-loop request (delivery, or the last tool result before that call) and the TTL from the call's `usage.cache_creation` (`ephemeral_1h_input_tokens` → 1 h, `ephemeral_5m_input_tokens` → 5 min, neither → the TTL seen before). The record gets `cache: { at, ttlSeconds }` when the turn ends. A rewind or a model change clears it (the next turn starts a new cache).
- **UI:** a small tag right of the context ring: `cache 42m`, then `cache 0:59` in the last minute (in `--waiting`), then `cache cold` in `--text-3`. Hidden while a turn runs and before the first turn. The tooltip says it is an estimate and what cold means.

## 3. Image input

- **Composer:** paste, drop or the attach button; thumbnails above the text with a remove button. The browser scales anything larger than 1568 px on the long side (what the API scales to anyway) or over 3.5 MB to WebP. PNG, JPEG, GIF and WebP only, up to 10 images.
- **API:** `POST .../messages` takes `images: { mediaType, data }[]` (base64) next to `text`; the text may be empty when there are images. That route accepts bodies up to 40 MB.
- **No copies kept:** Claude Code stores sent images in its own session file, and history is read from there. The manager only holds images of messages **still in the queue**, as files in `uploads/<agent>/` next to the state file; the queue entry keeps `{ file, mediaType }`. The files are deleted when the message is delivered, removed from the queue, or the queue is cleared, and on startup any file no queue entry refers to is removed.
- **Transcript:** image blocks in history become thumbnails on the prompt; the live `delivered` event carries the image data once so the prompt shows them before history reloads. A click opens the image full size.
