/**
 * Environment variables a Claude Code session sets for the processes it starts. When Centurion runs inside one
 * (`CLAUDECODE` is set), its agents would inherit the host session's settings, proxy and IDs, so these are removed.
 */
const HOST_SESSION_VARS = /^(CLAUDECODE$|CLAUDE_|ANTHROPIC_BASE_URL$|MCP_CONNECTION_NONBLOCKING$|MCP_SERVER_CONNECTION_BATCH_SIZE$)/;

/** Auth and provider settings the user set themselves; kept even inside a host session. */
const KEEP = /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_CODE_USE_\w+|CLAUDE_CODE_SKIP_\w+_AUTH)$/;

/** The environment for agent processes: this process's, without a host session's variables, plus `extra`, minus `remove`. */
export function agentEnvironment(
  base: NodeJS.ProcessEnv,
  options: { stripHostEnv: boolean; extra: Record<string, string>; remove: string[] },
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (options.stripHostEnv && base.CLAUDECODE) {
    for (const key of Object.keys(env)) if (HOST_SESSION_VARS.test(key) && !KEEP.test(key)) delete env[key];
  }
  Object.assign(env, options.extra);
  for (const key of options.remove) delete env[key];
  return env;
}
