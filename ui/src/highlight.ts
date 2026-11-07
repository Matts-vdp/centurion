import hljs from 'highlight.js/lib/common';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import powershell from 'highlight.js/lib/languages/powershell';
import { baseName } from './fileStore';

// Syntax highlighting for the file viewer and visual <Code> blocks. highlight.js escapes the text, so its
// output is safe to insert as HTML.

hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('powershell', powershell);

const LANG_ALIASES: Record<string, string> = {
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  ts: 'typescript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  js: 'javascript',
  htm: 'xml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  ps1: 'powershell',
  psm1: 'powershell',
  yml: 'yaml',
  toml: 'ini',
  md: 'markdown',
  mdx: 'markdown',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  cs: 'csharp',
};

/** A highlight.js language for a name or extension ("ts", "typescript"), or null. */
export function language(name: string | undefined): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const lang = LANG_ALIASES[n] ?? n;
  return hljs.getLanguage(lang) ? lang : null;
}

/** The language of a file, from its name. */
export function languageOf(path: string): string | null {
  const name = baseName(path.replace(/\\/g, '/')).toLowerCase();
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  return language(ext);
}

/** Highlighted HTML, or null when the language is unknown or the text too large. */
export function highlight(text: string, lang: string | null): string | null {
  if (!lang || text.length > 300_000) return null;
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
