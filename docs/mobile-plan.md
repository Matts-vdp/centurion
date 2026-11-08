# Phone over LAN and PWA: plan

The phone is on the same Wi-Fi and opens the PC's local IP (no tunnel). On the phone the user needs the sidebar and the chat: send messages, follow up on permissions, question sets, plans, the queue, model and effort. The Files panel, git and the diff viewer stay on the PC. Centurion also gets a basic PWA, so it can be installed as an app window instead of a tab.

Two phases:

- **Phase 1: LAN access and a PWA, plain HTTP only.** The phone uses the browser over `http://<pc-ip>:4317`. The installable PWA is mainly for the PC, where `localhost` counts as a secure context.
- **Phase 2: the phone layout and a better PWA on the phone.** This phase also covers HTTPS, a better sign-in and touch input. Its main choices are open questions (§2.1), not decisions.

**Rejected: Web Push.** It is the only way a locked phone could show a notification, but it sends messages through Google's, Apple's or Microsoft's push services. Instead, the phone catches up when it's opened.

"Phone" means a narrow window with a coarse pointer: `(max-width: 899px) and (pointer: coarse)`. A narrow desktop window keeps the Files panel.

## Phase 1: LAN access and PWA over plain HTTP

### 1.1 Today

- `host` defaults to `127.0.0.1` (`src/config.ts`) and can be overridden by `CENTURION_HOST`. `0.0.0.0` already works, but the startup line then prints `http://localhost:…/?token=…`, which is useless on a phone.
- Auth (`authorized` in `src/server.ts`): every `/api/` call needs `Authorization: Bearer <token>` or `?token=`, compared with `timingSafeEqual`. UI files (`serveUi`) are served without a token. `CENTURION_TOKEN=''` turns the check off.
- The UI reads `?token=` once, keeps it in **`sessionStorage`** and removes it from the URL (`ui/src/api.ts`). It puts the token back into URLs for the `EventSource` (`eventsUrl`) and for raw file images (`fileStore.ts`).
- There is no `Host` or `Origin` check and there are no CORS headers. Other origins can therefore send blind requests, but they can't read the answers, and they can't authenticate without the token.

### 1.2 Opting in and the startup output

