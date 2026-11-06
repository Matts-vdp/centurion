import type { AgentRecord } from './api';

export const STATUS_LABEL: Record<AgentRecord['status'], string> = {
  running: 'Running',
  idle: 'Idle',
  error: 'Error',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

export function StatusDot({ status }: { status: AgentRecord['status'] }) {
  return <span className={`status-dot ${status}`} role="img" aria-label={STATUS_LABEL[status]} />;
}
