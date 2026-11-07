import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { packageVersion } from './paths.js';
import { resolveInside } from './files.js';
import type { Manager } from './manager.js';
import type { AgentRecord } from './types.js';
import { formatIssues, parseVisual, splitFileLink, VISUAL_ICONS, VISUAL_LIMITS, VISUAL_TONES, walkVisual, type VisualCode, type VisualIssue, type VisualNode } from './visual.js';

const L = VISUAL_LIMITS;

const DESCRIPTION = `Show the user a small visual in the chat, drawn in the app's own style. Use it when structure is the point: options side by side while planning, hypotheses and evidence while investigating, a flow, a result, a folder layout or call tree, what happened when, a few numbers. Don't use it for decoration, for a single fact, or instead of an answer: write your explanation as usual and put the visual where it helps. It returns at once; carry on with your reply. For bigger diagrams (many nodes, arrows that loop back, sequence diagrams, state machines, data models, charts with axes, pies, gantt), write a \`\`\`mermaid code block in your reply instead; the app renders it.

Markup: JSX-like, but only string attributes and flags, never code expressions.
Boxes
- <Column> stacks children, <Row> puts them side by side (at most ${L.rowChildren}; they stack on narrow screens). The flag arrows draws an arrow from each child to the next. A Row directly inside an arrowed Column is a branch: the arrow fans out to each of its children.
- <Card title="…"> a box. Text inside the tag is its body (plain text, \`code\` allowed, under ${L.text} characters). Cards inside a card become its rows (no box of their own): use that for lists, findings, pros and cons. Optional: icon, tone, badge="short tag", meta="quiet text on the right" (a time, a size, file.ts:42), value="42" (a key number; the title becomes its label) with change="+3%", progress="60" or "3/5", repo="repo name", link, arrow.
- arrow="label" labels the arrow coming INTO that element from the previous sibling (so never on the first child), or on each child of a branch Row its own arrow. Keep labels under ${L.arrow} characters.
Lines
- <Tree> with nested <Item title="…">: folder layouts, call trees, component trees, the shape of a config. The user can fold items that have children; the flag collapsed starts one folded. Text inside an Item is a short note.
- <Timeline> with <Item when="10:42" title="…">: what happened or what comes next (an incident, a run, the PRs of a plan). Items after the one with tone="running" show as still to come. Items don't nest here.
- Item also takes icon, tone, meta and link; its note can also be note="…".
Details and evidence
- <More> inside a Card or an Item: details the user opens with a click (reasoning, evidence), so lists stay short. Text and <Code> only, under ${L.more} characters of text.
- <Code file="src/a.ts" line="40" mark="42">…</Code>: an excerpt of at most ${L.codeLines} lines, written as is (no escaping) up to </Code>. file lets the user open it; line is the file's line number of the first line; mark ("42", "42-44") highlights the lines that matter, in the same numbers. lang="diff" colours +/- lines. Copy the lines from the file: they are checked against it.
Other
- <Bars title="…" unit="ms"> with <Bar label="…" value="420" />: a few numbers compared (at most ${L.bars}).
- <Image src="file:shots/a.png" caption="…" />: an image from your folder, such as a screenshot you took.
Shared
- tone: ${VISUAL_TONES.join(', ')} (no tone means neutral). Use it only for meaning: ok = done/good, bad = failed/risk/the cause, warn = caution, running = in progress, accent = the recommended or new thing. Never pick colours yourself.
- link: file:<path> or file:<path>:<line> (relative to your folder; only for code that exists, so leave it off for planned files and library code), expert:<name> (one of your experts, or your chat), or an https URL. The user can click it.
- icon: one of ${VISUAL_ICONS.join(', ')}.
Limits: ${L.depth} levels of boxes, trees ${L.treeDepth} deep, ${L.elements} elements, titles under ${L.title} characters. Several elements at the top level stack.

Examples:
<Column arrows>
  <Card icon="monitor" title="Web app">Sends the login form</Card>
  <Card icon="key-round" title="Auth service" repo="auth" arrow="POST /login">Checks the password, issues a token</Card>
  <Row>
    <Card icon="server" title="API" arrow="valid token" />
    <Card icon="circle-x" title="401 page" tone="bad" arrow="expired" />
  </Row>
</Column>

Planning, options and how it lands:
<Row>
  <Card title="Refresh in the API client" badge="Recommended" tone="accent">
    One place catches every 401 and retries once.
    <Card icon="check" tone="ok" title="Callers don't change" />
    <Card icon="x" tone="bad" title="The client learns about auth" />
    <More>The client already sets the headers, so it holds the token anyway.</More>
  </Card>
  <Card title="Refresh in a React hook">
    <Card icon="check" tone="ok" title="Easy to follow per screen" />
    <Card icon="x" tone="bad" title="Misses background requests" />
  </Card>
</Row>
<Timeline>
  <Item when="PR 1" title="Shared refresh in the API client" />
  <Item when="PR 2" title="Remove the per-screen refreshes" />
</Timeline>

Investigating, hypotheses with evidence and the call tree:
<Card icon="search" title="Why users stay signed in after logout" badge="1 confirmed">
  <Card icon="bug" tone="bad" title="A refresh in flight writes the cookie back" meta="confirmed">
    <More>logout() cancels the refresh but doesn't wait for it.
      <Code file="src/auth/logout.ts" line="40" mark="42">
export function logout() {
  session.clear();
  refresh.cancel();
}
      </Code>
    </More>
  </Card>
  <Card icon="x" title="Cookie path mismatch" meta="ruled out" />
</Card>
<Tree>
  <Item icon="square-function" title="logout()" link="file:src/auth/logout.ts:40">
    <Item tone="bad" title="refresh.cancel()" link="file:src/auth/refresh.ts:88">Never awaited</Item>
    <Item title="router.push('/login')" meta="library" />
  </Item>
</Tree>`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

