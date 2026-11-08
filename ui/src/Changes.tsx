import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from 'react';
import {
  baseName,
  commitAllAlways,
  commitDrafts,
  dirName,
  gitApi,
  gitFailure,
  repoTop,
  type DiffSide,
  type GitCommand,
  type GitEntry,
  type GitLetter,
  type GitStatus,
  type GitRemoteWrite,
  type GitWrite,
} from './fileStore';
import { Chevron, ChevronDownIcon, DiscardIcon, FileIcon, ForkIcon, MinusIcon, MoreIcon, PlusIcon } from './icons';
import { continueList } from './listInput';
import { BranchPopover } from './BranchPopover';
import { composerFill } from './store';

/**
 * The Changes segment of the Files panel (`docs/git-plan.md` §3): the branch, the changes in git's groups
 * (conflicts, staged, unstaged, and the ones outside the agent's folder), their actions, the commit box and
 * the result line of the last action.
 */

/** What the last git action did, shown under the commit box until the next one. `undo`: the commit Undo takes back. */
export type ResultLine = { error: boolean; text: string; details: string; commands: GitCommand[]; undo?: string; sync?: boolean };

function remoteResult(action: string, r: GitRemoteWrite): ResultLine {
  const text = r.conflicted ? 'Pull has conflicts. Resolve them before syncing again' :
    action === 'publish' ? 'Published branch and set its upstream' :
    r.pulled && r.pushed ? `Pulled ${plural(r.pulled, 'commit')} from ${r.status?.upstream ?? 'upstream'}, pushed ${r.pushed}` :
    r.pulled ? `Pulled ${plural(r.pulled, 'commit')} from ${r.status?.upstream ?? 'upstream'}` :
    r.pushed ? `Pushed ${plural(r.pushed, 'commit')}` :
    action === 'fetch' ? 'Fetched remote changes' : 'Already up to date';
  return { error: false, text, details: '', commands: r.commands };
}

function remoteFailure(err: unknown): ResultLine {
  const f = gitFailure(err);
  return { error: true, text: f.error, details: f.details, commands: f.commands, sync: f.error === 'The remote has new commits' };
}

type Group = 'conflicts' | 'staged' | 'unstaged';
type Item = { group: Group; entry: GitEntry; inside: boolean; /** Relative to the root inside the folder, else the repo path. */ rel: string };
type Confirm = { key: string; paths: string[]; text: string; verb: string };

type Props = {
  agentId: string;
  /** The agent's folder (root 0). */
  rootPath: string;
  status: GitStatus | null;
  /** The diff on screen, to mark its row. */
  selected: { path: string; side: DiffSide } | null;
  result: ResultLine | null;
  onResult: (r: ResultLine | null) => void;
  /** A write's new status (and the paths it deleted, relative to the root). */
  onWritten: (status: GitStatus | null, deleted?: string[]) => void;
  onOpen: (path: string, mode: 'file' | 'diff' | 'resolver', side: DiffSide) => void;
  onCompare: (range: string) => void;
};

