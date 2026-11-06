# Adding dev container support

Goal: run the manager and all its agents inside a dev container, and open the page in the host browser through a forwarded port. The code already runs on Linux. What's missing is container setup, auth and config.

## 1. Decide where the manager runs

The agents have to run where the repositories and their tooling are (language runtimes, MCP servers, build tools). In practice that means one of two options:

- **Inside the existing work dev container** that already has the repos. Add Node and this project to it. This is the simplest option and probably the right one.
- **In a dedicated container for the manager**, with the repos mounted into it. This only works if the experts don't need the repos' own tooling.

## 2. Container setup (`.devcontainer/devcontainer.json`)

- **Node 24**, e.g. the `mcr.microsoft.com/devcontainers/typescript-node:24` image or a Node feature.
- **A non-root user** (`remoteUser: "node"`). Claude Code refuses `bypassPermissions` when it runs as root.
- **`forwardPorts: [4317]`**, so the page opens in the host browser.
- **`node_modules` on a container volume.** The Agent SDK installs a platform-specific Claude binary, so a Linux install must not overwrite the Windows `node_modules` in a shared checkout (or the other way round).
- **`~/.claude` on a volume**, so the login and session transcripts survive rebuilds. Without them, sessions can't be resumed.
- **Mounts for every repo** the experts need. Agents can only use paths that exist inside the container (e.g. `/workspaces/...`).
- **`postCreateCommand`** that runs `npm ci` and copies a container config if none exists.

## 3. Auth inside the container

The container doesn't share the host's Claude login. Pick one of these:

- Run `claude setup-token` on the host and pass `CLAUDE_CODE_OAUTH_TOKEN` in through `remoteEnv` (`${localEnv:...}`).
- Pass the Foundry variables (`CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`, the key or Entra settings) the same way, or put them in the config's `env`.
- Run `claude` → `/login` once inside the container. This works because `~/.claude` is on a volume.

Check that no stray `ANTHROPIC_API_KEY` is set. If one is, it takes precedence and gets billed.

## 4. A config for the container

Add `agent-manager.config.devcontainer.example.json`, copied to `agent-manager.config.json` on create, with:

- `"permissionMode": "bypassPermissions"`, since the container is the sandbox.
- **A separate `stateFile`** (e.g. `state.devcontainer.json`). Session IDs only exist in the `~/.claude` that created them, so state from Windows can't be resumed in the container, or the other way round.
- `"host": "127.0.0.1"` for VS Code port forwarding. Use `0.0.0.0` only with plain `docker run -p`.
- **A non-empty `token`.** With `bypassPermissions`, anyone who can reach the port can run commands in the container.

## 5. Verify

1. `npm start` inside the container. The page opens on the host at the forwarded URL.
2. Start an orchestrator in a mounted repo folder and have it create an expert in another one. The expert can read the files there and write its findings file.
3. Restart the manager. Agents resume their sessions.
4. Open the same checkout on Windows. It still runs, with its own `node_modules` and state.

## Later

When orchestrators should work across both environments, switch the `folder` inputs from absolute paths to repo names mapped per environment in the config.