/** `show_visual` (the `display` server's tools). Links are checked against that agent's experts and folders. */
export function displayTools(manager: Manager, agentId: string) {
  return [
  tool(
    'show_visual',
    DESCRIPTION,
    {
      title: z.string().optional().describe('A few words above the visual. Optional.'),
      markup: z.string().describe('The visual markup.'),
    },
    async (args) => {
      const parsed = parseVisual(args.markup);
      const errors = [...parsed.errors];
      const warnings = [...parsed.warnings];
      if (errors.length === 0) {
        const checked = await checkReferences(manager, agentId, parsed.nodes);
        errors.push(...checked.errors);
        warnings.push(...checked.warnings);
      }
      if (errors.length) {
        return text(`The visual was not shown. Fix these and call show_visual again:\n${formatIssues(errors)}`, true);
      }
      const notes = warnings.length ? `\nNotes (it was shown anyway):\n${formatIssues(warnings)}` : '';
      return text(`Shown to the user.${notes}`);
    },
  ),
  ];
}

/** The agents an `expert:` link may name: the caller's chat and every expert in it. */
export function linkableAgents(manager: Manager, agentId: string): AgentRecord[] {
  const rec = manager.get(agentId);
  const root = rec.parentId ? manager.get(rec.parentId) : rec;
  return [root, ...manager.childrenOf(root.id)];
}

/** Links, code files and images must exist; code excerpts must match their file. */
async function checkReferences(manager: Manager, agentId: string, nodes: VisualNode[]): Promise<{ errors: VisualIssue[]; warnings: VisualIssue[] }> {
  const errors: VisualIssue[] = [];
  const warnings: VisualIssue[] = [];
  const rec = manager.get(agentId);
  const parent = rec.parentId ? manager.get(rec.parentId) : null;
  const roots = [rec.cwd, ...(parent && path.resolve(parent.cwd) !== path.resolve(rec.cwd) ? [parent.cwd] : [])];
  const where = `your folder${roots.length > 1 ? 's' : ''}`;
  const jobs: Promise<void>[] = [];

  walkVisual(nodes, (n) => {
    if ((n.type === 'card' || n.type === 'item') && n.link) {
      const link = n.link;
      if (link.startsWith('expert:')) {
        const name = link.slice(7).trim().toLowerCase();
        const found = linkableAgents(manager, agentId).some((a) => a.id.toLowerCase() === name || a.name.toLowerCase() === name);
        if (!found) errors.push({ line: n.line, message: `${link}: no expert by that name or id in this chat.` });
      } else if (link.startsWith('file:')) {
        const { path: p } = splitFileLink(link);
        jobs.push(
          findFile(roots, p).then((found) => {
            if (!found) errors.push({ line: n.line, message: `${link}: no such file in ${where}. Leave link off for code that doesn't exist yet.` });
          }),
        );
      }
    } else if (n.type === 'code' && n.file) {
      jobs.push(checkCode(roots, where, n, errors, warnings));
    } else if (n.type === 'image' && n.src) {
      const p = n.src.slice(5).trim();
      jobs.push(
        findFile(roots, p).then((found) => {
          if (!found) errors.push({ line: n.line, message: `${n.src}: no such image in ${where}.` });
        }),
      );
    }
  });
  await Promise.all(jobs);
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);
  return { errors, warnings };
}

/** The file must exist; with a line number, the excerpt must match the file there (a warning: it may have changed). */
async function checkCode(roots: string[], where: string, code: VisualCode, errors: VisualIssue[], warnings: VisualIssue[]): Promise<void> {
  const file = await findFile(roots, code.file!);
  if (!file) {
    errors.push({ line: code.line, message: `file="${code.file}": no such file in ${where}. Leave file off for code that doesn't exist yet.` });
    return;
  }
  if (code.start === undefined || code.lang === 'diff') return;
  try {
    if ((await stat(file)).size > 2_000_000) return;
    const lines = (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n').split('\n');
    if (code.start > lines.length) {
      warnings.push({ line: code.line, message: `line="${code.start}" is past the end of ${code.file} (${lines.length} lines).` });
      return;
    }
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const wrong: number[] = [];
    for (const [i, l] of code.code.split('\n').entries()) {
      if (/^\s*(\.\.\.|…)\s*$/.test(l)) break; // an elision: the rest no longer lines up
      if (norm(l) !== norm(lines[code.start - 1 + i] ?? '')) wrong.push(code.start + i);
    }
    if (wrong.length) {
      warnings.push({
        line: code.line,
        message: `the code doesn't match ${code.file} at line${wrong.length > 1 ? 's' : ''} ${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? ', …' : ''}; copy the lines from the file and check line="…".`,
      });
    }
  } catch {
    // Unreadable: the existence check already passed.
  }
}

/** The absolute path of a file in one of the roots, or null. */
async function findFile(roots: string[], p: string): Promise<string | null> {
  for (const root of roots) {
    let rel = p;
    if (path.isAbsolute(p)) {
      rel = path.relative(root, p);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    }
    try {
      const full = await resolveInside(root, rel);
      if ((await stat(full)).isFile()) return full;
    } catch {
      // Not in this root.
    }
  }
  return null;
}

/** The `display` tool server for one agent. */
export function createDisplayTools(manager: Manager, agentId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: 'display', version: packageVersion, alwaysLoad: true, tools: displayTools(manager, agentId) });
}