const GROUP_NAMES: Record<Group, string> = { conflicts: 'Conflicts', staged: 'Staged', unstaged: 'Changes' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (hash: string) => hash.slice(0, 7);

/** Paths in every group, inside the folder and outside, without repeats. */
export function changeCount(status: GitStatus | null): number {
  if (!status) return 0;
  const all = new Set<string>();
  for (const g of [status, status.outside]) for (const e of [...g.conflicts, ...g.staged, ...g.unstaged]) all.add(e.path);
  return all.size;
}

export function Changes({ agentId, rootPath, status, selected, result, onResult, onWritten, onOpen, onCompare }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const [operationBusy, setOperationBusy] = useState<'abort' | 'continue' | null>(null);
  const [mergeMessage, setMergeMessage] = useState<{ text: string; at: number } | null>(null);
  const fetchedOnOpen = useRef<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [outsideOpen, setOutsideOpen] = useState(false);
  /** After Space moves a row to another group, the focus stays at the same place in the group it left. */
  const refocus = useRef<{ group: string; index: number } | null>(null);

  useLayoutEffect(() => {
    const at = refocus.current;
    if (!at || !listRef.current) return;
    refocus.current = null;
    const rows = [...listRef.current.querySelectorAll<HTMLButtonElement>(`.change-main[data-group="${at.group}"]`)];
    const target = rows[Math.min(at.index, rows.length - 1)] ?? listRef.current.querySelector<HTMLButtonElement>('.change-main');
    target?.focus();
  }, [status]);

  const doRemote = async (action: 'fetch' | 'pull' | 'push' | 'sync' | 'publish', remote?: string, quiet = false) => {
    setRemoteBusy(action);
    try {
      const r = await gitApi.remote(agentId, action, remote);
      onWritten(r.status);
      if (!quiet) onResult(remoteResult(action, r));
    } catch (err) {
      onResult(remoteFailure(err));
    } finally {
      setRemoteBusy(null);
    }
  };

  const doOperation = async (action: 'abort' | 'continue') => {
    setOperationBusy(action);
    try {
      if (action === 'continue' && status?.operation?.kind === 'merge') {
        const r = await gitApi.mergeMessage(agentId);
        setMergeMessage({ text: r.message, at: Date.now() });
        return;
      }
      const r = await gitApi.operation(agentId, action);
      onWritten(r.status);
      onResult({ error: false, text: action === 'abort' ? 'Aborted the Git operation' : 'Continued the Git operation', details: '', commands: r.commands });
    } catch (err) { onResult(remoteFailure(err)); }
    finally { setOperationBusy(null); }
  };

  useEffect(() => {
    if (!status || remoteBusy || (status.fetchedAt !== null && Date.now() - status.fetchedAt < 5 * 60_000)) return;
    const key = `${agentId}:${status.branch}:${status.fetchedAt}`;
    if (fetchedOnOpen.current === key) return;
    fetchedOnOpen.current = key;
    void doRemote('fetch', undefined, true);
  }, [agentId, status?.branch, status?.fetchedAt]);

  if (!status) return <p className="files-note">Loading…</p>;

  const prefix = status.prefix;
  const toRel = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const items = (g: GitStatus['outside'], inside: boolean) =>
    (Object.keys(GROUP_NAMES) as Group[]).map((group) => ({
      group,
      items: g[group].map((entry): Item => ({ group, entry, inside, rel: inside ? toRel(entry.path) : entry.path })),
    }));
  const inside = items(status, true);
  const outside = items(status.outside, false);
  const outsideCount = new Set([...status.outside.conflicts, ...status.outside.staged, ...status.outside.unstaged].map((e) => e.path)).size;
  const askAgent = () => {
    const op = status.operation;
    const files = [...status.conflicts, ...status.outside.conflicts].map((e) => e.path);
    const operation = op ? `${op.kind} ${op.branch ?? status.branch ?? 'this branch'} with ${op.onto ?? 'incoming changes'}` : `stash restore on ${status.branch ?? 'this branch'} with stashed changes`;
    composerFill.set({ agentId, text: `Please help resolve the ${operation} conflicts in ${files.join(', ')}. Review both sides and explain your proposed resolution.` });
  };
  const stagedPaths = new Set(status.staged.map((e) => e.path));
  const unstagedPaths = new Set(status.unstaged.map((e) => e.path));

  /** Which diff a row opens: the side when the file is partly staged, else HEAD ↔ working tree as everywhere else. */
  const sideOf = (it: Item): DiffSide =>
    it.group === 'staged' ? (unstagedPaths.has(it.entry.path) ? 'staged' : 'head') : it.group === 'unstaged' && stagedPaths.has(it.entry.path) ? 'worktree' : 'head';

  const run = async <T extends GitWrite>(key: string, call: () => Promise<T>, done: (r: T) => ResultLine | null | undefined) => {
    setBusy((b) => new Set(b).add(key));
    try {
      const r = await call();
      const deleted = 'deleted' in r && Array.isArray(r.deleted) ? (r.deleted as string[]).map(toRel) : undefined;
      onWritten(r.status, deleted);
      const line = done(r);
      if (line !== undefined) onResult(line);
    } catch (err) {
      const f = gitFailure(err);
      onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(key);
        return next;
      });
    }
  };

  // Staging and unstaging show in the lists, so they leave the result line alone unless they fail.
  const stage = (paths: string[], key: string) => void run(key, () => gitApi.stage(agentId, paths), () => undefined);
  const resolveRow = (it: Item, take: 'yours' | 'incoming' | 'delete' | 'keep') => void run(`row:${it.group}:${it.entry.path}`, async () => {
    const data = await gitApi.conflict(agentId, it.entry.path);
    return gitApi.resolve(agentId, { path: it.entry.path, take: take === 'keep' ? (data.deleted === 'yours' ? 'incoming' : 'yours') : take, hash: data.hash });
  }, () => undefined);
  const simple = (paths: string[], key: string) => void run(key, () => gitApi.resolveSimple(agentId, paths), (r) => ({ error: false, text: `Resolved ${plural(r.resolved, 'simple conflict')}`, details: '', commands: r.commands }));
  const unstage = (paths: string[], key: string) => void run(key, () => gitApi.unstage(agentId, paths), () => undefined);
  const discard = (paths: string[], key: string) =>
    void run(
      key,
      () => gitApi.discard(agentId, paths),
      (r) => {
        const removed = r.deleted.length;
        const restored = paths.length - removed;
        const name = baseName(paths[0]);
        const text =
          paths.length === 1
            ? removed
              ? `Deleted ${name}`
              : `Discarded your changes to ${name}`
            : restored && removed
              ? `Discarded ${plural(restored, 'change')}, deleted ${plural(removed, 'untracked file')}`
              : restored
                ? `Discarded ${plural(restored, 'change')}`
                : `Deleted ${plural(removed, 'untracked file')}`;
        return { error: false, text, details: '', commands: r.commands };
      },
    );

  const askDiscard = (key: string, entries: GitEntry[]) => {
    const paths = entries.map((e) => e.path);
    const untracked = entries.filter((e) => e.status === 'U').length;
    let text: string;
    let verb = 'Discard';
    if (entries.length === 1) {
      const name = baseName(paths[0]);
      if (untracked) {
        text = `Delete ${name}? It isn't in git, so this can't be undone.`;
        verb = 'Delete';
      } else text = `Discard your changes to ${name}? This can't be undone.`;
    } else {
      text = `Discard all ${plural(entries.length, 'change')}?${untracked ? ` ${plural(untracked, 'untracked file is', 'untracked files are')} deleted.` : ''} This can't be undone.`;
    }
    setConfirm({ key, paths, text, verb });
  };

  /** Space on a row: stage what isn't staged, unstage what is; a conflict is marked resolved. */
  const toggle = (it: Item) => (it.group === 'conflicts' ? it.inside && onOpen(it.rel, 'file', 'head') : it.group === 'staged' ? unstage([it.entry.path], `row:${it.group}:${it.entry.path}`) : stage([it.entry.path], `row:${it.group}:${it.entry.path}`));

  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, it: Item, index: number, groupKey: string) => {
    if (e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('.change-main') ?? [])];
      const at = rows.indexOf(e.currentTarget);
      rows[Math.min(rows.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return;
      refocus.current = { group: groupKey, index };
      toggle(it);
    }
  };

  const total = changeCount(status);
  const confirmStrip = (key: string) =>
    confirm?.key === key && (
      <div className="rewind-confirm change-confirm" role="group" aria-label="Discard">
        <span>{confirm.text}</span>
        <button className="button secondary small" onClick={() => setConfirm(null)}>
          Cancel
        </button>
        <button
          className="button secondary small danger"
          autoFocus
          onClick={() => {
            setConfirm(null);
            discard(confirm.paths, key);
          }}
          onKeyDown={(e) => e.key === 'Escape' && setConfirm(null)}
        >
          {confirm.verb}
        </button>
      </div>
    );

  const renderGroup = (group: Group, list: Item[], scope: 'in' | 'out') => {
    if (list.length === 0) return null;
    const groupKey = `${scope}:${group}`;
    const paths = list.map((it) => it.entry.path);
    const actions: ReactNode[] = [];
    if (group === 'conflicts') {
      actions.push(
        <GroupMenu key="c" items={[
          { label: 'Resolve all simple ones', run: () => simple(paths, `all:${groupKey}`) },
          { label: 'Ask the agent', run: askAgent },
        ]} />,
      );
    } else if (group === 'staged') {
      actions.push(
        <button key="u" className="icon-button small" title="Unstage all" aria-label="Unstage all" disabled={busy.has(`all:${groupKey}`)} onClick={() => unstage(paths, `all:${groupKey}`)}>
          <MinusIcon size={14} />
        </button>,
      );
    } else if (group === 'unstaged') {
      const entries = list.map((it) => it.entry);
      const tracked = entries.filter((e) => e.status !== 'U');
      actions.push(
        <button key="d" className="icon-button small" title="Discard all…" aria-label="Discard all" onClick={() => askDiscard(`all:${groupKey}`, entries)}>
          <DiscardIcon size={14} />
        </button>,
        <button key="s" className="icon-button small" title="Stage all" aria-label="Stage all" disabled={busy.has(`all:${groupKey}`)} onClick={() => stage(paths, `all:${groupKey}`)}>
          <PlusIcon size={14} />
        </button>,
        <GroupMenu
          key="m"
          items={[
            {
              label: 'Stage tracked files only',
              hint: tracked.length ? 'Leaves new files unstaged' : 'Every change here is a new file',
              disabled: tracked.length === 0 || tracked.length === entries.length,
              run: () => stage(tracked.map((e) => e.path), `all:${groupKey}`),
            },
            {
              label: 'Discard tracked changes only…',
              hint: 'Keeps new files',
              disabled: tracked.length === 0 || tracked.length === entries.length,
              run: () => askDiscard(`all:${groupKey}`, tracked),
            },
          ]}
        />,
      );
    }
    return (
      <div key={groupKey} className="change-group" role="group" aria-label={GROUP_NAMES[group]}>
        <div className={`change-group-head${scope === 'out' ? ' nested' : ''}`}>
          <span className="change-group-label">
            {GROUP_NAMES[group]} · {list.length}
          </span>
          {actions.length > 0 && <span className="change-group-actions">{actions}</span>}
        </div>
        {confirmStrip(`all:${groupKey}`)}
        {list.map((it, index) => {
          const rowKey = `row:${it.group}:${it.entry.path}`;
          const side = sideOf(it);
          const isSelected = it.inside && selected?.path === it.rel && selected.side === side;
          return (
            <Fragment key={rowKey}>
            <div className={`change-row${isSelected ? ' selected' : ''}${scope === 'out' ? ' outside' : ''}`}>
              <ChangeRow
                item={it}
                groupKey={groupKey}
                index={index}
                onClick={() => it.inside && onOpen(it.rel, it.group === 'conflicts' ? 'file' : 'diff', side)}
                onKeyDown={(e) => onRowKey(e, it, index, groupKey)}
              />
              <span className="change-actions">
                {it.group === 'unstaged' && (
                  <button className="icon-button small" title={it.entry.status === 'U' ? 'Delete…' : 'Discard changes…'} aria-label="Discard" onClick={() => askDiscard(rowKey, [it.entry])}>
                    <DiscardIcon size={14} />
                  </button>
                )}
                {it.group === 'conflicts' ? (
                  <GroupMenu items={it.entry.code?.includes('D') ? [
                    { label: 'Keep the file', run: () => resolveRow(it, 'keep') },
                    { label: 'Delete it', run: () => resolveRow(it, 'delete') },
                    { label: 'Open', disabled: !it.inside, run: () => onOpen(it.rel, 'file', side) },
                    { label: 'Open in resolver', disabled: !it.inside, run: () => onOpen(it.rel, 'resolver', side) },
                  ] : [
                    { label: 'Take yours', run: () => resolveRow(it, 'yours') },
                    { label: 'Take incoming', run: () => resolveRow(it, 'incoming') },
                    { label: 'Open', disabled: !it.inside, run: () => onOpen(it.rel, 'file', side) },
                    { label: 'Open in resolver', disabled: !it.inside, run: () => onOpen(it.rel, 'resolver', side) },
                  ]} />
                ) : it.group === 'staged' ? (
                  <button className="icon-button small" title="Unstage (Space)" aria-label="Unstage" disabled={busy.has(rowKey)} onClick={() => unstage([it.entry.path], rowKey)}>
                    <MinusIcon size={14} />
                  </button>
                ) : (
                  <button
                    className="icon-button small"
                    title="Stage (Space)"
                    aria-label="Stage"
                    disabled={busy.has(rowKey)}
                    onClick={() => stage([it.entry.path], rowKey)}
                  >
                    <PlusIcon size={14} />
                  </button>
                )}
                {it.inside && it.group !== 'conflicts' && it.entry.status !== 'D' && (
                  <button className="icon-button small" title="Open the file" aria-label="Open the file" onClick={() => onOpen(it.rel, 'file', 'head')}>
                    <FileIcon size={14} />
                  </button>
                )}
              </span>
            </div>
            {confirmStrip(rowKey)}
            </Fragment>
          );
        })}
      </div>
    );
  };

  const outsideItems = outside.filter((g) => g.items.length > 0);

  return (
    <div className="changes">
      <BranchLine status={status} agentId={agentId} busy={remoteBusy} onAction={(action, remote) => void doRemote(action, remote)} onCancel={() => void gitApi.cancel(agentId)} onWritten={onWritten} onResult={onResult} onCompare={onCompare} />
      {status.operation && <OperationBanner status={status} busy={operationBusy} onAction={(action) => void doOperation(action)} onAsk={askAgent} />}
      <div className="changes-list" ref={listRef}>
        {total === 0 && <p className="files-note">No changes. Working tree clean.</p>}
        {inside.map((g) => renderGroup(g.group, g.items, 'in'))}
        {outsideCount > 0 && (
          <div className="change-group" role="group" aria-label="Outside this folder">
            <button className="change-group-head fold" aria-expanded={outsideOpen} onClick={() => setOutsideOpen(!outsideOpen)} title="Changes elsewhere in the repository. A commit takes what is staged here too.">
              <Chevron open={outsideOpen} size={13} />
              <span className="change-group-label">Outside this folder · {outsideCount}</span>
            </button>
            {outsideOpen && outsideItems.map((g) => renderGroup(g.group, g.items, 'out'))}
          </div>
        )}
      </div>
      <CommitBox key={repoTop(rootPath, prefix)} agentId={agentId} top={repoTop(rootPath, prefix)} status={status} result={result} onResult={onResult} onWritten={onWritten} onSync={() => void doRemote('sync')} onRemoteBusy={setRemoteBusy} mergeMessage={mergeMessage} />
    </div>
  );
}

