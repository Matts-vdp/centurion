// Pure helpers for track plans and question sets: validation and the messages the user's decisions
// turn into. The Manager owns the state and calls these.
import type { Answer, LaterRound, Plan, QuestionSet, Track, TrackTarget, UserQuestion } from './types.js';

export type ProposeInput = {
  round: number;
  title: string;
  tracks: { id: string; title: string; summary: string; target: TrackTarget; model?: string; effort?: string }[];
  later?: LaterRound[];
};

export type AskInput = {
  title: string;
  questions: {
    id: string;
    from?: string;
    question: string;
    context?: string;
    kind?: 'single' | 'multi' | 'text';
    options?: { label: string; detail?: string; suggested?: boolean }[];
  }[];
  resolved?: { id: string; from?: string; question: string; answer: string; source?: string }[];
  routed?: { id: string; from?: string; question: string; expertId: string }[];
};

export function checkUniqueIds(ids: string[], what: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id.trim()) throw new Error(`Every ${what} needs an id`);
    if (seen.has(id)) throw new Error(`Duplicate ${what} id "${id}"`);
    seen.add(id);
  }
}

export function toTracks(input: ProposeInput['tracks']): Track[] {
  if (input.length === 0) throw new Error('A plan needs at least one track');
  checkUniqueIds(
    input.map((t) => t.id),
    'track',
  );
  return input.map((t) => ({
    id: t.id,
    title: t.title,
    summary: t.summary,
    target: t.target,
    ...(t.model ? { model: t.model } : {}),
    ...(t.effort ? { effort: t.effort } : {}),
  }));
}

export const currentVersion = (plan: Plan) => plan.versions[plan.versions.length - 1];

/** Tracks that get an expert (subagent tracks run inside the orchestrator). */
export function expertTracks(plan: Plan): string[] {
  const tracks = currentVersion(plan).tracks.filter((t) => t.target.kind !== 'subagent').map((t) => t.id);
  return plan.chosen ? tracks.filter((id) => plan.chosen!.includes(id)) : tracks;
}

/** What Start sends: only the checkbox state, never composer text. */
export function startMessage(plan: Plan, start: string[], skip: string[]): string {
  const v = currentVersion(plan);
  const label = (id: string) => {
    const n = v.tracks.findIndex((t) => t.id === id);
    return `${n + 1}. ${v.tracks[n].title} (track_id "${id}")`;
  };
  const lines = [`Start round ${plan.round} of "${v.title}" (plan v${v.version}) with ${start.length} of ${v.tracks.length} tracks:`];
  for (const id of start) lines.push(`- ${label(id)}`);
  if (skip.length) {
    lines.push('', 'Skip:');
    for (const id of skip) lines.push(`- ${label(id)}`);
  }
  return lines.join('\n');
}

export function toQuestions(input: AskInput['questions']): UserQuestion[] {
  return input.map((q) => {
    const options = q.options ?? [];
    return {
      id: q.id,
      ...(q.from ? { from: q.from } : {}),
      question: q.question,
      ...(q.context ? { context: q.context } : {}),
      kind: q.kind ?? (options.length ? 'single' : 'text'),
      options,
    };
  });
}

export type AnswerInput = { questionId: string; choices?: string[]; text?: string };
export type CorrectionInput = { questionId: string; text: string };

/** Store the answers and corrections; returns the message for the orchestrator. */
export function applyAnswers(set: QuestionSet, answers: AnswerInput[], corrections: CorrectionInput[]): string {
  const at = new Date().toISOString();
  const lines = [`Answers to "${set.title}" (question set ${set.id}):`];
  for (const a of answers) {
    const q = set.questions.find((x) => x.id === a.questionId);
    if (!q) throw new Error(`Unknown question "${a.questionId}"`);
    const choices = (a.choices ?? []).filter((c) => q.options.some((o) => o.label === c));
    const text = (a.text ?? '').trim();
    if (choices.length === 0 && !text) throw new Error(`The answer to "${a.questionId}" is empty`);
    if (q.kind === 'single' && choices.length > 1) throw new Error(`"${a.questionId}" takes one choice`);
    const changed = q.answer !== undefined;
    q.answer = { choices, text, at } satisfies Answer;
    lines.push(`- ${q.id}${changed ? ' (changed)' : ''}: ${q.question}`, `  Answer: ${[...choices, text].filter(Boolean).join('; ')}`);
  }
  if (corrections.length) {
    lines.push('', 'Corrections to your answers:');
    for (const c of corrections) {
      const r = set.resolved.find((x) => x.id === c.questionId);
      if (!r) throw new Error(`Unknown answered question "${c.questionId}"`);
      if (!c.text.trim()) throw new Error(`The correction to "${c.questionId}" is empty`);
      r.correction = { text: c.text.trim(), at };
      lines.push(`- ${r.id}: ${r.question}`, `  You answered: ${r.answer}`, `  Correction: ${c.text.trim()}`);
    }
  }
  const open = set.questions.filter((q) => !q.answer).length;
  set.status = open === 0 ? 'answered' : 'open';
  if (open) lines.push('', `${open} question${open === 1 ? ' is' : 's are'} still open; the user may answer later.`);
  set.updatedAt = at;
  return lines.join('\n');
}