- **`centurion start --lan`** listens on `0.0.0.0` for one run. For a permanent setup, put `host: "0.0.0.0"` (or one interface's address) in the config. LAN mode means the host is not a loopback address. `host` stays the only field; the flag just sets it. The field's description, which today only mentions docker, gets updated.
- In LAN mode, startup lists every non-internal IPv4 address from `os.networkInterfaces()`. It skips `169.254.*`, labels virtual adapters (`vEthernet (WSL)`, Hyper-V, VirtualBox) and prints them last. It also prints a terminal QR code of the first Wi-Fi or Ethernet URL with the token, using the `qrcode` package (`toString(url, { type: 'terminal', small: true })`):

  ```
  Centurion listening on http://localhost:4317/?token=…
  On your network:  http://192.168.1.20:4317/?token=…   (Wi-Fi)
  <QR code>
  Warning: plain HTTP on your network. Anyone on this Wi-Fi who can see the traffic
  can read the token and take over your agents, which run commands on this PC.
  Windows may ask to allow Node.js through the firewall: allow it on Private networks.
  ```

- The warning is printed in yellow every time the server listens beyond loopback. It is not a prompt and it doesn't block startup.
- **LAN mode refuses to start with an empty token** (`CENTURION_TOKEN=''`): it prints the reason and exits. On loopback an empty token stays allowed.
- The PC's IP must stay the same, or the phone's bookmark breaks. The docs suggest a DHCP reservation on the router.

### 1.3 Sign-in: the token in the URL

Phase 1 keeps today's way: the URL carries `?token=`, and the phone opens it by scanning the terminal QR code. One change: **the UI keeps the token in `localStorage` instead of `sessionStorage`**.

- With `sessionStorage`, every new tab and every launch of an installed app starts without the token. The PWA's `start_url` is `/` and can't carry it.
- With `localStorage`, an app installed from Edge or Chrome on the PC shares the token with the browser profile for that origin. A phone tab reopened from the history or a bookmark keeps working too.
- The trade-off: the token stays on the device until the browser's data is cleared, and any script on the origin can read it. The UI is the only thing served there, and raw files are sandboxed by their CSP.
- When the server refuses the stored token (it was rotated, or a different manager runs on that port), the UI drops it and shows today's banner: "Open the URL the manager printed".

### 1.4 Security on a home LAN

**What the token is worth: everything.** With it, anyone can message any agent. Agents run Bash in `auto` mode in the user's repos, so the token amounts to code execution on the PC as the user. It also lets them:

- read transcripts, which may hold secrets
- answer permission prompts, including approving their own requests
- use the user's git credentials through the agents
- spend the user's Claude usage

**Without the token**, someone on the Wi-Fi sees an open port, the static UI (it holds no data) and 401s.

**The phase 1 risk is sniffing.** Over plain HTTP, the token and every transcript cross the network readable:

- On WPA2-Personal, anyone who knows the Wi-Fi password and catches a device's handshake can decrypt that device's traffic.
- On any LAN, ARP spoofing puts a device in the middle.
- The realistic attackers are a guest, a compromised smart TV, or a neighbour with the password.

That's why there is a startup warning, and why HTTPS is the first open question of phase 2. Until then, the advice is to use `--lan` only on a trusted home network and to rotate the token (delete `state/token` and restart) if in doubt.

**Cheap hardening, kept in phase 1** (it also protects loopback-only setups):

- **`Host` allowlist** against DNS rebinding, where a website makes its own domain resolve to the PC and talks to it "same-origin". The allowed names are `localhost`, `127.0.0.1`, `[::1]`, the machine's interface addresses, `<hostname>` and `<hostname>.local`, plus a configurable `allowedHosts`. Anything else gets 421. Rebinding gets nowhere without the token, but an empty token on loopback would otherwise be wide open.
- **`Origin` check** on every non-GET `/api/` request: if the header is present, it must match the request's own origin, otherwise 403. Phase 1 has no cookies, so there is no CSRF to stop yet. The check is one comparison, and it's in place before phase 2 brings cookies.
- **Refusing an empty token in LAN mode** (§1.2).
- No rate limiting is needed: the token has 192 bits.

### 1.5 Windows firewall

- The first time `node.exe` listens on `0.0.0.0`, Windows Defender Firewall shows "Windows Defender Firewall has blocked some features of Node.js". Choosing **Allow on Private networks** is enough.
- The rule belongs to one program path. A different Node (nvm, an upgrade, `npx` from another install) asks again.
- If the Wi-Fi profile is **Public**, the phone can't connect even after allowing Private. Fix it in Settings → Network → Wi-Fi → the network → Private.
- Clicking **Cancel** silently creates a *block* rule for node.exe. The phone never connects until that rule is removed in `wf.msc` (Inbound Rules → Node.js).
- A port rule survives Node upgrades: `New-NetFirewallRule -DisplayName "Centurion" -Direction Inbound -Protocol TCP -LocalPort 4317 -Profile Private -Action Allow` (in an admin PowerShell).
- `centurion help lan` lists these points, and the startup output points to it.

### 1.6 What works on the phone over HTTP, and what doesn't

`http://192.168.x.x` is **not a secure context** in any browser. `http://localhost` and `http://127.0.0.1` are, which is why the PWA works on the PC.

| On the phone, over plain HTTP | Works? |
| --- | --- |
| Sidebar (chats, experts, states, unread, archive, new chat or expert, search) | Yes, in today's narrow layout: the sidebar becomes a drawer below 900 px |
| Chat: send, queue, interrupt, permissions, question sets, plans, model and effort, keep-warm | Yes |
| Attaching images | Yes (the file picker offers the camera and the gallery) |
| Live updates (SSE) | Yes while the page is open. A locked or backgrounded phone drops the connection, and the store's retry reconnects when the page runs again (a faster reconnect is in phase 2) |
| Installing as an app | **No**: no service worker. Android only makes a shortcut that opens a tab. On iOS the home screen app has its own storage without the token |
| Notifications and the app badge | **No**: they need a secure context. Desktop alerts stay a PC feature |
| Copy buttons (`navigator.clipboard`) | **No**, unless a fallback is added. Phase 1 adds a small `execCommand('copy')` fallback, used only when `navigator.clipboard` is missing |
| Dictation (microphone) | **No**: it needs a secure context. The phone keyboard's own mic works |
| Touch comfort | Rough: inputs under 16 px make iOS zoom on focus, Enter sends, iOS has no long-press row menu, and some hit areas are small. Phase 2 fixes these |
| Files, git, diffs | They show, but aren't meant for the phone. Phase 2 hides them |

### 1.7 The PWA (installable on the PC)

**Manifest.** `ui/public/manifest.webmanifest` is copied to `dist/ui` by Vite and linked from `index.html`:

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

**Theme colours for light and dark.** A manifest has only one `theme_color`, so `index.html` adds two `<meta name="theme-color">` tags, both using `--canvas`:

- `content="#fbfaf8" media="(prefers-color-scheme: light)"`
- `content="#131211" media="(prefers-color-scheme: dark)"`

Edge and Chrome use them for the app window's title bar and follow the system theme. Also add `apple-mobile-web-app-title` and an `apple-touch-icon` for phase 2.

**Icons.** They use the favicon's logo: a white glyph on the `#0e8a83` accent, in a rounded square.

- `icon-192.png` and `icon-512.png` show the logo as it is.
- The **maskable** icon fills the whole square with the accent and keeps the glyph inside the central 80 %.
- `apple-touch-icon.png` is 180 px and full bleed.
- The PNGs are generated once from the SVG and checked in under `ui/public/`. That's a small script with `sharp` as a dev dependency, or an export by hand.

**The state dot.** An installed app's icon is static. Its equivalent is the **Badging API**: in `tabStatus.ts`, call `navigator.setAppBadge(needs)` while the needs-you count is above 0 and `clearAppBadge()` otherwise (feature-checked). Windows shows the count on the taskbar icon of apps installed from Edge or Chrome. The favicon dot keeps working in tabs, and the app window's title still gets the `(n)` count. The blue running dot has no badge equivalent.

**Service worker.** `ui/public/sw.js` is registered from `main.tsx` with scope `/`, only when `isSecureContext` is true and not under the Vite dev server:

- `install` calls `skipWaiting()`. `activate` calls `clients.claim()` and deletes any Cache Storage left over.
- **There is no `fetch` handler at all.** Chrome and Edge no longer need one for installation (since Chrome 112 on desktop). Without it, every request goes straight to the network as if there were no worker: `/api`, the SSE stream and the `?token=` URLs included. That's the simplest guarantee that nothing is ever cached. A comment at the top of the file says so, so nobody adds caching later. There's no offline mode.
- `notificationclick` closes the notification and finds a window with `clients.matchAll({ type: 'window', includeUncontrolled: true })`. It focuses that window and posts `{ open: agentId }`, and the page calls `layout.open`. Without a window, it calls `clients.openWindow('/#agent=<id>')`.

**Desktop alerts in the installed app** (`ui/src/desktopNotify.ts`, `showAlert`):

- When a service worker registration exists, `showAlert` calls `registration.showNotification(title, { body, tag, icon: '/icon-192.png', data: { agentId } })`. Clicks then go through `notificationclick`. Otherwise it keeps today's `new Notification` with `onclick`.
- "Hidden or unfocused" (`windowAway`) means the app window is minimized, behind another window, or on another desktop. Notifications carry the app's name and icon and open the app window.
- When the app window is closed, no page runs, so nothing alerts. That's the same as closing the tab.

**Server.**

- `CONTENT_TYPES` gets `.webmanifest` → `application/manifest+json`.
- `sw.js` and the manifest live outside `assets/`, so they are already served with `no-cache`.
- They are UI files, served without a token like the rest.

**Installing on Windows.**

- **Edge**: open `http://127.0.0.1:4317/?token=…` (or `localhost`), then the "App available" icon in the address bar, or ⋯ → Apps → Install Centurion.
- **Chrome**: the install icon in the address bar, or ⋮ → Cast, save and share → Install page as app.

Both put Centurion in the Start menu, where it can be pinned to the taskbar, and open it in its own window. Install from the loopback URL, not the LAN IP: a PWA's identity is its origin, and only loopback is a secure context over HTTP.

### 1.8 Phase 1 steps

Commit each step on its own, and run `npm run typecheck` and `npm run check:docs` before each.

1. **Hardening**: the `Host` allowlist (`allowedHosts` config field), the `Origin` check on writes, and refusing an empty token in LAN mode.
2. **`--lan`** and the startup output: the interface list, the terminal QR code (`qrcode`), the plain HTTP warning and the firewall line. Update the `host` description, add `centurion help lan` (rendered with the other docs), and a README line.
3. **Token in `localStorage`**: drop a refused token. Add the clipboard fallback for copy buttons.
4. **PWA**: the manifest, icons, theme-color metas, the `.webmanifest` content type, `sw.js` without a fetch handler and its registration, `notificationclick`, `showAlert` through the registration, and the Badging API in `tabStatus.ts`.
5. Update CLAUDE.md (status, layout, the PWA's no-cache rule) and `docs/ui-design.md` if a pattern changes.

### 1.9 Phase 1 tests

Against a test manager with its own config, port and state file, env stripped (CLAUDE.md).

- **With curl**, from the PC and from another device or WSL against the LAN address:
  - `Host: evil.example` gives 421; `Host: <lan ip>:<port>` is allowed.
  - A POST with `Origin: http://evil.example` gives 403; one with no `Origin` and a bearer token works.
  - `CENTURION_TOKEN= centurion start --lan` refuses to start.
  - The startup output lists the right interfaces, and the QR code scans.
- **PWA, on `http://127.0.0.1:<port>`**:
  - In DevTools → Application, the manifest has no errors and the page is installable.
  - The worker is active with **no fetch handler**, and Cache Storage stays empty after using the app.
  - The Network panel shows `/api` requests served by the network.
  - Installed in Edge: the app gets its own window, the title bar follows light and dark, and the app opens signed in after a restart.
  - An alert while minimized opens the right agent when clicked, and the taskbar badge shows the needs-you count.
- **The user, on a real phone**: open the QR URL over Wi-Fi after the firewall prompt (Private network). Send a message, answer a permission and a question set, lock the phone for a few minutes and unlock it: the page reconnects and catches up. Reopening the bookmark keeps the sign-in.

## Phase 2: phone layout and the PWA on the phone

### 2.1 Open questions

1. **HTTPS on the LAN.** HTTPS is needed on the phone for the service worker (install), notifications, the clipboard and the microphone. It would also end the sniffing risk.
   - (a) **mkcert**: on the PC, run `mkcert -install` and then `mkcert <lan ip> <pc>.local localhost 127.0.0.1`, and add a config field `tls: { cert, key }` (`https.createServer`, one port). Trust the CA on the phone once:
     - Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate.
     - iOS: install the profile, then General → About → Certificate Trust Settings.
     - A new IP needs a new certificate.
   - (b) **Tailscale certs** (`tailscale cert`): publicly trusted and direct on the LAN, but the Tailscale app must run on the phone, which is tunnel-like.
   - (c) **Stay on plain HTTP**, with the PWA on the PC only.
   - A self-signed certificate that the browser clicks through is not an option: it doesn't give Chrome a secure context for service workers.
   - **Preference: (a).** For testing, Chrome on Android also has `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. **Sign-in.**
   - (a) **One-time pairing codes**, valid 10 minutes and single use. The QR code holds a long code, and a short typable code is shown next to it for iOS home screen apps, which have their own storage. Opening `/pair?code=…` sets an `HttpOnly; SameSite=Strict` cookie (plus `Secure` with HTTPS) that holds the token. `EventSource` and image URLs then lose `?token=`. An "Open on your phone" QR popover appears in the sidebar foot, and `centurion token --rotate` signs everything out.
   - (b) **The token in the URL**, as in phase 1.
   - (c) **Revocable tokens per device**: (a) plus a device table in the state file and a device list in the UI.
   - With cookies, the `Origin` check from phase 1 becomes the CSRF defence, together with JSON-only writes.
   - **Preference: (a)**, with (c) later if wanted. It keeps the long-lived token out of photos and the browser history.
3. **Enter on a touch keyboard.**
   - (a) Enter adds a line and the Send button sends, as in mobile chat apps (`enterKeyHint="enter"`; the hint line says "Send queues it…").
   - (b) Enter sends, as on the PC. A touch keyboard has no Shift+Enter for a new line, though.
   - **Preference: (a).** It also fits the composer's list continuation.

### 2.2 Phone layout

The UI already has a narrow mode (`App.tsx`, `(max-width: 899px)`):

- a drawer for the sidebar, with a scrim
- one pane at a time, with a pane switch
- `.narrow` rules that trim the header, composer and transcript
- `(hover: none)` rules for message tools, queue buttons, visual toggles and row actions

Phase 2 adds a `usePhone()` hook next to `useMedia` in `hooks.ts` and a `.phone` class on `.app`.

**Navigation and viewport** (`App.tsx`, `layout.ts`, `index.html`, `styles.css`):

- **Back** returns to the agent list instead of leaving the page or the app. Opening an agent from the drawer calls `history.pushState`, and `popstate` opens the drawer again. Today `#agent=` is written with `replaceState`. The breadcrumb pushes too, so back walks expert → chat → list.
- **No split UI** on the phone: no pane switch, no "Open in split", and rows aren't `draggable` on coarse pointers (Chrome on Android starts a drag on long press).
- **Viewport meta**: `viewport-fit=cover, interactive-widget=resizes-content`, and `100dvh` instead of `100%` on phones. Chrome on Android shrinks the layout for the keyboard. iOS Safari doesn't, so a `visualViewport` listener sets `--keyboard` and `.composer-dock` pads by it.
- **Safe-area insets**:
  - top: `.agent-header` and `.sidebar` (needed for a standalone app)
  - bottom: `.composer-dock` and the sidebar foot
  - left and right: in landscape

**Sidebar** (`Sidebar.tsx`, `Switcher.tsx`):

- Rows are already 44 px. Give the expanders and the header's `+` and search buttons 40 px hit areas, without changing their look.
- **Long press** opens the row menu: pointer events, 500 ms, cancelled by 8 px of movement. iOS doesn't fire `contextmenu`. Add `-webkit-touch-callout: none` on rows, and 44 px menu rows.
- The switcher becomes a full-width sheet with its split hint hidden. Recent-folder rows in the new chat and new expert forms are 44 px.

**Header** (`Header.tsx`, `ModelPicker.tsx`, `CacheTag.tsx`):

- Hide the folder chip (it opens Files) and "Open folder in VS Code".
- Menus close on `pointerdown` instead of `mousedown`, and menu rows are 44 px.
- The context ring and the cost only have tooltips, so put a context line into the menu, plus "Show all steps" (`Ctrl+O` has no touch equivalent).
- The model and keep-warm popovers use fixed, full-width placement. The effort segments get at least 40 px.

**Composer** (`Composer.tsx`):

- Enter follows question 3.
- `font-size: 16px` for `textarea, input` on coarse pointers, so iOS doesn't zoom on focus. Don't use `maximum-scale`.
- The `/` and `@` menus pick on `onMouseDown` with `preventDefault`, which keeps the keyboard open after a tap. Check this on a real phone, and switch to `onPointerDown` if a tap blurs the box. Their items are 44 px, and the menu height fits between the header and the keyboard.
- Hide the mic. Round buttons and the queue's remove buttons are 40 px.

**Transcript and decisions** (`Transcript.tsx`, `Plan.tsx`, `Questions.tsx`, `Visual.tsx`):

- `PermissionView` and the Start / Send buttons are 44 px, in wrapping rows.
- A request must not move the focus into a text field on its own, which would pop up the keyboard.
- Free-text answers scroll into view on focus.
- Fork and rewind buttons are 36 px.
- File links (`.file-link`, visual `file:` links, `Code` headers) render as plain mono text.

**Hidden on the phone**:

- `FilesPanel`, `DiffView`, `Changes`, `Log`, `BranchPopover`, `ConflictViewer`, `ThreePaneResolver`
- `Ctrl+B`, and `fileLinks` opening the panel
- splits
- VS Code, dictation, and keyboard hints

Everything in the sidebar and the agent view stays: the header with model, effort, keep-warm and the menu, the transcript, permissions, plans, question sets, the queue and the composer.

**SSE** (`store.ts`, `server.ts`):

- Send the 25 s keep-alive as a named `event: ping` instead of a comment, since comments never reach the page. Add it to `SSE_EVENTS`.
- On `visibilitychange` to visible, `pageshow` and `online`: if the source isn't open or nothing arrived for 40 s, reconnect at once. The snapshot bumps `epoch`, and the open transcript reloads its history.
- Show "Connection lost" only after 3 s without a connection while the page is visible.

### 2.3 The PWA on the phone (with HTTPS)

- **Android, Chrome**: ⋮ → Add to home screen → Install. The app shares the browser's cookies and storage for the origin, so pairing in the browser first carries over.
- **iOS, Safari**: Share → Add to Home Screen. The app has separate storage, so you pair once inside it, with the short code from question 2.
- The manifest, icons and `apple-touch-icon` come from phase 1.
- **Alerts in the foreground**: the page is visible, so by the alerts rule there are none.
- **Alerts in the background or while locked**: the page is suspended, so nothing can alert. Without Web Push (rejected), the phone shows what happened when it's opened. On Android, `showAlert` must go through `registration.showNotification`, since `new Notification` throws there; phase 1 already does that.
- The app badge works on Android (a dot) and on iOS 16.4+ (only with notification permission).

### 2.4 Phase 2 steps and tests

Once the open questions are answered:

1. HTTPS (question 1).
2. Sign-in (question 2).
3. `usePhone()`, the viewport, the safe areas and `--keyboard`.
4. Back navigation, and no split on the phone.
5. Hide Files, git, VS Code and dictation; file links as text.
6. Touch: 16 px inputs, hit areas, long press, Enter, menu heights, the header menu additions.
7. The SSE ping and the reconnect.
8. `docs/ui-design.md` (the phone mode rules) and CLAUDE.md.

**Tests in the browser pane** with device emulation (390 × 844 with touch, so `pointer: coarse` matches), in light and dark, plus a 600 px desktop window that must keep Files:

- the drawer and back
- no split or Files
- the composer's Enter and the `/` and `@` menus by tap
- permissions, question sets and plans by tap
- the queue, model and effort, and keep-warm
- an emulated notch
- SSE: switch the tab away and back, and restart the server

**The user, on a real phone** (Android Chrome and, if available, iPhone Safari, over HTTPS):

- pair, install, and reopen after a restart
- lock for five minutes and unlock
- the keyboard doesn't cover the composer
- no zoom on focus
