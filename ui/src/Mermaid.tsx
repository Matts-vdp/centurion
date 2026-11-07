import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';

// Mermaid code blocks in Markdown (replies and .md files), drawn as diagrams. Mermaid is large, so it loads
// the first time a diagram appears. Its colours come from the theme variables in styles.css.

type MermaidApi = (typeof import('mermaid'))['default'];

let loading: Promise<MermaidApi> | null = null;
const load = (): Promise<MermaidApi> => (loading ??= import('mermaid').then((m) => m.default));

// One render at a time: initialize() is global, and each render reads the theme it set.
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function themeVariables(): Record<string, string | boolean> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    darkMode: css.colorScheme === 'dark',
    background: v('--canvas'),
    fontFamily: v('--font'),
    fontSize: '14px',
    textColor: v('--text'),
    titleColor: v('--text'),
    lineColor: v('--text-3'),
    primaryColor: v('--raised'),
    primaryTextColor: v('--text'),
    primaryBorderColor: v('--text-3'),
    secondaryColor: v('--fill'),
    secondaryTextColor: v('--text'),
    secondaryBorderColor: v('--text-3'),
    tertiaryColor: v('--sunken'),
    tertiaryTextColor: v('--text'),
    tertiaryBorderColor: v('--line'),
    mainBkg: v('--raised'),
    nodeBorder: v('--text-3'),
    nodeTextColor: v('--text'),
    clusterBkg: v('--sunken'),
    clusterBorder: v('--line'),
    edgeLabelBackground: v('--canvas'),
    noteBkgColor: v('--fill'),
    noteTextColor: v('--text'),
    noteBorderColor: v('--line'),
    actorBkg: v('--raised'),
    actorBorder: v('--text-3'),
    actorTextColor: v('--text'),
    actorLineColor: v('--text-3'),
    signalColor: v('--text-2'),
    signalTextColor: v('--text'),
    labelBoxBkgColor: v('--fill'),
    labelBoxBorderColor: v('--line'),
    labelTextColor: v('--text'),
    loopTextColor: v('--text'),
    activationBkgColor: v('--fill'),
    activationBorderColor: v('--text-3'),
  };
}

function render(code: string): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await load();
    const vars = themeVariables();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: vars,
      fontFamily: String(vars.fontFamily),
    });
    const id = `mermaid-${++counter}`;
    try {
      return (await mermaid.render(id, code)).svg;
    } finally {
      // A failed render leaves its scratch element in the body.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

// ---------- the theme, so diagrams redraw when it changes ----------

let themeVersion = 0;
const themeListeners = new Set<() => void>();
let themeWatching = false;

function watchTheme(): void {
  if (themeWatching) return;
  themeWatching = true;
  const bump = () => {
    themeVersion++;
    for (const fn of themeListeners) fn();
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bump);
  new MutationObserver(bump).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function useThemeVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      watchTheme();
      themeListeners.add(fn);
      return () => themeListeners.delete(fn);
    },
    () => themeVersion,
  );
}

/** The diagram's own width, from its viewBox. */
function naturalWidth(svg: string): number {
  const m = /viewBox="[-\d.]+\s+[-\d.]+\s+([\d.]+)/.exec(svg);
  return m ? Math.ceil(Number(m[1])) : 0;
}

// ---------- the block ----------

/** A Mermaid diagram; `fallback` (the ordinary code block) shows its source, and stands in when it fails. */
export function MermaidBlock({ code, fallback }: { code: string; fallback: ReactNode }) {
  const theme = useThemeVersion();
  const [result, setResult] = useState<{ svg: string } | { error: string } | null>(null);
  const [source, setSource] = useState(false);

  useEffect(() => {
    let live = true;
    render(code).then(
      (svg) => live && setResult({ svg }),
      (err: unknown) => live && setResult({ error: (err instanceof Error ? err.message : String(err)).split('\n')[0] }),
    );
    return () => {
      live = false;
    };
  }, [code, theme]);

  if (result && 'error' in result) {
    return (
      <div className="mermaid-block">
        <div className="visual-broken" title={result.error}>
          This diagram could not be drawn; here is its source.
        </div>
        {fallback}
      </div>
    );
  }
  return (
    <figure className="visual mermaid-block">
      <figcaption className="visual-head">
        <button className="visual-toggle" aria-pressed={source} onClick={() => setSource((s) => !s)}>
          {source ? 'Diagram' : 'Source'}
        </button>
      </figcaption>
      {source ? (
        fallback
      ) : result ? (
        // Mermaid's strict mode sanitizes its SVG output.
        <div
          className="mermaid-diagram"
          style={{ '--natural': `${naturalWidth(result.svg)}px` } as CSSProperties}
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        <div className="mermaid-diagram loading">Drawing the diagram…</div>
      )}
    </figure>
  );
}
