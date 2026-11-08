// The browser tab shows what needs you while you are elsewhere: a count in the title and a state
// dot on the favicon (amber: something needs you, blue: agents are running). Static, no animation.
import { useEffect } from 'react';
import type { AgentRecord } from './api';
import { agentState, needsYou } from './status';
import { lastSeen, useManager } from './store';

const BASE = '/favicon.svg';

// The logo from public/favicon.svg, with room for a ringed dot in the bottom-right corner.
function iconWith(dot: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="#0e8a83"/>` +
    `<g transform="translate(4 4)" fill="#fff" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="5" cy="12" r="2.6"/><circle cx="19" cy="5" r="2.6"/><circle cx="19" cy="19" r="2.6"/>` +
    `<path fill="none" d="M7.5 12h4M11.5 12V7c0-1.1.9-2 2-2h3M11.5 12v5c0 1.1.9 2 2 2h3"/></g>` +
    `<circle cx="25" cy="25" r="6.5" fill="${dot}" stroke="#fff" stroke-width="2.5"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const NEEDS_ICON = iconWith('#e8a33a');
const RUNNING_ICON = iconWith('#2f7cf0');

function setIcon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (link.getAttribute('href') === href) return;
  link.type = 'image/svg+xml';
  link.href = href;
}

/** Keeps the tab title and favicon in step with what needs you; `current` is the agent on screen. */
export function useTabStatus(current: AgentRecord | undefined): void {
  // The whole store re-renders this on any change, permissions, plans and questions included.
  const { agents } = useManager();
  const seen = lastSeen.use();
  const now = Date.now();
  let needs = 0;
  let running = 0;
  for (const a of agents.values()) {
    if (a.archived) continue;
    if (a.status === 'running') running++;
    if (needsYou(a, agentState(a, agents, seen, undefined, now))) needs++;
  }
  const title = `${needs > 0 ? `(${needs}) ` : ''}${current ? `${current.name} · ` : ''}Centurion`;
  const icon = needs > 0 ? NEEDS_ICON : running > 0 ? RUNNING_ICON : BASE;
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => setIcon(icon), [icon]);
}
