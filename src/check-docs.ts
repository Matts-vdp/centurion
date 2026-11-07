// Fails when a route, config field or tool has no docs, so the generated API and config docs stay complete.
import { describeConfig } from './config.js';
import { describeTools } from './docs.js';
import { describeRoutes, SSE_EVENTS } from './server.js';

const problems: string[] = [];
const seen = new Set<string>();
for (const r of describeRoutes()) {
  const key = `${r.method} ${r.path}`;
  if (seen.has(key)) problems.push(`${key}: listed twice`);
  seen.add(key);
  if (!r.summary.trim()) problems.push(`${key}: empty summary`);
  if (!r.result.trim()) problems.push(`${key}: empty result`);
  if (r.body !== undefined && !r.body.trim()) problems.push(`${key}: empty body description`);
}
for (const e of SSE_EVENTS) if (!e.data.trim()) problems.push(`event ${e.name}: no payload description`);
for (const f of describeConfig()) {
  if (!f.description.trim()) problems.push(`config ${f.name}: no description`);
  if (f.default === undefined) problems.push(`config ${f.name}: no default`);
}
const tools = describeTools();
for (const t of tools) if (!t.description.trim()) problems.push(`tool ${t.fullName}: no description`);

if (problems.length) {
  console.error(`Docs check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Docs check passed: ${seen.size} routes, ${SSE_EVENTS.length} events, ${describeConfig().length} config fields, ${tools.length} tools.`);