function ChangeRow({
  item,
  groupKey,
  index,
  onClick,
  onKeyDown,
}: {
  item: Item;
  groupKey: string;
  index: number;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { entry } = item;
  const dir = dirName(item.rel);
  const conflict = item.group === 'conflicts';
  const title = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : item.inside ? item.rel : `${entry.path} · outside the agent's folder, so its diff doesn't open here`;
  return (
    <button
      className={`file-row flat change-main${entry.status === 'D' ? ' deleted' : ''}`}
      data-group={groupKey}
      data-index={index}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
      // A button clicks on Space's keyup; Space stages here instead.
      onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
    >
      <span className={`git-letter mono lead${conflict ? ' conflict' : ''}`} title={conflict ? `Conflict${entry.code ? ` (${entry.code})` : ''}` : letterTitle(entry.status)}>
        {entry.status}
      </span>
      {item.inside ? (
        <>
          <span className="file-name">{baseName(item.rel)}</span>
          <span className="file-dir">{dir}</span>
        </>
      ) : (
        <span className="file-name file-dir-path">{entry.path}</span>
      )}
      {entry.added !== null && (
        <span className="git-lines mono">
          {entry.added > 0 || !entry.removed ? <span className="add">+{entry.added}</span> : null}
          {entry.added > 0 && entry.removed ? ' ' : ''}
          {entry.removed ? <span className="del">−{entry.removed}</span> : null}
        </span>
      )}
    </button>
  );
}

function letterTitle(letter: GitLetter): string {
  return { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Untracked', C: 'Conflict' }[letter];
}

function BranchLine({ status, agentId, busy, onAction, onCancel, onWritten, onResult, onCompare }: { status: GitStatus; agentId: string; busy: string | null; onAction: (action: 'fetch' | 'pull' | 'push' | 'sync' | 'publish', remote?: string) => void; onCancel: () => void; onWritten: (status: GitStatus | null) => void; onResult: (result: ResultLine) => void; onCompare: (range: string) => void }) {
  const [menu, setMenu] = useState(false);
  const [branches, setBranches] = useState(false);
  const [branchAt, setBranchAt] = useState({ left: 12, top: 70 });
  const [remotes, setRemotes] = useState<string[] | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const branchRef = useRef<HTMLSpanElement>(null);
  const close = useMemo(() => () => setMenu(false), []);
  useDismiss(menu, ref, close);
  useDismiss(branches, branchRef, () => setBranches(false));
  const positionBranches = () => {
    const rect = branchRef.current?.getBoundingClientRect();
    if (!rect) return;
    setBranchAt(window.innerWidth <= 420 ? { left: 12, top: 70 } : { left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)), top: rect.bottom + 4 });
  };
  useEffect(() => {
    if (!branches) return;
    window.addEventListener('resize', positionBranches);
    return () => window.removeEventListener('resize', positionBranches);
  }, [branches]);
  const name = status.branch ?? (status.head ? `detached at ${short(status.head)}` : 'detached HEAD');
  const fetched = status.fetchedAt === null ? 'Never fetched' : `Fetched ${Math.max(0, Math.floor((Date.now() - status.fetchedAt) / 60_000))} min ago`;
  const publish = () => {
    void gitApi.branches(agentId).then(({ remotes: names }) => {
      if (names.length === 1) onAction('publish', names[0]);
      else if (names.length > 1) { setRemotes(names); setMenu(true); }
      else onAction('publish');
    }).catch(() => onAction('publish'));
  };
  return (
    <div className="git-branch mono" title={status.upstream ? `${name} · tracks ${status.upstream}` : name}>
      <ForkIcon size={13} />
      <span className="git-branch-picker" ref={branchRef}>
        <button className="git-branch-name" aria-haspopup="dialog" aria-expanded={branches} onClick={() => { positionBranches(); setBranches(!branches); }}>{name} <ChevronDownIcon size={12} /></button>
        {branches && <BranchPopover at={branchAt} agentId={agentId} status={status} onWritten={onWritten} onResult={onResult} onCompare={onCompare} onClose={() => setBranches(false)} />}
      </span>
      {status.behind > 0 && (
        <span className="git-ab" title={`${plural(status.behind, 'commit')} on ${status.upstream} you don't have · ${fetched}`}>
          ↓{status.behind}
        </span>
      )}
      {status.ahead > 0 && (
        <span className="git-ab" title={`${plural(status.ahead, 'commit')} not pushed to ${status.upstream} · ${fetched}`}>
          ↑{status.ahead}
        </span>
      )}
      <span className="git-branch-actions" ref={ref}>
        {busy ? <><button className="button secondary small" disabled>{({ fetch: 'Fetching…', pull: 'Pulling…', push: 'Pushing…', sync: 'Syncing…', publish: 'Publishing…' } as Record<string, string>)[busy]}</button><button className="git-result-link" onClick={onCancel}>Cancel</button></> : <>
          <button className="button secondary small" disabled={!status.branch || !status.head} onClick={() => status.upstream ? onAction('sync') : publish()}>{status.upstream ? 'Sync' : 'Publish'}</button>
          {status.upstream && <button className="icon-button small" aria-label="More sync actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><ChevronDownIcon size={14} /></button>}
        </>}
        {menu && <Menu items={remotes && !status.upstream ? remotes.map((r) => ({ label: `Publish to ${r}`, run: () => onAction('publish', r) })) : [
          { label: 'Push', run: () => onAction('push') },
          { label: 'Pull', run: () => onAction('pull') },
          { label: 'Fetch', run: () => onAction('fetch') },
        ]} onClose={close} />}
      </span>
    </div>
  );
}

function OperationBanner({ status, busy, onAction, onAsk }: { status: GitStatus; busy: 'abort' | 'continue' | null; onAction: (action: 'abort' | 'continue') => void; onAsk: () => void }) {
  const op = status.operation!;
  const count = status.conflicts.length + status.outside.conflicts.length;
  const current = op.branch ?? status.branch ?? 'this branch';
  const incoming = op.onto ?? 'the incoming commit';
  const sentence = op.kind === 'merge' ? `Merging ${incoming} into ${current}` :
    op.kind === 'rebase' ? `Rebasing ${current} onto ${incoming}${op.step && op.total ? ` · commit ${op.step} of ${op.total}` : ''}` :
    op.kind === 'cherry-pick' ? `Cherry-picking ${incoming} into ${current}` :
    op.kind === 'revert' ? `Reverting ${incoming} on ${current}` : `Applying patches on ${current}`;
  return <div className="git-operation" role="status">
    <span className="git-operation-text"><span className="git-operation-mark" aria-hidden="true">!</span> {sentence}{count ? ` · ${plural(count, 'conflict')}` : ''}</span>
    <span className="git-operation-actions">
      {count > 0 && <button onClick={onAsk}>Ask the agent</button>}
      <button disabled={!!busy} onClick={() => onAction('abort')}>{busy === 'abort' ? 'Aborting…' : 'Abort'}</button>
      <button disabled={!!busy || count > 0} title={count ? 'Resolve and stage all conflicts before continuing' : undefined} onClick={() => onAction('continue')}>{busy === 'continue' ? 'Continuing…' : 'Continue'}</button>
    </span>
    {op.kind === 'merge' && count > 0 && <span className="git-operation-hint">Your local changes come back when the merge ends.</span>}
    <span className="git-operation-hint">{op.startedBy === 'Centurion' ? 'Started in Centurion.' : 'Started outside Centurion (agent or terminal).'}</span>
  </div>;
}

// ---------- menus ----------

type MenuItem = { label: string; hint?: string; disabled?: boolean; title?: string; run?: () => void };

export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onDown);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onDown);
    };
  }, [open, ref, close]);
}

