// Source-scanning helpers for the frontend guard tests (frontendTheme,
// frontendSafety): `npm test` has no DOM and never renders React, so those
// tests read frontend/ as text. Brace- and string-aware, so a `>` or a `}`
// inside an attribute's string or expression does not end a JSX tag early.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FRONTEND = path.join(ROOT, 'frontend');

/** Repo-relative paths of the files under `rel` whose name ends with one of `exts`. */
export function listFiles(rel, exts) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return exts.some((e) => rel.endsWith(e)) ? [rel] : [];
  return fs.readdirSync(abs).sort().flatMap((n) => listFiles(path.join(rel, n), exts));
}

export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CLOSERS = { '(': ')', '{': '}', '[': ']' };
const isQuote = (ch) => ch === "'" || ch === '"' || ch === '`';

/** Index just past the string literal opening at `i` (template `${…}` included). */
export function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src.startsWith('${', j)) { j = matchClose(src, j + 1) - 1; continue; }
    if (src[j] === q) return j + 1;
    if (q !== '`' && src[j] === '\n') throw new Error(`unterminated ${q} string at ${i}`);
  }
  throw new Error(`unterminated string at ${i}`);
}

/** Index just past the bracket matching the one at `open`. */
export function matchClose(src, open) {
  const stack = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (isQuote(ch)) { i = skipString(src, i) - 1; continue; }
    if (CLOSERS[ch]) stack.push(CLOSERS[ch]);
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (ch !== stack.pop()) throw new Error(`unbalanced ${ch} at ${i}`);
      if (stack.length === 0) return i + 1;
    }
  }
  throw new Error(`no closer for ${src[open]} at ${open}`);
}

/**
 * `src` with every `//` and `/* *\/` comment blanked to spaces (indices kept), and
 * JSX comments `{/* … *\/}` with them. Strings are kept as written. JSX text is not a
 * string, so an apostrophe in it is written as `’`; a straight one would be taken
 * for a string opener and fail loudly.
 */
export function blankComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    if (isQuote(src[i])) { const j = skipString(src, i); out += src.slice(i, j); i = j; continue; }
    let stop = -1;
    if (src.startsWith('//', i)) stop = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    else if (src.startsWith('/*', i)) stop = src.indexOf('*/', i) + 2;
    if (stop === -1) { out += src[i]; i++; continue; }
    out += src.slice(i, stop).replace(/[^\n]/g, ' ');
    i = stop;
  }
  return out;
}

/**
 * Every JSX opening tag named one of `names` (`<Button …>`, `<button …/>`), with its
 * attribute text, brace- and string-aware.
 */
export function openingTags(src, names) {
  const tags = [];
  const re = new RegExp(`<(${names.join('|')})(?=[\\s/>])`, 'g');
  for (const m of src.matchAll(re)) {
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (isQuote(ch)) { i = skipString(src, i) - 1; continue; }
      if (ch === '{') { i = matchClose(src, i) - 1; continue; }
      if (ch === '>') break;
    }
    tags.push({ name: m[1], attrs: src.slice(m.index + m[0].length, i).replace(/\/$/, ''), index: m.index });
  }
  return tags;
}

/**
 * A JSX attribute's value in `attrs`: the string for `name="x"`, `{…}` text for an
 * expression, `true` for a bare attribute, undefined when absent. Attributes inside
 * expressions are not looked into.
 */
export function attrValue(attrs, name) {
  for (let i = 0; i < attrs.length;) {
    const ch = attrs[i];
    if (ch === '{') { i = matchClose(attrs, i); continue; }
    const m = /^[A-Za-z_][\w:-]*/.exec(attrs.slice(i));
    if (!m) { i++; continue; }
    const key = m[0];
    let j = i + key.length;
    if (attrs[j] !== '=') { if (key === name) return true; i = j; continue; }
    j++;
    let value;
    let end;
    if (isQuote(attrs[j])) { end = skipString(attrs, j); value = attrs.slice(j + 1, end - 1); }
    else if (attrs[j] === '{') { end = matchClose(attrs, j); value = attrs.slice(j, end); }
    else { end = j; value = ''; }
    if (key === name) return value;
    i = end;
  }
  return undefined;
}
