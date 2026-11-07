# Adding dev container support

Goal: run Centurion and all its agents inside a dev container, and open the page in the host browser through a forwarded port. The code runs on Linux and installs as the `centurion` command (`docs/cli-plan.md`). What a container needs is the install, auth and a managing folder set up for it. This setup lives in the managing repo, not here.

## 1. Decide where Centurion runs

The agents have to run where the repositories and their tooling are (language runtimes, MCP servers, build tools). In practice that means one of two options:

- **Inside the existing work dev container** that already has the repos. Add Node and the `centurion` command to it. This is the simplest option and probably the right one.
- **In a dedicated container for Centurion**, with the repos mounted into it. This only works if the experts don't need the repos' own tooling.

## 2. Container setup (`.devcontainer/devcontainer.json` of the managing repo)

- **Node 20.11 or newer** (24 recommended) and `git`, e.g. the `mcr.microsoft.com/devcontainers/typescript-node:24` image or a Node feature.
- **A non-root user** (`remoteUser: "node"`). Claude Code refuses `bypassPermissions` when it runs as root.
- **`forwardPorts: [4317]`**, so the page opens in the host browser.
- **`~/.claude` on a volume**, so the login and session transcripts survive rebuilds. Without them, sessions can't be resumed.
- **Mounts for every repo** the experts need. Agents can only use paths that exist inside the container (e.g. `/workspaces/...`).
- **`safe.directory`** for each mounted repo (`git config --global --add safe.directory '*'` or one per path), so the Files panel shows git state for repos owned by another user.
- **`postCreateCommand`** that installs the pinned version and sets up the managing folder if it has no config yet:

  ```bash
  npm i -g github:Matts-vdp/centurion#v0.1.0 && (test -f .centurion/config.json || centurion init --container)
  ```

  Pinning the tag here makes an upgrade a reviewed change. Normally `.centurion/` is committed, so `init` only runs once. Without access to GitHub, install a tarball kept in the repo or the image instead (`npm i -g ./centurion-0.1.0.tgz`).

## 3. Auth inside the container

The container doesn't share the host's Claude login. Pick one of these:

- Run `claude setup-token` on the host and pass `CLAUDE_CODE_OAUTH_TOKEN` in through `remoteEnv` (`${localEnv:...}`).
- Pass the Foundry variables (`CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_RESOURCE`, the key or Entra settings) the same way. Keep secrets out of `.centurion/config.json`, which is committed.
- Run `claude` → `/login` once inside the container. This works because `~/.claude` is on a volume.

Check that no stray `ANTHROPIC_API_KEY` is set. If one is, it takes precedence and gets billed.

## 4. The managing folder's config

`centurion init --container` writes `.centurion/config.json` with `"permissionMode": "bypassPermissions"`, since the container is the sandbox. Beyond that:

- **State stays in the container.** A managing repo runs in one environment only, so `.centurion/state/` (ignored by git) belongs to the container. Session IDs only exist in the `~/.claude` that created them.
- **`host`** stays `127.0.0.1` for VS Code port forwarding. Use `0.0.0.0` only with plain `docker run -p` (or set `CENTURION_HOST`).
- **The token** is generated into `.centurion/state/token` on first start and printed with the URL. With `bypassPermissions`, anyone who can reach the port can run commands in the container, so never turn the check off there. `CENTURION_TOKEN` sets a fixed one if another tool needs to know it.

## 5. Verify

1. `centurion` inside the container. The UI opens on the host at the forwarded URL.
2. Start a chat and have it create an expert in another mounted repo. The expert can read the files there and write its findings where the repo's skill says.
3. Restart Centurion. Agents resume their sessions.
4. Rebuild the container. The login and sessions survive (the `~/.claude` volume); Centurion is installed again at the pinned version.

## Later

Repo names instead of absolute paths (`docs/cli-plan.md`, open questions), so skills and prompts don't depend on where the container mounts each repo.