function Menu({ items, up, onClose }: { items: MenuItem[]; up?: boolean; onClose: () => void }) {
  return (
    <div className={`menu git-menu${up ? ' up' : ''}`} role="menu">
      {items.map((it) => (
        <button
          key={it.label}
          role="menuitem"
          disabled={it.disabled}
          title={it.title}
          onClick={() => {
            onClose();
            it.run?.();
          }}
        >
          {it.label}
          {it.hint && <span className="menu-hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function GroupMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useMemo(() => () => setOpen(false), []);
  useDismiss(open, ref, close);
  return (
    <span className="menu-anchor" ref={ref}>
      <button className="icon-button small" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MoreIcon size={14} />
      </button>
      {open && <Menu items={items} onClose={close} />}
    </span>
  );
}

// ---------- commit box ----------

const LENGTH_FROM = 50;

function CommitBox({
  agentId,
  top,
  status,
  result,
  onResult,
  onWritten,
  onSync,
  onRemoteBusy,
  mergeMessage,
}: {
  agentId: string;
  top: string;
  status: GitStatus;
  result: ResultLine | null;
  onResult: (r: ResultLine | null) => void;
  onWritten: (status: GitStatus | null) => void;
  onSync: () => void;
  onRemoteBusy: (action: string | null) => void;
  mergeMessage: { text: string; at: number } | null;
}) {
  const [message, setMessageState] = useState(() => commitDrafts.read(top));
  const [amend, setAmend] = useState(false);
  const [askAll, setAskAll] = useState(false);
  const [afterCommit, setAfterCommit] = useState<'push' | 'sync' | null>(null);
  const [afterRemote, setAfterRemote] = useState<string | undefined>();
  const [remoteChoices, setRemoteChoices] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<'commit' | 'undo' | 'amend' | 'push' | 'sync' | null>(null);
  const [menu, setMenu] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** The draft put aside while Amend shows the last commit's message. */
  const saved = useRef('');
  const closeMenu = useMemo(() => () => setMenu(false), []);
  useDismiss(menu, menuRef, closeMenu);

  const setMessage = (text: string, keep = !amend) => {
    setMessageState(text);
    if (keep) commitDrafts.write(top, text);
  };

  useEffect(() => {
    if (!mergeMessage) return;
    setAmend(false);
    setMessage(mergeMessage.text, true);
    field.current?.focus();
  }, [mergeMessage?.at]);

  // The field grows with its text, from two lines to eight (the CSS caps it).
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [message]);

  const conflicts = status.conflicts.length + status.outside.conflicts.length;
  const staged = new Set([...status.staged, ...status.outside.staged].map((e) => e.path)).size;
  const changes = changeCount(status) - conflicts;
  const merging = status.operation?.kind === 'merge';
  const all = !amend && !merging && staged === 0;

  const placeholder = amend
    ? 'Message for the amended commit'
    : merging
      ? 'Message for the merge commit'
      : staged > 0
        ? `Message for ${plural(staged, 'staged file')}`
        : changes > 0
          ? `Message · commits all ${plural(changes, 'change')}`
          : 'Message · nothing to commit yet';

  const blocker =
    conflicts > 0
      ? `Resolve ${conflicts === 1 ? 'the conflict' : `${conflicts} conflicts`} first`
      : !message.trim()
        ? 'Write a message'
        : all && changes === 0
          ? 'Nothing to commit'
          : null;

  const amendBlocker = !status.head
    ? 'There is no commit to amend yet'
    : status.headPushed
      ? 'Already pushed: amending would need a force push'
      : status.operation
        ? `Finish or abort the ${status.operation.kind} first`
        : null;

  // Amend can't stay on once HEAD is pushed (a sync from a terminal, say).
  useEffect(() => {
    if (amend && amendBlocker) {
      setAmend(false);
      setMessage(saved.current, true);
    }
  }, [amendBlocker]);

  const toggleAmend = async (on: boolean) => {
    if (!on) {
      setAmend(false);
      setMessage(saved.current, true);
      return;
    }
    if (!status.head) return;
    setBusy('amend');
    try {
      const info = await gitApi.commitInfo(agentId, status.head);
      saved.current = message;
      setAmend(true);
      setMessage(info.body ? `${info.subject}\n\n${info.body}` : info.subject, false);
      field.current?.focus();
    } catch (err) {
      const f = gitFailure(err);
      onResult({ error: true, text: `Couldn't read the last commit: ${f.error}`, details: f.details, commands: [] });
    } finally {
      setBusy(null);
    }
  };

  const commit = async (withAll: boolean, after: 'push' | 'sync' | null = afterCommit, chosenRemote = afterRemote) => {
    setAskAll(false);
    setBusy('commit');
    const count = changes;
    try {
      const r = await gitApi.commit(agentId, { message, amend, all: withAll });
      onWritten(r.status);
      saved.current = '';
      setAmend(false);
      setMessage('', true);
      let commands = r.commands;
      let remoteText = '';
      if (after) {
        setBusy(after);
        onRemoteBusy(after);
        try {
          const action = !r.status?.upstream ? 'publish' : after;
          const remote = await gitApi.remote(agentId, action, chosenRemote);
          onWritten(remote.status);
          commands = [...commands, ...remote.commands];
          remoteText = ` · ${remoteResult(action, remote).text.toLowerCase()}`;
        } catch (err) {
          const f = gitFailure(err);
          onResult({ error: true, text: `Committed ${short(r.hash)} · ${f.error}`, details: f.details, commands: [...commands, ...f.commands], sync: f.error === 'The remote has new commits' });
          return;
        } finally {
          onRemoteBusy(null);
        }
      }
      onResult(amend
        ? { error: false, text: `Amended the last commit · now ${short(r.hash)}${remoteText}`, details: '', commands }
        : { error: false, text: `Committed ${short(r.hash)}${withAll ? ` · all ${plural(count, 'change')}` : ''}${remoteText}`, details: '', commands, undo: after ? undefined : r.hash });
    } catch (err) {
      const f = gitFailure(err);
      onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally {
      setBusy(null);
    }
  };

  const start = (after: 'push' | 'sync' | null = null, chosenRemote?: string) => {
    if (blocker || busy) return;
    if (after && !status.upstream && !chosenRemote) {
      void gitApi.branches(agentId).then(({ remotes }) => {
        if (remotes.length > 1) { setAfterCommit(after); setRemoteChoices(remotes); setMenu(true); }
        else if (remotes.length === 1) start(after, remotes[0]);
        else onResult({ error: true, text: 'Add a remote before publishing this branch', details: '', commands: [] });
      }).catch((err) => onResult(remoteFailure(err)));
      return;
    }
    setAfterCommit(after);
    setAfterRemote(chosenRemote);
    setRemoteChoices(null);
    if (all && !commitAllAlways.get()) setAskAll(true);
    else void commit(all, after, chosenRemote);
  };

  const undo = async (hash: string) => {
    setBusy('undo');
    try {
      const r = await gitApi.undoCommit(agentId, hash);
      onWritten(r.status);
      onResult({ error: false, text: `Undid commit ${short(r.undone)} · its changes are staged and its message is back`, details: '', commands: r.commands });
      const current = amend ? saved.current : message;
      if (amend) setAmend(false);
      setMessage(current.trim() ? `${r.message}\n\n${current}` : r.message, true);
      field.current?.focus();
    } catch (err) {
      const f = gitFailure(err);
      onResult({ error: true, text: f.error, details: f.details, commands: f.commands });
    } finally {
      setBusy(null);
    }
  };

  const firstLine = message.split('\n', 1)[0].length;

  return (
    <div className="commit-box">
      <div className="commit-field">
        <textarea
          ref={field}
          rows={2}
          value={message}
          placeholder={placeholder}
          aria-label="Commit message"
          spellCheck
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              start(e.shiftKey ? 'push' : null);
            } else continueList(e);
          }}
        />
        {firstLine >= LENGTH_FROM && (
          <span className="commit-length mono" title="Length of the first line: under 50 or so reads best in git log">
            {firstLine}
          </span>
        )}
      </div>
      {askAll && (
        <div className="rewind-confirm commit-ask" role="group" aria-label="Commit all">
          <span>Nothing is staged. Commit all {plural(changes, 'change')}?</span>
          <button className="button secondary small" onClick={() => setAskAll(false)}>
            Cancel
          </button>
          <button
            className="button secondary small"
            title="Commit everything whenever nothing is staged, without asking again in this browser"
            onClick={() => {
              commitAllAlways.set(true);
              void commit(true);
            }}
          >
            Always
          </button>
          <button className="button primary small" autoFocus onClick={() => void commit(true)} onKeyDown={(e) => e.key === 'Escape' && setAskAll(false)}>
            Commit all
          </button>
        </div>
      )}
      <div className="commit-row">
        <label className={`commit-amend${amendBlocker ? ' disabled' : ''}`} title={amendBlocker ?? 'Change the last commit: its message, and what is staged now'}>
          <input type="checkbox" checked={amend} disabled={amendBlocker !== null || busy !== null} onChange={(e) => void toggleAmend(e.target.checked)} />
          Amend
        </label>
        <div className="split-button menu-anchor" ref={menuRef}>
          <button className="button primary small split-main" disabled={blocker !== null || busy !== null} title={blocker ?? `${amend ? 'Amend the last commit' : 'Commit'} (Ctrl+Enter)`} onClick={() => start()}>
            {busy === 'commit' ? (amend ? 'Amending…' : 'Committing…') : busy === 'push' ? 'Pushing…' : busy === 'sync' ? 'Syncing…' : amend ? 'Amend' : all && changes > 0 ? 'Commit all' : 'Commit'}
          </button>
          <button className="button primary small split-more" aria-label="More commit actions" aria-haspopup="menu" aria-expanded={menu} disabled={busy !== null} onClick={() => setMenu(!menu)}>
            <ChevronDownIcon size={14} />
          </button>
          {menu && (
            <Menu
              up
              onClose={closeMenu}
              items={remoteChoices ? remoteChoices.map((r) => ({ label: `Commit and ${afterCommit === 'sync' ? 'Sync' : 'Push'} to ${r}`, run: () => start(afterCommit, r) })) : [
                { label: 'Commit and Push', disabled: blocker !== null, title: blocker ?? undefined, run: () => start('push') },
                { label: 'Commit and Sync', disabled: blocker !== null, title: blocker ?? undefined, run: () => start('sync') },
              ]}
            />
          )}
        </div>
      </div>
      {result && <ResultView result={result} undoing={busy === 'undo'} onUndo={(h) => void undo(h)} onDismiss={() => onResult(null)} onSync={onSync} />}
    </div>
  );
}

export function ResultView({ result, undoing, onUndo, onDismiss, onSync }: { result: ResultLine; undoing: boolean; onUndo: (hash: string) => void; onDismiss: () => void; onSync?: () => void }) {
  const [open, setOpen] = useState(false);
  // A new result starts folded.
  useEffect(() => setOpen(false), [result]);
  const hasDetails = result.commands.length > 0 || result.details !== '';
  return (
    <div className={`git-result${result.error ? ' error' : ''}`} role={result.error ? 'alert' : 'status'}>
      <div className="git-result-line">
        <span className="git-result-text">{result.text}</span>
        {result.sync && onSync && <button className="git-result-link" onClick={onSync}>Sync</button>}
        {result.undo && (
          <span className="git-result-action">
            <span className="git-result-sep">·</span>
            <button className="git-result-link" disabled={undoing} title="Take the commit back: its changes stay staged" onClick={() => onUndo(result.undo!)}>
              {undoing ? 'Undoing…' : 'Undo'}
            </button>
          </span>
        )}
        {hasDetails && (
          <span className="git-result-action">
            <span className="git-result-sep">·</span>
            <button className="git-result-link" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide details' : 'Details'}
            </button>
          </span>
        )}
        {result.error && (
          <button className="git-result-link git-result-close" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
            ×
          </button>
        )}
      </div>
      {open && (
        <div className="git-details mono">
          {result.commands.map((c, i) => (
            <div key={i} className="git-command">
              <div className="git-command-line">
                $ {c.command}
                {c.code !== 0 && <span className="git-command-code"> · exit {c.code}</span>}
              </div>
              {c.output && <pre>{c.output}</pre>}
            </div>
          ))}
          {result.commands.length === 0 && result.details && <pre>{result.details}</pre>}
        </div>
      )}
    </div>
  );
}
