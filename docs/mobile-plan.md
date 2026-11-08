# Phone over LAN and PWA: plan

The phone is on the same Wi-Fi and opens the PC's local IP (no tunnel). On the phone the user needs the sidebar and the chat: send messages, follow up on permissions, question sets, plans, the queue, model and effort. The Files panel, git and the diff viewer stay on the PC. Centurion also gets a basic PWA, so it can be installed on the phone and on the PC as an app window instead of a tab.

Three parts, each shippable and committed on its own: **A. LAN access** (server), **B. phone layout** (UI), **C. PWA** (manifest, service worker, install). **D. Web Push** is a later, optional part (see §3.5).

## 1. LAN access

### 1.1 Today

- `host` defaults to `127.0.0.1` (`src/config.ts`), overridable by `CENTURION_HOST`. `0.0.0.0` already works, and the startup line then prints `http://localhost:…/?token=…`, which is useless on a phone.
- Auth (`authorized` in `src/server.ts`): `Authorization: Bearer <token>` or `?token=` on every `/api/` call, compared with `timingSafeEqual`. UI files (`serveUi`) are served without a token. `CENTURION_TOKEN=''` disables the check.
- The UI takes `?token=` once, keeps it in **`sessionStorage`** and strips it from the URL (`ui/src/api.ts`). It still puts the token into URLs for the `EventSource` (`eventsUrl`) and raw file images (`fileStore.ts`), because neither can send a header.
- No `Host` or `Origin` check, no CORS headers (so other origins can send blind requests but can't read the answers), no cookies.

### 1.2 Opting in

- **`centurion start --lan`**: listens on `0.0.0.0` for this run. For a permanent setup, `host: "0.0.0.0"` (or one interface's address) in the config, as today. LAN mode = the host is not a loopback address. Keep `host` as the single field; the flag just sets it. Update the `host` field's description (it only mentions docker).
- **Startup output in LAN mode** lists every non-internal IPv4 address from `os.networkInterfaces()` (skip `169.254.*`, mark virtual adapters such as `vEthernet (WSL)` / Hyper-V / VirtualBox as such and print them last), e.g.

  ```
  Centurion listening on http://localhost:4317/?token=…
  On your network: https://192.168.1.20:4317  (Wi-Fi)
  Scan to pair a phone (valid 10 min):  <QR>
  ```

  The QR comes from the `qrcode` package (`toString(url, { type: 'terminal', small: true })`; it also renders the SVG for the UI, so one dependency covers both).
- **Refuse LAN mode with an empty token** (`CENTURION_TOKEN=''`): print why and exit. On loopback the empty token stays allowed.
- The PC's IP must not change, or the phone's bookmark and the installed PWA (whose identity is the origin) break. The docs suggest a DHCP reservation on the router. `<pc-name>.local` (mDNS) works on Windows and iOS but not reliably on Android, so the IP stays the main URL; a configured `publicHost` can be added later if a name is wanted.

### 1.3 Getting the token to the phone: pairing codes and a cookie

Typing a 32-character token on a phone is not an option, and a token in a URL ends up in history, screenshots and photos of a QR code. Proposal:

1. **One-time pairing codes.** `POST /api/pair` (authorized) returns `{ url, svg, expiresAt }`: a random code, valid for 10 minutes and for one use, kept in memory. The URL is `<lan origin>/pair?code=<code>`. The terminal QR at startup is one of these (a fresh one is printed again by `centurion pair` or when the first one expires, if wanted).
2. **`GET /pair?code=…`** (outside `/api/`, so it works as a plain navigation) checks and burns the code, sets the auth cookie and redirects to `/`. A wrong or used code shows a small page: "This pairing code has expired. Make a new one on the PC: Open on your phone."
3. **The cookie**: `centurion_token=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=400 days` (the browser maximum), plus `Secure` when serving HTTPS. Its value is the token itself, so rotating the token signs every device out; no session table. `authorized` accepts header, cookie or (for now) `?token=`.
4. **The UI side**: `?token=` on first visit also goes through the cookie (`POST /api/session` with the bearer token sets it, then the UI forgets the token). After that `api()` and `EventSource` rely on the cookie (`withCredentials` isn't needed on the same origin), so `eventsUrl` and the raw image URLs drop `?token=`. The token no longer lives in `sessionStorage`, which is the main reason a PWA would lose it today (§3.4).
5. **"Open on your phone"** in the sidebar foot (only when `/api/info` says LAN mode): a small popover with the QR (server-rendered SVG from `/api/pair`), the LAN URL in mono, the expiry, and a one-line note on the certificate if HTTPS uses a private CA.
6. **The 401 screen** replaces today's banner ("Open the URL the manager printed"): "This device isn't paired. On the PC, open Centurion and choose Open on your phone, or run `centurion pair`." with a field to paste a pairing code or the token as a fallback.
7. **`centurion token --rotate`**: writes a new token into `state/token` (the running manager rereads it, or the command says to restart). This is the "I lost my phone" button.

The API keeps accepting `Authorization: Bearer` for `centurion api` and scripts. `?token=` can stay for compatibility, but the printed URLs no longer use it in LAN mode.

### 1.4 Security on a home LAN

What the token is worth: **everything**. With it, anyone can message any agent, and agents run Bash in `auto` mode in the user's repos, so the token amounts to code execution on the PC as the user. It also lets them read transcripts (which may hold secrets), answer permission prompts (an attacker could approve their own requests), use the user's git credentials through agents, and spend their Claude usage.

**Without the token**, someone on the Wi-Fi sees an open port, the static UI (no data in it) and 401s. The real risks are:

- **Sniffing over plain HTTP.** On WPA2-Personal, anyone who knows the Wi-Fi password and catches a device's handshake can decrypt that device's traffic; on any LAN, ARP spoofing puts a device in the middle. The token (in a header or cookie) and every transcript then go over the air readable. A guest, a compromised smart TV or a neighbour with the password are the realistic attackers. **HTTPS removes this** (§1.5). Plain HTTP stays possible, with a yellow line at startup: "Plain HTTP on the network: anyone on this Wi-Fi who can see the traffic can take over your agents. Set up HTTPS: `centurion help lan`."
- **CSRF**, which only becomes possible with cookies: any web page could make the phone's browser send a POST with the cookie attached. Defences, all cheap: `SameSite=Strict`; require `content-type: application/json` on every write (a cross-origin JSON request needs a CORS preflight, which the server never grants); and **check `Origin`** on every non-GET `/api/` request: if present, it must equal the request's own origin. Requests without `Origin` (curl, `centurion api`) need the header token, not the cookie.
- **DNS rebinding**: a site makes its own domain resolve to `192.168.1.20`, so its page talks to the server "same-origin". It still has no token: the cookie belongs to the IP's origin and isn't sent. With an empty token it would be a full takeover, hence the refusal above. Still add a **`Host` allowlist** for all requests: `localhost`, `127.0.0.1`, `[::1]`, the machine's interface addresses, `<hostname>` and `<hostname>.local`, plus a configurable `allowedHosts` for a name in front of it. Anything else gets 421. This also protects loopback-only setups, where a rebinding page can reach `127.0.0.1` today.
- **Chrome's Private Network Access** already makes public sites preflight before they can reach private IPs; nice to have, but not something to rely on.
- **Brute force**: the token has 192 bits, so guessing is not a concern; pairing codes are 128-bit, single use and short-lived. No rate limiting needed.
- **Raw file responses** keep their sandboxing CSP. The new `/pair` page and the 401 page are static and carry no token.

### 1.5 HTTPS

A **secure context** is required for: service workers (so PWA install on Android, and all notifications on Android, which only work through `ServiceWorkerRegistration.showNotification`), the Notifications API in general, Web Push, `navigator.clipboard` (Copy folder path and the code blocks' copy button), and the microphone for dictation. `http://localhost`, `http://127.0.0.1` and `http://*.localhost` count as secure; **`http://192.168.x.x` does not**, in any browser. So on the phone over plain HTTP the chat works, but there is no install, no notifications and no clipboard API.

Options:

| Option | How | Phone trust | Verdict |
| --- | --- | --- | --- |
| **mkcert** (local CA) | `mkcert -install` on the PC, then `mkcert 192.168.1.20 <pc>.local localhost 127.0.0.1`; config `tls: { cert, key }` | Copy `rootCA.pem` (`mkcert -CAROOT`) to the phone. Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate (Chrome trusts user CAs). iOS: open the file, install the profile, then General → About → Certificate Trust Settings → enable full trust. | **Recommended.** One-time setup per phone, no internet, real green lock. A new IP needs a new cert. |
| Self-signed cert generated by Centurion | `centurion init --tls` makes a cert (needs a library such as `selfsigned` or `@peculiar/x509`; Node can't write X.509 itself) | Accept a warning on every visit, or install it as a CA like above | A certificate the user clicks through doesn't give a secure context in Chrome for service workers, so this is only mkcert with more code. Not worth it. |
| Tailscale certs | `tailscale cert <pc>.<tailnet>.ts.net` gives a publicly trusted cert; traffic stays direct on the LAN | Nothing to trust, but the Tailscale app must run on the phone | Good if the user ever uses Tailscale; it's tunnel-like, which they ruled out. Works with the same `tls` field. |
| Own domain + Let's Encrypt DNS-01 | A DNS name pointing at the private IP | Nothing to trust | Many routers drop DNS answers with private IPs (rebinding protection). Too fiddly. |
| **PWA only on localhost** | No HTTPS at all | n/a | Works today for the PC (install from `http://127.0.0.1:4317`); the phone then gets a plain browser tab without notifications. The fallback if the user skips the CA setup. |

Server side, HTTPS is small: a config field `tls: { cert: string, key: string } | null` (paths relative to the config file, read at startup, a clear error when missing), `https.createServer` instead of `http.createServer`, the printed URLs and the cookie's `Secure` follow it. One port, no HTTP-to-HTTPS redirect (keep it simple; `http://localhost` keeps working only if the user doesn't enable `tls`, since one port speaks one protocol). With `tls` set, the PC also uses `https://localhost:4317`, which mkcert's cert covers.

For development, Chrome on Android has `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (enter `http://192.168.1.20:4317`), which makes plain HTTP count as secure on that phone. Worth one line in the docs for testing; not for daily use, and iOS has nothing like it.

### 1.6 Windows firewall

- The first time `node.exe` listens on `0.0.0.0`, Windows Defender Firewall shows "Windows Defender Firewall has blocked some features of Node.js". **Allow on Private networks** is enough; Public isn't needed.
- The rule is per program path. A different Node (nvm, an upgrade, `npx` from another install) asks again.
- If the Wi-Fi is set to **Public**, the phone can't connect even after allowing Private. The fix is Settings → Network → Wi-Fi → the network → Private.
- Clicking **Cancel** silently creates a *block* rule for node.exe. It must be removed in `wf.msc` (Inbound Rules → Node.js) or the phone never connects.
- A port rule instead of a program rule, which survives Node upgrades:
  `New-NetFirewallRule -DisplayName "Centurion" -Direction Inbound -Protocol TCP -LocalPort 4317 -Profile Private -Action Allow` (admin PowerShell).
- In LAN mode, startup prints one dim line: "Windows may ask to allow Node.js through the firewall: allow it on Private networks. Phone can't connect? `centurion help lan`." The help covers the points above.

## 2. Phone layout

The UI already has a narrow mode (`App.tsx`: `(max-width: 899px)`, a drawer for the sidebar with a scrim, the pane switch for splits; `.narrow` rules in `styles.css` that trim the header, composer and transcript; `(hover: none)` rules for message tools, queue buttons, visual toggles and row actions). This part finishes it for a touch phone.

**Phone mode** = `(max-width: 899px) and (pointer: coarse)`: a small window on the PC keeps the Files panel, a phone doesn't. A `usePhone()` hook next to `useMedia` in `hooks.ts`, and a `.phone` class on `.app` beside `.narrow`.

### 2.1 Navigation (`App.tsx`, `layout.ts`)

- Keep the drawer model: with no agent open the sidebar fills the screen; picking a row closes it; the header's menu button opens it.
- **The back button / gesture** must go back to the agent list, not leave the app (in the installed PWA, "back" otherwise closes it). On phone, opening an agent from the drawer does `history.pushState` (`#agent=…` is already written with `replaceState`); `popstate` opens the drawer. Going to the parent with the breadcrumb pushes too, so back walks expert → chat → list.
- An edge swipe to open the drawer is nice but not needed in this round; the menu button is there.
- **Splits**: the phone shows one pane (already the case below 900 px); hide the pane switch on phone and show only the focused pane. The layout is per browser, so the phone's layout doesn't touch the PC's.
- **Drag and drop**: sidebar rows are `draggable`, and Chrome on Android starts a drag on long press, which fights the long-press menu. Set `draggable` only when not on a coarse pointer.
- **Viewport**: `html, body, #root { height: 100% }` with `body { overflow: hidden }` is fine for desktop. On phones use `height: 100dvh` so the URL bar doesn't hide the composer, and change the viewport meta to `width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content`. Chrome on Android then shrinks the layout when the keyboard opens; iOS Safari doesn't, so a small `visualViewport` listener sets `--keyboard` (the covered height) and `.composer-dock` pads by it.
- **Safe areas** (with `viewport-fit=cover`): `.agent-header` and `.sidebar` get `padding-top: env(safe-area-inset-top)` (needed in standalone mode, where the page runs under the status bar), `.composer-dock` and the sidebar foot get `env(safe-area-inset-bottom)` (home indicator), left and right insets on the app in landscape.

### 2.2 Sidebar (`Sidebar.tsx`)

- Rows are `min-height: 44px` already. The expander chevrons (`.expander`) and the header's `+` / search buttons (`.icon-button`, 28 px) get a 40 px hit area on coarse pointers (padding or `::before`, same look).
- **Row menu**: on `(hover: none)` the archive row action is hidden and "the row menu (long press) archives there". Long press fires `contextmenu` in Chrome on Android but **not in Safari on iOS**. Add a long-press handler (pointer events, 500 ms, cancelled by movement over 8 px or a scroll) that opens the same menu, and `-webkit-touch-callout: none` on rows so iOS doesn't show its own callout. The menu's items (Open in split hidden on phone, Archive, New expert) need 44 px rows.
- **Search** opens the switcher (`Switcher.tsx`): on phone it becomes a full-width sheet at the top, the input gets the focus (the keyboard opens), and the Shift+Enter hint for splitting is hidden.
- **New chat / New expert forms**: typing absolute paths on a phone is painful, but the recent-folders list (`recentChatFolders`, `recentFolders`) already covers most cases. Keep the forms; make the recent folder rows 44 px.
- **Foot**: total spend stays; "Open on your phone" (§1.3) is hidden on the phone itself (`phone` mode).

### 2.3 Header (`Header.tsx`, `ModelPicker.tsx`, `CacheTag.tsx`)

- Already trimmed on narrow: no cost, no crumb name for the parent, the model chip shows only the model name, the folder chip only its icon.
- Phone: **hide the folder chip** (it opens Files) and **"Open folder in VS Code"** in the menu (a `vscode://` link on a phone does nothing). Keep "Copy folder path", with an `execCommand('copy')` fallback, since `navigator.clipboard` is missing on plain HTTP.
- The menu closes on `mousedown` outside; touch emulates it, but use `pointerdown` so a scroll that starts outside also closes it predictably. Menu items get 44 px.
- `ContextRing` and the cost only have `title` tooltips. On phone, put the context line ("Context after the last turn: 41 % of 200k tokens") into the menu instead, as a non-button row.
- The model popover is already `position: fixed` across the width on narrow; check that the effort segments are at least 40 px tall. The cache tag's keep-warm popover gets the same fixed placement on narrow.
- With `viewport-fit=cover` the header gets the top inset (§2.1).

### 2.4 Composer (`Composer.tsx`)

- **Enter**: today Enter sends, Shift+Enter adds a line (the builder is adding list continuation on top). A touch keyboard has no Shift+Enter, so on phone **Enter adds a line and the send button sends**, as in mobile chat apps. Use `enterKeyHint="enter"` there. A phone with a hardware keyboard would also get Enter = newline; acceptable. The hint line follows: "Send queues it for after this turn" instead of "Enter queues…".
- **iOS zoom on focus**: Safari zooms into any input under 16 px. The textarea is 15 px, the sidebar search, forms and question text fields are 13.5 px. On coarse pointers set `font-size: 16px` for `textarea, input` (and the textarea's line-height to match). Don't use `maximum-scale=1` (it blocks pinch zoom for everyone).
- **`/` and `@` menus**: items pick on `onMouseDown` with `preventDefault` to keep focus, which also holds for the emulated mouse events after a tap, so the keyboard stays open. Check it on a real phone; if a tap ever blurs the box, switch to `onPointerDown`. Items get 44 px rows on phone, and the menu's max height becomes `min(40vh, var(--available))` so it fits between the header and the keyboard. Arrow, Tab and Esc handling stays (hardware keyboards).
- **Prompt history** (Up / Down) needs arrow keys: no change, it just doesn't come up on a touch keyboard.
- **Images**: the attach button's `<input type="file" accept="image/*">` already offers the camera and the gallery on phones. Paste and drop don't matter there.
- **Dictation**: hide the mic on phone; the keyboard has its own, and the Web Speech API needs a secure context and fails on plain HTTP.
- **Interrupt**: Esc isn't available, but the stop button is already in the foot while running. Make the round buttons 40 px on phone (32 px today).
- **Queue** (`.queue-item`): remove buttons are already visible on `(hover: none)`; give them a 40 px hit area. The "notifications paused" bar and its Resume button stay.
- The composer dock pads for the keyboard and the bottom inset (§2.1).

### 2.5 Transcript and decisions (`Transcript.tsx`, `Plan.tsx`, `Questions.tsx`, `Delegation.tsx`, `Visual.tsx`, `Mermaid.tsx`)

- Fork and rewind buttons are already always visible on touch; make them 36 px on phone and keep the rewind confirm strip.
- **Permission requests** (`PermissionView`): Allow, Deny (with a note) and Allow for this session must be 44 px buttons in a wrapping row, and the request must not move the focus into a text field by itself (that pops the keyboard). These are the most important actions on a phone.
- **Plans and question sets**: `.narrow .questions-keys` and the later-round notes are already hidden. Check that options, checkboxes and Start / Send are 44 px tall, and that a free-text answer field doesn't jump under the keyboard (scroll it into view on focus).
- **File links** (`fileLinks`, `.file-link`, visual `file:` links, `Code` excerpt headers) open the Files panel. On phone they render as plain mono text (path and line) with a long-press copy, not as links to nowhere.
- **Code blocks** scroll sideways already; the copy button needs the clipboard fallback. Mermaid diagrams scroll and can be pinched (the page allows zoom).
- `Ctrl+O` (all work logs open) has no touch way in; add "Show all steps" to the header menu on phone. Esc and Alt+← have the stop button and the breadcrumb.
- The jump-to-latest button needs the bottom inset when the composer is short.

### 2.6 What to hide on phone

- **Files, git and diffs**: `FilesPanel`, `DiffView`, `Changes`, `Log`, `BranchPopover`, `ConflictViewer`, `ThreePaneResolver`. Don't render the folder chip, ignore Ctrl+B, and don't open the panel on `fileLinks`. The `git` SSE event is ignored without a panel, so nothing else changes.
- **Splits**: the pane switch, "Open in split", drag to split, the divider.
- **Desktop-only actions**: Open folder in VS Code, dictation, the sidebar resizer (already only wide), keyboard hints (`live-hint` is already hidden on narrow; the Questions key hints too).
- **"Open on your phone"** on the phone itself.
- Kept: everything in the sidebar (chats, experts, states, unread, archive, new chat / expert, search), and in the agent view the header (model, effort, cache tag and keep-warm, menu: pause notifications, archive, stop), the transcript with all its blocks, permissions, plans, question sets, the queue and the composer.

### 2.7 SSE on mobile (`store.ts`, `server.ts`)

- When the phone locks or the app goes to the background, iOS suspends the page within seconds and Android freezes it within minutes; the SSE connection dies. On return the `EventSource` may sit in its own retry backoff, or think it is still open on a dead socket after a Wi-Fi change.
- **Server**: send the 25 s keep-alive as a named event (`event: ping\ndata: {}\n\n`) instead of a comment, since comments never reach the page. Older UIs ignore unknown events. Add `ping` to `SSE_EVENTS`.
- **Store**: remember the time of the last event (pings included). On `visibilitychange` to visible, `pageshow` (back-forward cache) and `online`: if the source isn't `OPEN` or nothing arrived for 40 s, close it and connect at once instead of waiting for the 2 s retry or the browser's backoff. The snapshot then bumps `epoch` and the open transcript reloads its history, which already handles everything missed (no event replay needed).
- **Banner**: "Connection lost. Reconnecting…" would flash on every unlock. Show it only after 3 s without a connection while visible.
- Don't close the stream deliberately when hidden: the OS does it anyway, and on the PC a hidden tab must keep receiving events for notifications.
- Unread stays right: `useWindowActive` already treats a hidden page as not looking, so replies that arrive while the phone is locked stay unread.
- A history reload per unlock costs a few hundred KB on a long transcript. On Wi-Fi that's fine; no work planned.

## 3. PWA

### 3.1 Manifest and icons

`ui/public/manifest.webmanifest` (copied to `dist/ui` by Vite), linked from `index.html`:

```json
{
  "id": "/",
  "name": "Centurion",
  "short_name": "Centurion",
  "description": "Chats and experts for Claude Code",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#fbfaf8",
  "theme_color": "#fbfaf8",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- **Theme colours for light and dark**: a manifest has one `theme_color`, so `index.html` adds `<meta name="theme-color" content="#fbfaf8" media="(prefers-color-scheme: light)">` and `… content="#131211" media="(prefers-color-scheme: dark)">` (`--canvas` in both themes). Chrome, Edge and Safari use these for the title bar and status bar and follow the system theme. Also `<meta name="apple-mobile-web-app-status-bar-style" content="default">`, and `apple-mobile-web-app-title`.
- **Icons**: the favicon's logo (white glyph on the `#0e8a83` accent, rounded square). `icon-192.png` and `icon-512.png` as is; the **maskable** one fills the square with the accent and keeps the glyph inside the central 80 % (Android crops it to a circle or squircle). `apple-touch-icon.png` (180 px, full bleed, iOS rounds it itself) linked from `index.html`. PNGs are generated once from the SVG (a small script with `sharp` as a dev dependency, or exported by hand) and checked in under `ui/public/`. The icon stays one colour family with the favicon.
- **The state dot**: an installed app's icon is static (no dot from the manifest). Its equivalent is the **Badging API**: in `tabStatus.ts`, `navigator.setAppBadge(needs)` when the count is above 0, `clearAppBadge()` otherwise (feature-checked). Windows shows the count on the taskbar icon for apps installed from Edge or Chrome, Android shows a dot on the launcher icon, iOS 16.4+ a count for home screen apps that have notification permission. The favicon dot keeps working in tabs, and the standalone window's title still gets the `(n)` count. The running state (blue dot) has no badge equivalent; leave it out.
- **Server**: `CONTENT_TYPES` gets `.webmanifest` → `application/manifest+json` and `.js` already exists for `sw.js`. `serveUi` gives `sw.js` and the manifest `cache-control: no-cache` (they're outside `assets/`, so they already do). These paths are served without a token, like all UI files.

### 3.2 Service worker

`ui/public/sw.js`, registered from `main.tsx` with scope `/` (only in a secure context, and not under the Vite dev server):

- `install`: `skipWaiting()`. `activate`: `clients.claim()` and delete any Cache Storage left over.
- **No `fetch` handler at all.** Chrome and Edge no longer require one for installation (since Chrome 108 on Android and 112 on desktop), and without it every request, `/api`, the SSE stream, the cookie and the token included, goes straight to the network as if there were no worker. That is the simplest guarantee that nothing is ever cached. No offline mode.
- `notificationclick`: close the notification, find a window client (`clients.matchAll({ type: 'window', includeUncontrolled: true })`), `focus()` it and `postMessage({ open: agentId })`; with no window, `clients.openWindow('/#agent=<id>')`. The page listens and calls `layout.open`.
- Later `push` (§3.5).
- A comment at the top says why there is no fetch handler, so nobody adds caching.

### 3.3 Notifications in the PWA and on the phone

The builder is putting desktop notifications in one module (`ui/src/desktopNotify.ts` was asked for): per browser toggles, permission asked on the first toggle, only while the window is hidden or unfocused. How that carries over:

- **Use the service worker when there is one.** `new Notification()` throws on Android Chrome ("use ServiceWorkerRegistration.showNotification"), and the click has to reach a window that may be closed. So the module calls `(await navigator.serviceWorker.getRegistration())?.showNotification(title, { body, tag, data: { agentId } })` when a registration exists and falls back to `new Notification` otherwise (plain HTTP on the PC's loopback without a worker, which can't happen once the PWA part lands, but costs nothing). `tag` = the event's key, so a repeat replaces instead of stacking. The click goes through `notificationclick` (§3.2).
- **Installed on the PC** (Edge or Chrome on Windows): works like the tab. "Hidden or unfocused" = the app window is minimized, behind another window or on another desktop. Notifications show with the app's name and icon and open the app window. The badge (§3.1) shows the count on the taskbar. While the app window is closed, nothing notifies (no page runs); that is the same as closing the tab.
- **On the phone, in the foreground**: the page is visible, so by the rule it doesn't notify; the transcript and the drawer's states show it.
- **On the phone, in the background or locked**: the page is suspended and its SSE stream is gone, so **local notifications can't fire**. Only Web Push (§3.5) can wake the phone. Without it, the phone shows what happened when the user opens the app, and the PC keeps notifying.
- **Plain HTTP on the phone**: no secure context, so no notifications at all; the toggles should say "Notifications need HTTPS on this device" instead of asking for a permission that will fail.
- **iOS**: notifications exist only in a home-screen web app (iOS 16.4+) and only with HTTPS; treat them as Web Push only.
- Toggles stay per browser (each device decides for itself), which matches the builder's brief. If Web Push comes, the device's subscription carries its toggles to the server.

### 3.4 How the token survives install

- `start_url` is `/` and can't carry a token. Today the token is in `sessionStorage`, which a new app window doesn't have, so every launch would show the 401 screen.
- **The cookie from §1.3 solves it** on Windows and Android: an installed app shares the browser profile's cookie jar for its origin. Pair once in the browser, install, and the app is signed in. Installing from the browser after pairing is the documented order.
- **iOS** keeps home screen apps' storage separate from Safari (cookies included; whether iOS copies cookies at install time has changed between versions, so don't rely on it). The 401 screen's "paste a pairing code" field covers it: open the app, enter the short code shown in "Open on your phone", done. Make pairing codes easy to type: a short code (e.g. 8 characters from a 32-letter alphabet, 40 bits, single use, 10 minutes, at most 5 wrong tries per code) next to the QR, which carries the long one.
- `localStorage` as the store would also survive install on Windows and Android, but it keeps the token readable by any script on the origin and still needs the `?token=` for `EventSource`. The HttpOnly cookie is better on both counts.

### 3.5 Web Push (part D, optional, later)

Only this makes the phone notify while it's locked. It's a separate decision because messages leave the LAN.

- The server generates VAPID keys into the state folder and stores push subscriptions per device (with that device's toggles) in the state file. `web-push` (npm) sends to the browser's push service (Google FCM for Chrome on Android, Apple's for iOS, Microsoft's for Edge). Outbound only, no tunnel, and the payload is end-to-end encrypted, but Google or Apple see that a message went to the device and when.
- The payload is minimal by default ("A chat finished" / "Something needs you" plus the agent's id); the agent name can be an option.
- The service worker's `push` handler shows the notification, unless one of its windows is visible and focused (keeping "only while hidden").
- Routes: `GET /api/push/key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`. Needs HTTPS on the phone. On iOS only for home screen apps.

### 3.6 Installing

- **Windows, Edge**: open `https://localhost:4317` (or `http://127.0.0.1:4317` without TLS), then the "App available" icon in the address bar, or ⋯ → Apps → Install Centurion. It appears in the Start menu and can be pinned to the taskbar. **Chrome**: the install icon in the address bar, or ⋮ → Cast, save and share → Install page as app. Both open it in its own window; links to other sites open in the browser.
- **Android, Chrome**: over HTTPS, ⋮ → Add to home screen → Install (or the install banner). Over plain HTTP Chrome only makes a shortcut that opens a normal tab (no standalone, no worker).
- **iOS, Safari**: Share → Add to Home Screen; with `display: standalone` it opens full screen. It has its own storage, so pair once inside the app (§3.4). Over plain HTTP the home screen app still opens standalone, but without a worker or notifications.
- `centurion help lan` (rendered with the other docs, so `check:docs` covers it) lists these steps, the certificate steps and the firewall notes; the README gets one line pointing to it.

## 4. Implementation steps

Each step gets its own commit. Run `npm run typecheck` and `npm run check:docs` before each.

**Part A: LAN access**

1. `Host` allowlist (`allowedHosts` config field), `Origin` check on writes, JSON content type required on writes. Refuse a non-loopback host with an empty token. Works on loopback too.
2. Cookie auth: `authorized` accepts the cookie; `POST /api/session` sets it from a bearer token; the UI moves from `sessionStorage` to the cookie and drops `?token=` from `eventsUrl` and raw image URLs. The 401 screen with a paste field.
3. Pairing: `POST /api/pair` (codes in memory, QR SVG from `qrcode`), `GET /pair?code=…`, the long and the short code, `centurion pair`, `centurion token --rotate`. "Open on your phone" in the sidebar foot (LAN mode only; `/api/info` gains `lan` and `lanUrls`).
4. `--lan`, the startup output (interface list, terminal QR, plain HTTP and firewall lines), `host` description.
5. HTTPS: `tls` config field, `https.createServer`, `Secure` cookie, printed URLs; `centurion help lan` with mkcert, phone CA install and firewall steps; README line.

**Part B: phone layout** (UI only; can go before or after A, it works over plain HTTP)

6. `usePhone()`, the `.phone` class, viewport meta (`viewport-fit`, `interactive-widget`), `100dvh`, safe-area insets, the `--keyboard` variable.
7. Navigation: `pushState` / `popstate` for back, no drag on coarse pointers, no pane switch or split on phone.
8. Hide Files, git, VS Code, dictation and split actions on phone; file links as text; clipboard fallback.
9. Touch: 16 px inputs, 40–44 px hit areas (icon buttons, menu rows, sidebar rows' controls, round buttons, permission and decision buttons), long press for the row menu on iOS, Enter = newline with `enterKeyHint`, the slash / mention menus' height, context and "Show all steps" in the header menu.
10. SSE: `ping` events, the reconnect on visible / pageshow / online, the delayed banner.
11. Update `docs/ui-design.md` (phone mode rules) and CLAUDE.md.

**Part C: PWA**

12. Manifest, icons (SVG, 192, 512, maskable, apple-touch), theme-color metas, `.webmanifest` content type.
13. `sw.js` without a fetch handler, registration in `main.tsx`, `notificationclick` → open the agent; the builder's notification module switches to `showNotification` when a registration exists.
14. Badging API in `tabStatus.ts`.

**Part D: Web Push** (after a yes from the user, §3.5).

## 5. Test plan

Against a test manager with its own config, port and state file (CLAUDE.md), env stripped.

- **A, with curl** (from the PC and from another device or WSL to hit the LAN address):
  - `Host: evil.example` → 421; `Host: 192.168.x.x:port` → allowed.
  - POST with the cookie and `Origin: http://evil.example` → 403; without `Origin` and without a header token → 401; `content-type: text/plain` write → 415.
  - `CENTURION_TOKEN= centurion start --lan` refuses to start.
  - Pairing: a code works once, a second use and an expired code fail, the cookie is `HttpOnly; SameSite=Strict` (and `Secure` with TLS), the redirect lands on `/` without the code.
  - `token --rotate` signs the browser out (401 screen).
  - TLS: with an mkcert cert, `https://localhost:port` and `https://<lan ip>:port` show a valid certificate in the PC's browser.
  - The startup output lists the right interfaces and the QR scans.
- **B, in the browser pane** with device emulation (e.g. 390 × 844 with touch, so `pointer: coarse` matches), light and dark, plus a 600 px desktop window to confirm narrow-but-not-phone keeps Files:
  - drawer and back (history), no split UI, no Files or VS Code;
  - composer Enter adds a line, Send sends, the `/` and `@` menus pick by tap;
  - a permission request, a question set and a plan can be answered by tap;
  - the queue can be edited, model and effort switched, keep-warm opened;
  - safe areas with an emulated notch;
  - SSE: switch the tab away and back, take the server down and up; the banner appears only after 3 s and the transcript catches up.
- **C**:
  - DevTools Application tab on `http://127.0.0.1:<port>`: the manifest has no errors and the app is installable.
  - The worker is active with **no fetch handler**; Cache Storage is empty after using the app; the Network panel shows `/api` requests served by the network, not the worker.
  - Install in Edge: own window, theme colour follows light / dark.
  - A notification while minimized opens the right agent when clicked; the taskbar badge shows the needs-you count.
- **Real phone (the user)**:
  - Android Chrome and, if available, iPhone Safari over HTTPS with the mkcert CA: pair by QR, install, reopen after a restart (still signed in);
  - send, answer a permission, lock for five minutes, unlock (reconnects, catches up);
  - keyboard doesn't cover the composer, no zoom on focus;
  - the firewall prompt and a Private network.
  - The same over plain HTTP: the chat works, the install and notification toggles say HTTPS is needed.
