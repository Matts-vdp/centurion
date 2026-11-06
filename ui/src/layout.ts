import { useSyncExternalStore } from 'react';

/** The main area: one or two panes, each showing an agent. Per browser, in localStorage. */
export type Layout = {
  /** Agent ids, left to right; one or two. Empty when nothing is open. */
  panes: string[];
  /** Index of the focused pane. */
  focus: number;
  /** Width of the left pane as a fraction of the main area, while split. */
  ratio: number;
};

const KEY = 'agent-manager-layout';
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;

/** Where a dragged agent lands: a side of the split, or in place of the single pane. */
export type DropZone = 'left' | 'right' | 'replace';

/** The data type a dragged sidebar row carries. */
export const DRAG_TYPE = 'application/x-agent-id';

function read(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Layout> | null;
    const panes = Array.isArray(raw?.panes) ? raw.panes.filter((p): p is string => typeof p === 'string').slice(0, 2) : [];
    const focus = raw?.focus === 1 && panes.length === 2 ? 1 : 0;
    const ratio = typeof raw?.ratio === 'number' ? clamp(raw.ratio) : 0.5;
    return { panes, focus, ratio };
  } catch {
    return { panes: [], focus: 0, ratio: 0.5 };
  }
}

function clamp(r: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, r));
}

class LayoutStore {
  private value: Layout = read();
  private readonly listeners = new Set<() => void>();

  get = () => this.value;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** The focused pane's agent, which the URL hash follows. */
  focused(): string | null {
    return this.value.panes[this.value.focus] ?? null;
  }

  /** Open an agent: focus its pane if it's already open, else show it in the focused pane. */
  open(id: string): void {
    const { panes, focus } = this.value;
    const at = panes.indexOf(id);
    if (at >= 0) return this.set({ focus: at });
    if (panes.length === 0) return this.set({ panes: [id], focus: 0 });
    const next = [...panes];
    next[focus] = id;
    this.set({ panes: next });
  }

  /** Open an agent next to the focused one (or in place of the other pane when already split). */
  openInSplit(id: string): void {
    const { panes, focus } = this.value;
    if (panes.length < 2) return this.drop(id, 'right');
    this.drop(id, focus === 0 ? 'right' : 'left');
  }

  /** A dragged agent was dropped on the main area. */
  drop(id: string, zone: DropZone): void {
    const { panes } = this.value;
    if (panes.length === 0 || zone === 'replace') {
      if (panes.length === 2) return this.drop(id, this.value.focus === 0 ? 'left' : 'right');
      return this.set({ panes: [id], focus: 0 });
    }
    const side = zone === 'left' ? 0 : 1;
    if (panes.length === 1) {
      if (panes[0] === id) return this.set({ focus: 0 });
      return this.set({ panes: side === 0 ? [id, panes[0]] : [panes[0], id], focus: side });
    }
    const other = panes[1 - side];
    // Dropping the other pane's agent swaps the two.
    const next = other === id ? [...panes].reverse() : side === 0 ? [id, other] : [other, id];
    this.set({ panes: next, focus: side });
  }

  setFocus(index: number): void {
    if (index !== this.value.focus && index < this.value.panes.length) this.set({ focus: index });
  }

  close(index: number): void {
    const panes = this.value.panes.filter((_, i) => i !== index);
    this.set({ panes, focus: 0 });
  }

  setRatio(ratio: number): void {
    this.set({ ratio: clamp(ratio) });
  }

  private set(patch: Partial<Layout>): void {
    const next = { ...this.value, ...patch };
    if (next.focus >= next.panes.length) next.focus = 0;
    const same = next.focus === this.value.focus && next.ratio === this.value.ratio && next.panes.join('\n') === this.value.panes.join('\n');
    if (same) return;
    this.value = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // storage blocked: the layout just isn't remembered
    }
    for (const fn of this.listeners) fn();
  }
}

export const layout = new LayoutStore();

export function useLayout(): Layout {
  return useSyncExternalStore(layout.subscribe, layout.get);
}
