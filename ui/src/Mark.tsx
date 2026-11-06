import type { AgentRecord } from './api';
import { monogram, repoHue, type StateKey } from './status';

const STATE_LABEL: Record<StateKey, string> = {
  running: 'running',
  needs: 'needs you',
  failed: 'failed',
  interrupted: 'interrupted',
  queued: 'queued',
  waiting: 'waiting on experts',
  unread: 'new reply',
  stopped: 'stopped',
  idle: 'idle',
};

/**
 * An agent's mark: a monogram (filled for orchestrators, tinted in its repo's hue for experts) with its
 * state in the bottom-right corner. The tint says which repo; only the corner says state.
 */
export function AgentMark({
  agent,
  state,
  size = 24,
}: {
  agent: Pick<AgentRecord, 'name' | 'kind'> & { cwd?: string };
  state?: StateKey;
  size?: number;
}) {
  const hue = agent.kind === 'expert' && agent.cwd ? repoHue(agent.cwd) : undefined;
  return (
    <span
      className={`mark ${agent.kind}`}
      data-hue={hue}
      style={{ width: size, height: size, fontSize: size < 22 ? 9 : 10 }}
      role="img"
      aria-label={`${agent.name}${state && state !== 'idle' ? `, ${STATE_LABEL[state]}` : ''}`}
    >
      <span aria-hidden="true">{monogram(agent.name)}</span>
      {state && state !== 'idle' && <span className={`mark-state ${state}`} aria-hidden="true" />}
    </span>
  );
}

/** A state indicator on its own, for status sentences. */
export function StateDot({ state }: { state: StateKey }) {
  if (state === 'idle') return null;
  return <span className={`state-dot ${state}`} aria-hidden="true" />;
}
