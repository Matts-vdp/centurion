import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { commands, type AgentRecord, type AnswerPayload, type QuestionSet, type UserQuestion } from './api';
import { expertStatus } from './Delegation';
import { ChatIcon, CheckIcon, Chevron, OpenIcon } from './icons';
import { AgentMark } from './Mark';
import { agentState, clock, folderName } from './status';
import { lastSeen, store, useManager } from './store';

type Props = {
  setId: string;
  orchestrator: AgentRecord;
  agents: Map<string, AgentRecord>;
  now: number;
  onSelect: (id: string) => void;
  run: (a: () => Promise<unknown>) => Promise<void>;
};

type Draft = { choices: string[]; text: string };

const emptyDraft: Draft = { choices: [], text: '' };
const isReady = (d: Draft | undefined) => !!d && (d.choices.length > 0 || d.text.trim() !== '');

/**
 * A question set (docs/ui-design.md, section 9): every question visible in one object, answered with
 * clicks. Send delivers only the answers; the composer never carries them.
 */
export function QuestionSetView({ setId, orchestrator, agents, now, onSelect, run }: Props) {
  const { questionSets } = useManager();
  const set = questionSets.get(setId);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => readDrafts(setId).drafts);
  const [corrections, setCorrections] = useState<Record<string, string>>(() => readDrafts(setId).corrections);
  const [editing, setEditing] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => writeDrafts(setId, drafts, corrections), [setId, drafts, corrections]);

  if (!set) return null;
  // In a fork, the questions stay with the chat that asked them.
  if (set.orchestratorId !== orchestrator.id || set.status === 'dropped') {
    const owner = agents.get(set.orchestratorId);
    return (
      <div className="foreign-object">
        Questions{set.status === 'dropped' ? ', rewound away' : owner ? ` from ${owner.name}` : ''} · {set.title}
      </div>
    );
  }
  const answeredCount = set.questions.filter((q) => q.answer).length;
  const total = set.questions.length;

  // The user replied in the chat instead: one line, still answerable once opened.
  const setAside = set.status === 'chat';
  if (setAside && !expanded && Object.keys(corrections).length === 0) {
    return (
      <button className="questions-folded set-aside" onClick={() => setExpanded(true)} title="You replied in the chat. Open to answer here anyway.">
        <ChatIcon size={14} />
        <span className="questions-folded-title">{set.title}</span>
        <span className="questions-folded-meta">· answered in the chat</span>
        <Chevron open={false} size={14} />
      </button>
    );
  }

  // Everything answered: one line that opens on click.
  if (set.status === 'answered' && !expanded && Object.keys(corrections).length === 0) {
    const routedDone = set.routed.filter((q) => q.answer).length;
    const parts = [`${total} by you`];
    if (set.resolved.length) parts.push(`${set.resolved.length} by ${orchestrator.name}`);
    if (set.routed.length) parts.push(`${routedDone} of ${set.routed.length} by other repos`);
    return (
      <button className="questions-folded" onClick={() => setExpanded(true)}>
        <CheckIcon size={14} />
        <span className="questions-folded-title">{set.title}</span>
        <span className="questions-folded-meta">· {parts.join(', ')}</span>
        <Chevron open={false} size={14} />
      </button>
    );
  }

  const setDraft = (id: string, d: Draft) => setDrafts((prev) => ({ ...prev, [id]: d }));
  const open = set.questions.filter((q) => !q.answer || editing.has(q.id));
  const ready = open.filter((q) => isReady(drafts[q.id]));
  const correctionList = Object.entries(corrections).filter(([, text]) => text.trim());
  const sendCount = ready.length + correctionList.length;

  const send = async () => {
    setBusy(true);
    const answers: AnswerPayload[] = ready.map((q) => ({ questionId: q.id, choices: drafts[q.id].choices, text: drafts[q.id].text.trim() }));
    await run(async () => {
      const updated = await commands.answerQuestions(
        set.id,
        answers,
        correctionList.map(([questionId, text]) => ({ questionId, text: text.trim() })),
      );
      store.upsertQuestions(updated);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const a of answers) delete next[a.questionId];
        return next;
      });
      setCorrections({});
      setEditing(new Set());
    });
    setBusy(false);
  };

  return (
    <section className="questions" aria-label={set.title}>
      <div className="plan-head">
        <h3 className="plan-title">{set.title}</h3>
        <span className={`plan-state${answeredCount < total && !setAside ? ' waiting' : ''}`}>
          {setAside ? 'Answered in the chat · ' : ''}
          {answeredCount} of {total} answered
        </span>
        {(set.status === 'answered' || setAside) && (
          <button className="icon-button" aria-label="Fold" onClick={() => setExpanded(false)}>
            <Chevron open size={14} />
          </button>
        )}
      </div>
      <div className="plan-progress" aria-hidden="true">
        {set.questions.map((q) => (
          <span key={q.id} className={`segment ${q.answer ? 'done' : isReady(drafts[q.id]) ? 'ready' : 'pending'}`} />
        ))}
      </div>

      <div className="question-list">
        {set.questions.map((q, i) =>
          q.answer && !editing.has(q.id) ? (
            <AnsweredQuestion key={q.id} q={q} onChange={() => setEditing((prev) => new Set(prev).add(q.id))} />
          ) : (
            <OpenQuestion
              key={q.id}
              q={q}
              index={i}
              draft={drafts[q.id] ?? (q.answer ? { choices: q.answer.choices, text: q.answer.text } : emptyDraft)}
              onDraft={(d) => setDraft(q.id, d)}
              asker={q.from ? agents.get(q.from) : undefined}
            />
          ),
        )}
      </div>

      {set.resolved.length > 0 && (
        <Group label={`Answered by ${orchestrator.name}`} count={set.resolved.length}>
          {set.resolved.map((r) => {
            const correcting = r.id in corrections;
            return (
              <div key={r.id} className="side-question">
                <div className="side-q">{r.question}</div>
                <div className="side-a">{r.answer}</div>
                <div className="side-meta">
                  {r.source && <span>from {r.source}</span>}
                  {r.correction && <span>you corrected it at {clock(r.correction.at)}: {r.correction.text}</span>}
                  {!correcting && (
                    <button className="link-button" onClick={() => setCorrections((prev) => ({ ...prev, [r.id]: '' }))}>
                      Correct
                    </button>
                  )}
                </div>
                {correcting && (
                  <div className="correction">
                    <textarea
                      rows={2}
                      autoFocus
                      placeholder="What is the right answer?"
                      value={corrections[r.id]}
                      onChange={(e) => setCorrections((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    />
                    <button
                      className="link-button"
                      onClick={() =>
                        setCorrections((prev) => {
                          const next = { ...prev };
                          delete next[r.id];
                          return next;
                        })
                      }
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </Group>
      )}

      {set.routed.length > 0 && (
        <Group label="Sent to another repo" count={set.routed.length}>
          {set.routed.map((r) => {
            const expert = agents.get(r.expertId);
            return (
              <div key={r.id} className="side-question">
                <div className="side-q">{r.question}</div>
                {expert && <RoutedStatus expert={expert} since={Date.parse(set.createdAt)} answer={r.answer} agents={agents} now={now} onSelect={onSelect} />}
              </div>
            );
          })}
        </Group>
      )}

      {(open.length > 0 || correctionList.length > 0) && (
        <div className="plan-foot">
          <span className="plan-foot-text">
            {ready.length} of {open.length} ready.{ready.length < open.length ? ' Unanswered questions stay open here.' : ''}
            <span className="questions-keys">
              <kbd className="key">1</kbd>–<kbd className="key">4</kbd> picks · <kbd className="key">Tab</kbd> next question
            </span>
          </span>
          <button className="button primary" disabled={sendCount === 0 || busy} onClick={() => void send()}>
            Send {sendCount} answer{sendCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
    </section>
  );
}

function OpenQuestion({
  q,
  index,
  draft,
  onDraft,
  asker,
}: {
  q: UserQuestion;
  index: number;
  draft: Draft;
  onDraft: (d: Draft) => void;
  asker: AgentRecord | undefined;
}) {
  const pick = (label: string) => {
    if (q.kind === 'multi') {
      const has = draft.choices.includes(label);
      onDraft({ ...draft, choices: has ? draft.choices.filter((c) => c !== label) : [...draft.choices, label] });
    } else {
      // One choice: picking an option replaces a free answer, and the other way round.
      onDraft({ choices: draft.choices[0] === label ? [] : [label], text: '' });
    }
  };

  // 1–9 pick an option while focus is in this question (not in its text field).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (n >= 1 && n <= q.options.length) {
      e.preventDefault();
      pick(q.options[n - 1].label);
    }
  };

  return (
    <div className="question" onKeyDown={onKey}>
      {asker && (
        <div className="question-asker">
          <AgentMark agent={asker} size={18} />
          <span>{asker.name} asks</span>
        </div>
      )}
      <div className="question-text" id={`q-${q.id}`}>
        <span className="plan-num mono">{index + 1}</span>
        {q.question}
      </div>
      {q.context && <div className="question-context">{q.context}</div>}
      {q.kind === 'single' && q.options.length > 0 && (
        <div className="options" role="radiogroup" aria-labelledby={`q-${q.id}`}>
          {q.options.map((o, i) => {
            const on = draft.choices.includes(o.label);
            return (
              <label key={o.label} className={`option${on ? ' on' : ''}`}>
                <input type="radio" name={`q-${q.id}`} checked={on} onChange={() => pick(o.label)} onClick={() => on && pick(o.label)} />
                <span className="option-text">
                  <span className="option-label">
                    {o.label}
                    {o.suggested && <span className="suggested">suggested</span>}
                  </span>
                  {o.detail && <span className="option-detail">{o.detail}</span>}
                </span>
                {i < 9 && <kbd className="key">{i + 1}</kbd>}
              </label>
            );
          })}
        </div>
      )}
      {q.kind === 'multi' && q.options.length > 0 && (
        <div className="chips" aria-labelledby={`q-${q.id}`}>
          {q.options.map((o) => {
            const on = draft.choices.includes(o.label);
            return (
              <button key={o.label} className={`chip-toggle${on ? ' on' : ''}`} aria-pressed={on} title={o.detail} onClick={() => pick(o.label)}>
                {on && <CheckIcon size={13} />}
                {o.label}
                {o.suggested && <span className="suggested">suggested</span>}
              </button>
            );
          })}
        </div>
      )}
      {q.kind === 'text' ? (
        <textarea
          className="question-free"
          rows={2}
          placeholder="Your answer"
          value={draft.text}
          aria-labelledby={`q-${q.id}`}
          onChange={(e) => onDraft({ ...draft, text: e.target.value })}
        />
      ) : (
        <input
          type="text"
          className="question-free"
          placeholder={q.kind === 'multi' ? 'Add something…' : 'Something else…'}
          value={draft.text}
          aria-label="Something else"
          onChange={(e) => onDraft({ choices: q.kind === 'single' && e.target.value ? [] : draft.choices, text: e.target.value })}
        />
      )}
    </div>
  );
}

function AnsweredQuestion({ q, onChange }: { q: UserQuestion; onChange: () => void }) {
  const answer = [...(q.answer?.choices ?? []), q.answer?.text ?? ''].filter(Boolean).join('; ');
  return (
    <div className="question answered">
      <span className="answered-check">
        <CheckIcon size={13} />
      </span>
      <span className="answered-text">
        <span className="answered-q">{q.question}</span>
        <span className="answered-a">{answer}</span>
      </span>
      <button className="link-button" onClick={onChange}>
        Change
      </button>
    </div>
  );
}

function Group({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`side-group${open ? ' open' : ''}`}>
      <button className="side-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron open={open} size={14} />
        <span>
          {label} · {count}
        </span>
      </button>
      {open && <div className="side-group-body">{children}</div>}
    </div>
  );
}

function RoutedStatus({
  expert,
  since,
  answer,
  agents,
  now,
  onSelect,
}: {
  expert: AgentRecord;
  since: number;
  answer?: { text: string; at: string };
  agents: Map<string, AgentRecord>;
  now: number;
  onSelect: (id: string) => void;
}) {
  const { activity } = useManager();
  const seen = lastSeen.use();
  const s = expertStatus(expert, since, true, now, (a) => agentState(a, agents, seen, activity.get(a.id), now).sentence);
  return (
    <>
      <div className="side-meta">
        <AgentMark agent={expert} state={answer ? 'unread' : s.state} size={18} />
        <span className="side-expert">{expert.name}</span>
        <span className="mono">{folderName(expert.cwd)}</span>
        {!answer && <span className={`status-${s.tone}`}>{s.text}</span>}
        <button className="link-button" onClick={() => onSelect(expert.id)}>
          Open <OpenIcon size={12} />
        </button>
      </div>
      {answer && <div className="side-a">{answer.text}</div>}
    </>
  );
}

// Drafts survive switching agents and reloads within the tab.
function readDrafts(setId: string): { drafts: Record<string, Draft>; corrections: Record<string, string> } {
  try {
    const raw = sessionStorage.getItem(`centurion-answers:${setId}`);
    if (raw) return JSON.parse(raw);
  } catch {
    // ignore
  }
  return { drafts: {}, corrections: {} };
}

function writeDrafts(setId: string, drafts: Record<string, Draft>, corrections: Record<string, string>): void {
  try {
    if (Object.keys(drafts).length || Object.keys(corrections).length) {
      sessionStorage.setItem(`centurion-answers:${setId}`, JSON.stringify({ drafts, corrections }));
    } else sessionStorage.removeItem(`centurion-answers:${setId}`);
  } catch {
    // drafts are a convenience only
  }
}
