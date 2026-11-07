import path from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { resolveInside } from './files.js';
import type { Manager } from './manager.js';
import type { AgentRecord } from './types.js';
import { formatIssues, parseVisual, visualCards, VISUAL_ICONS, VISUAL_LIMITS, VISUAL_TONES, type VisualIssue } from './visual.js';

const L = VISUAL_LIMITS;

const DESCRIPTION = `Show the user a small visual in the chat, drawn in the app's own style: a flow of steps, a result, options side by side, a few key numbers, how parts of a system connect. Use it when structure is the point and a picture says it faster than paragraphs. Don't use it for decoration, for a single fact, or instead of an answer: write your explanation as usual and put the visual where it helps. It returns at once; carry on with your reply. For bigger diagrams (many nodes, arrows that loop back, sequence diagrams, state machines, data models), write a \`\`\`mermaid code block in your reply instead; the app renders it.

Markup: three elements, JSX-like but only string attributes and flags, never code.
- <Column> children top to bottom. <Row> children side by side (at most ${L.rowChildren}; they stack on narrow screens).
  Both take the flag arrows (an arrow from each child to the next). A Row directly inside an arrowed Column is a branch: the arrow fans out to each of its children.
- <Card title="…"> a box. Optional: icon, tone, badge="short tag", value="42" (a key number; the title becomes its label), repo="repo name", link, arrow. Text inside the tag is its body (plain text, \`code\` allowed, under ${L.text} characters). Cards inside a card become its rows (a one-line card is a plain line, one with text a soft tile): use that for lists, findings and grouped items.
- arrow="label" labels the arrow coming INTO that element from the previous sibling (so never on the first child), or on each child of a branch Row its own arrow. Keep labels under ${L.arrow} characters.
- tone: ${VISUAL_TONES.join(', ')} (no tone means neutral). Use it only for meaning: ok = done/good, bad = failed/risk, warn = caution, running = in progress, accent = the recommended or new thing. Never pick colours yourself.
- link: expert:<name> (one of your experts, or your chat), file:<path> (relative to your folder), or an https URL. The user can click it.
- icon: one of ${VISUAL_ICONS.join(', ')}.
Limits: ${L.depth} levels of nesting, ${L.elements} elements, titles under ${L.title} characters. Several elements at the top level stack.

Examples:
<Column arrows>
  <Card icon="monitor" title="Web app">Sends the login form</Card>
  <Card icon="key-round" title="Auth service" repo="auth" arrow="POST /login">Checks the password, issues a token</Card>
  <Row>
    <Card icon="server" title="API" arrow="valid token" />
    <Card icon="circle-x" title="401 page" tone="bad" arrow="expired" />
  </Row>
</Column>

<Card icon="circle-check" tone="ok" title="Auth fix merged" badge="PR 42" link="file:src/auth/refresh.ts">
  Token refresh no longer races the logout call.
  <Card icon="flask-conical" title="128 tests passed" />
  <Card icon="file-diff" title="4 files changed" />
</Card>

<Row>
  <Card title="Redis" badge="Recommended" tone="accent">
    <Card icon="check" tone="ok" title="Survives restarts" />
    <Card icon="x" tone="bad" title="Needs a new service" />
  </Card>
  <Card title="In memory">
    <Card icon="x" tone="bad" title="Lost on restart" />
    <Card icon="check" tone="ok" title="No setup" />
  </Card>
</Row>`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError } : {}) });

/** `show_visual`, for every agent. One server per agent, so links are checked against that agent's experts and folders. */
export function createDisplayTools(manager: Manager, agentId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'display',
    version: '0.1.0',
    alwaysLoad: true,
    tools: [
      tool(
        'show_visual',
        DESCRIPTION,
        {
          title: z.string().optional().describe('A few words above the visual. Optional.'),
          markup: z.string().describe('The visual markup: Row, Column and Card elements.'),
        },
        async (args) => {
          const parsed = parseVisual(args.markup);
          const errors = [...parsed.errors];
          if (errors.length === 0) errors.push(...(await checkLinks(manager, agentId, parsed.nodes)));
          if (errors.length) {
            return text(`The visual was not shown. Fix these and call show_visual again:\n${formatIssues(errors)}`, true);
          }
          const notes = parsed.warnings.length ? `\nNotes (it was shown anyway):\n${formatIssues(parsed.warnings)}` : '';
          return text(`Shown to the user.${notes}`);
        },
      ),
    ],
  });
}

/** The agents an `expert:` link may name: the caller's chat and every expert in it. */
export function linkableAgents(manager: Manager, agentId: string): AgentRecord[] {
  const rec = manager.get(agentId);
  const root = rec.parentId ? manager.get(rec.parentId) : rec;
  return [root, ...manager.childrenOf(root.id)];
}

async function checkLinks(manager: Manager, agentId: string, nodes: ReturnType<typeof parseVisual>['nodes']): Promise<VisualIssue[]> {
  const issues: VisualIssue[] = [];
  const rec = manager.get(agentId);
  const parent = rec.parentId ? manager.get(rec.parentId) : null;
  const roots = [rec.cwd, ...(parent && path.resolve(parent.cwd) !== path.resolve(rec.cwd) ? [parent.cwd] : [])];
  for (const card of visualCards(nodes)) {
    const link = card.link;
    if (!link) continue;
    if (link.startsWith('expert:')) {
      const name = link.slice(7).trim().toLowerCase();
      const found = linkableAgents(manager, agentId).some((a) => a.id.toLowerCase() === name || a.name.toLowerCase() === name);
      if (!found) issues.push({ line: card.line, message: `${link}: no expert by that name or id in this chat.` });
    } else if (link.startsWith('file:')) {
      const p = link.slice(5).trim();
      if (!(await fileInRoots(roots, p))) issues.push({ line: card.line, message: `${link}: no such file in your folder${roots.length > 1 ? 's' : ''}.` });
    }
  }
  return issues;
}

async function fileInRoots(roots: string[], p: string): Promise<boolean> {
  for (const root of roots) {
    let rel = p;
    if (path.isAbsolute(p)) {
      rel = path.relative(root, p);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    }
    try {
      await resolveInside(root, rel);
      return true;
    } catch {
      // Not in this root.
    }
  }
  return false;
}
