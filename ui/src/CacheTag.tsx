import { useEffect, useRef, useState } from 'react';
import { commands, type AgentRecord } from './api';
import { useNow } from './hooks';
import { clock, money } from './status';

type Props = {
  agent: AgentRecord;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

/** The longest keep-warm episode per TTL, in minutes (the same rule as `keepWarmCapMinutes` in src/types.ts). */
function capMinutes(ttlSeconds: number): number {
  return ttlSeconds >= 3600 ? 480 : 45;
}

/** The durations offered, in minutes (as `keepWarmChoices` in src/types.ts). */
function choices(ttlSeconds: number): number[] {
  return ttlSeconds >= 3600 ? [120, 240, 480] : [15, 30, 45];
}

function duration(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * How long the prompt cache stays warm (an estimate from the last turn's last request), as a button that
 * opens the keep-warm settings. A message sent before it runs out reads the context from the cache; after,
 * the next turn writes all of it again.
 */
export function CacheTag({ agent, run }: Props) {
  const cache = agent.cache;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const visible = !!cache && agent.status !== 'running';
  const expires = cache ? Date.parse(cache.at) + cache.ttlSeconds * 1000 : 0;
  const now = useNow(visible && expires > Date.now(), expires - Date.now() < 120_000 ? 1000 : 10_000);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close, true);
    };
  }, [open]);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  if (!visible || !cache) return null;
  const left = Math.max(0, Math.round((expires - now) / 1000));
  const label = left <= 0 ? 'cold' : left <= 60 ? `0:${String(left).padStart(2, '0')}` : `${Math.ceil(left / 60)}m`;
  const on = keepWarmOn(agent);
  const title = `${remaining(left, cache.ttlSeconds)}${on ? '\nKeep-warm is on.' : ''}\nClick for keep-warm settings.`;
  return (
    <div className="menu-anchor" ref={ref}>
      <button
        className={`cache-tag mono${left <= 0 ? ' cold' : left <= 60 ? ' warn' : ''}${on ? ' kept' : ''}`}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="cache-word">cache </span>
        {label}
        {on && <span className="cache-kept"> · warm</span>}
      </button>
      {open && <Popover agent={agent} left={left} now={now} run={run} />}
    </div>
  );
}

function keepWarmOn(agent: AgentRecord): boolean {
  const kw = agent.keepWarm;
  return !!kw && (kw.minutes > 0 || (kw.experts && agent.kind === 'orchestrator'));
}

function ttlName(ttlSeconds: number): string {
  return ttlSeconds >= 3600 ? '1 hour' : `${Math.round(ttlSeconds / 60)} minute`;
}

function remaining(left: number, ttlSeconds: number): string {
  const ttl = ttlName(ttlSeconds);
  return left <= 0
    ? `The prompt cache has probably expired (${ttl} cache). The next turn writes the whole context to the cache again, which costs more.`
    : `The prompt cache stays warm for about ${left > 60 ? `${Math.ceil(left / 60)} more minutes` : `${left} more seconds`} (${ttl} cache, estimated from the last request). A message sent before then reads the context from the cache.`;
}

function Popover({ agent, left, now, run }: { agent: AgentRecord; left: number; now: number; run: Props['run'] }) {
  const cache = agent.cache!;
  const ttl = cache.ttlSeconds;
  const cap = capMinutes(ttl);
  const kw = agent.keepWarm ?? { minutes: 0, experts: false };
  const minutes = Math.min(kw.minutes, cap);
  const isChat = agent.kind === 'orchestrator';
  const warm = agent.warm;
  const context = agent.context?.usedTokens ?? 0;
  const set = (next: { minutes: number; experts: boolean }) => void run(() => commands.setKeepWarm(agent.id, next));

  return (
    <div className="model-popover cache-popover" role="dialog" aria-label="Prompt cache">
      <div className="model-section">Prompt cache</div>
      <div className="cache-now">
        {left <= 0 ? 'Probably expired' : `Warm for about ${left > 60 ? `${Math.ceil(left / 60)} more minutes` : `${left} more seconds`}`}
        <span className="cache-ttl mono">{ttlName(ttl)} cache</span>
      </div>
      <div className="model-section">Keep warm after each turn</div>
      <div className="segmented" role="radiogroup" aria-label="Keep warm after each turn" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        {[0, ...choices(ttl)].map((m) => (
          <button key={m} role="radio" aria-checked={m === minutes} className={m === minutes ? 'on' : undefined} onClick={() => m !== minutes && set({ minutes: m, experts: kw.experts })}>
            {m === 0 ? 'Off' : duration(m)}
          </button>
        ))}
      </div>
      {isChat && (
        <label className="cache-check">
          <input type="checkbox" checked={kw.experts} onChange={(e) => set({ minutes: kw.minutes, experts: e.target.checked })} />
          <span>
            <span className="cache-check-name">While its experts work</span>
            <span className="model-option-hint">Until their replies come back, at most {duration(cap)} after the last turn</span>
          </span>
        </label>
      )}
      {keepWarmOn(agent) && warm && (
        <div className="cache-status">
          {status(agent, now).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
      <div className="model-note">
        {context > 0 ? `A ping reads the ${tokens(context)}-token context from the cache` : 'A ping reads the context from the cache'} for about a tenth of the input
        price. A cold cache is written again at {ttl >= 3600 ? '2×' : '1.25×'} the input price
        {ttl < 3600 && ', so on a 5 minute cache pinging pays for about 45 minutes'}. Pings run in a throw-away copy of the session and don't change the conversation.
      </div>
    </div>
  );
}

/** Ping costs are often fractions of a cent. */
function cost(usd: number): string {
  return usd > 0 && usd < 0.001 ? 'under $0.001' : money(usd);
}

/** What keep-warm is doing, then what it did since the last turn, one line each. */
function status(agent: AgentRecord, now: number): string[] {
  const warm = agent.warm!;
  const kw = agent.keepWarm!;
  const parts: string[] = [];
  const until = warm.until ? Date.parse(warm.until) : null;
  if (warm.stopped) parts.push(warm.stopped);
  else if (warm.nextAt) parts.push(`Next ping at ${clock(warm.nextAt)}${until ? `, keeping warm until ${clock(until)}` : ''}.`);
  else if (until && now < until) parts.push(`The cache lasts until ${clock(until)} without a ping.`);
  else if (until) parts.push(`Done: kept warm until ${clock(until)}.`);
  else if (kw.experts && agent.kind === 'orchestrator') parts.push('Pings while its experts work.');
  if (warm.pings > 0) parts.push(`${warm.pings} ping${warm.pings === 1 ? '' : 's'} since the last turn, ${cost(warm.costUsd)}.`);
  const last = warm.last;
  if (last && !warm.stopped) {
    parts.push(
      last.error
        ? `Last ping at ${clock(last.at)} failed.`
        : `Last ping at ${clock(last.at)} read ${tokens(last.readTokens)}${last.expectedTokens ? ` of ${tokens(last.expectedTokens)}` : ''} tokens from the cache.`,
    );
  }
  return parts;
}
