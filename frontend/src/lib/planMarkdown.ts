// A plan body (model-written Markdown, treated as hostile) parsed into a closed
// AST of plain data. Nothing here emits markup: the renderer maps each node kind
// to a fixed element with text children, so a `<tag>` in a plan stays text. The
// subset is what real plans use; the deviations from CommonMark are listed in
// .wiki/gotchas/plan-markdown-rendering.md, and the Raw view covers them.
//
// Linear time on any input, nesting bounded: lines are scanned by index (no
// backtracking regex), containers stop nesting at MAX_NEST, every inline
// delimiter is pushed once and popped at most once, and inline nesting stops at
// MAX_INLINE_NEST. Content past a cap stays as text, never dropped.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong' | 'em' | 'del'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface ListItem { checked: boolean | null; children: Block[] }

export type Block =
  | { kind: 'heading'; level: number; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'hr' };

/** Quote/list containers nest at most this deep; deeper markers stay paragraph text. */
export const MAX_NEST = 8;
/** Emphasis/link nodes nest at most this deep; deeper delimiters stay literal. */
export const MAX_INLINE_NEST = 16;

const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * The href a plan link may carry, or undefined. Parsed by the WHATWG URL parser
 * (the one the browser applies to `<a href>`), with no base: only an absolute
 * http/https/mailto URL passes, returned as the serialisation that was checked.
 */
export function safeHref(raw: string): string | undefined {
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  return SAFE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
}

/** The text an inline run reads as (a task checkbox's accessible name). */
export function plainText(inlines: readonly Inline[]): string {
  let out = '';
  for (const n of inlines) {
    if (n.kind === 'text' || n.kind === 'code') out += n.text;
    else if (n.kind === 'br') out += ' ';
    else out += plainText(n.children);
  }
  return out;
}

/** The plan body as blocks; empty or whitespace-only input is `[]`. */
export function parsePlan(src: string): Block[] {
  const lines = src.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // A final newline ends the last line; it does not start an empty one (an unclosed fence would keep it).
  if (lines[lines.length - 1] === '') lines.pop();
  // YAML frontmatter: line 0 exactly `---` up to the next line exactly `---` shows verbatim, so its
  // keys are not run together into one paragraph between two rules. Unclosed, it is ordinary text.
  const close = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (close === -1) return parseBlocks(lines, 0);
  return [{ kind: 'code', text: lines.slice(0, close + 1).join('\n') }, ...parseBlocks(lines.slice(close + 1), 0)];
}

// ---------------------------------------------------------------- line helpers

const isSpTab = (c: string | undefined) => c === ' ' || c === '\t';

function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i++) if (!isSpTab(line[i])) return false;
  return true;
}

/** Leading whitespace: its width in columns (tab stops of 4) and the index past it. */
function lead(line: string): { cols: number; idx: number } {
  let cols = 0;
  let idx = 0;
  for (; idx < line.length; idx++) {
    if (line[idx] === ' ') cols++;
    else if (line[idx] === '\t') cols += 4 - (cols % 4);
    else break;
  }
  return { cols, idx };
}

/** `line` from column `start` (counted from `col0` at index `from`), a split tab padded with spaces. */
function fromCol(line: string, start: number, from = 0, col0 = 0): string {
  let cols = col0;
  let i = from;
  while (i < line.length && cols < start && isSpTab(line[i])) {
    cols += line[i] === '\t' ? 4 - (cols % 4) : 1;
    i++;
  }
  return ' '.repeat(Math.max(0, cols - start)) + line.slice(i);
}

function trimSpTab(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isSpTab(s[a])) a++;
  while (b > a && isSpTab(s[b - 1])) b--;
  return s.slice(a, b);
}

/** A run of `ch` starting at `i`: its length. */
function runAt(s: string, i: number, ch: string): number {
  let j = i;
  while (s[j] === ch) j++;
  return j - i;
}

// ---------------------------------------------------------------- block starts

interface Fence { ch: string; len: number; indent: number; }

function fenceOpen(line: string): Fence | null {
  const { cols, idx } = lead(line);
  if (cols >= 4) return null;
  const ch = line[idx];
  if (ch !== '`' && ch !== '~') return null;
  const len = runAt(line, idx, ch);
  if (len < 3) return null;
  if (ch === '`' && line.indexOf('`', idx + len) !== -1) return null;
  return { ch, len, indent: cols };
}

function fenceCloses(line: string, f: Fence): boolean {
  const { cols, idx } = lead(line);
  if (cols >= 4 || line[idx] !== f.ch) return false;
  const len = runAt(line, idx, f.ch);
  return len >= f.len && isBlank(line.slice(idx + len));
}

function headingLevel(line: string): number {
  const { cols, idx } = lead(line);
  if (cols >= 4) return 0;
  const n = runAt(line, idx, '#');
  if (n < 1 || n > 6) return 0;
  const next = line[idx + n];
  return next === undefined || isSpTab(next) ? n : 0;
}

function isRule(line: string): boolean {
  const { cols, idx } = lead(line);
  if (cols >= 4) return false;
  const ch = line[idx];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let n = 0;
  for (let i = idx; i < line.length; i++) {
    if (line[i] === ch) n++;
    else if (!isSpTab(line[i])) return false;
  }
  return n >= 3;
}

function isQuoteLine(line: string): boolean {
  const { cols, idx } = lead(line);
  return cols < 4 && line[idx] === '>';
}

interface Marker {
  ordered: boolean;
  /** The bullet character, or the ordered delimiter (`.` / `)`). */
  ch: string;
  start: number;
  /** Column the item's content starts at. */
  contentCol: number;
  /** The first line's content, from that column. */
  first: string;
}

function listMarker(line: string): Marker | null {
  const { cols, idx } = lead(line);
  if (cols >= 4) return null;
  let ordered = false;
  let ch = line[idx];
  let start = 1;
  let end = idx + 1;
  if (ch !== '-' && ch !== '*' && ch !== '+') {
    let d = idx;
    while (d < line.length && d - idx < 10 && line[d] >= '0' && line[d] <= '9') d++;
    const digits = d - idx;
    if (digits < 1 || digits > 9 || (line[d] !== '.' && line[d] !== ')')) return null;
    ordered = true;
    ch = line[d];
    start = Number(line.slice(idx, d));
    end = d + 1;
  }
  const after = line[end];
  if (after !== undefined && !isSpTab(after)) return null;
  const markerCol = cols + (end - idx);
  if (isBlank(line.slice(end))) return { ordered, ch, start, contentCol: markerCol + 1, first: '' };
  let gap = markerCol;
  for (let k = end; isSpTab(line[k]); k++) gap += line[k] === '\t' ? 4 - (gap % 4) : 1;
  // Five or more columns of space after the marker: the content starts one column in and keeps the rest.
  const contentCol = gap - markerCol >= 5 ? markerCol + 1 : gap;
  return { ordered, ch, start, contentCol, first: fromCol(line, contentCol, end, markerCol) };
}

/** Whether `line` starts a block that interrupts a paragraph at `depth`. */
function interrupts(line: string, depth: number): boolean {
  if (fenceOpen(line) || headingLevel(line) || isRule(line)) return true;
  if (depth >= MAX_NEST) return false;
  if (isQuoteLine(line)) return true;
  const m = listMarker(line);
  return !!m && m.first !== '' && (!m.ordered || m.start === 1);
}

// ---------------------------------------------------------------- tables

/** A table row's cells (outer pipes dropped, `\|` a literal pipe), untrimmed. */
function splitRow(line: string): string[] {
  let s = trimSpTab(line);
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += s.slice(from, i) + '|'; i++; from = i + 1; continue; }
    if (s[i] === '|') { cells.push(cur + s.slice(from, i)); cur = ''; from = i + 1; }
  }
  cells.push(cur + s.slice(from));
  return cells;
}

/** A delimiter row's per-column alignment, or null when `line` is not one. */
function delimiterRow(line: string): Align[] | null {
  if (line.indexOf('|') === -1 || lead(line).cols >= 4) return null;
  const out: Align[] = [];
  for (const raw of splitRow(line)) {
    const c = trimSpTab(raw);
    let a = 0;
    let b = c.length;
    const left = c[a] === ':';
    if (left) a++;
    const right = b > a && c[b - 1] === ':';
    if (right) b--;
    if (b <= a) return null;
    for (let i = a; i < b; i++) if (c[i] !== '-') return null;
    out.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return out;
}

/** The table starting at `lines[i]`, or null when lines i and i+1 are not a header and its delimiter row. */
function tableAt(lines: string[], i: number): Align[] | null {
  const head = lines[i];
  if (head.indexOf('|') === -1 || i + 1 >= lines.length || lead(head).cols >= 4) return null;
  const align = delimiterRow(lines[i + 1]);
  return align && splitRow(head).length === align.length ? align : null;
}

const cellInlines = (cells: string[]) => cells.map((c) => parseInline(trimSpTab(c)));

// ---------------------------------------------------------------- blocks

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !fenceCloses(lines[i], fence)) body.push(fromCol(lines[i++], fence.indent));
      i++;
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const level = headingLevel(line);
    if (level) {
      out.push({ kind: 'heading', level, children: parseInline(headingText(line)) });
      i++;
      continue;
    }

    if (isRule(line)) { out.push({ kind: 'hr' }); i++; continue; }

    if (depth < MAX_NEST && isQuoteLine(line)) {
      const inner: string[] = [];
      let open: Fence | null = null;
      for (; i < lines.length && !isBlank(lines[i]); i++) {
        const l = lines[i];
        let content: string;
        if (isQuoteLine(l)) {
          const { idx } = lead(l);
          content = l.slice(isSpTab(l[idx + 1]) ? idx + 2 : idx + 1);
        } else {
          const prev = inner[inner.length - 1];
          if (open || prev === undefined || isBlank(prev) || interrupts(l, depth) || listMarker(l)) break;
          content = l;
        }
        inner.push(content);
        open = open ? (fenceCloses(content, open) ? null : open) : fenceOpen(content);
      }
      out.push({ kind: 'quote', children: parseBlocks(inner, depth + 1) });
      continue;
    }

    const marker = depth < MAX_NEST ? listMarker(line) : null;
    if (marker) {
      const list: Block & { kind: 'list' } = { kind: 'list', ordered: marker.ordered, start: marker.start, items: [] };
      let m: Marker | null = marker;
      while (m && m.ordered === marker.ordered && m.ch === marker.ch) {
        let first = m.first;
        let checked: boolean | null = null;
        const task = first.slice(0, 4);
        if (task === '[ ] ' || task === '[x] ' || task === '[X] ') { checked = task !== '[ ] '; first = first.slice(4); }
        const item: string[] = [first];
        let open = fenceOpen(first);
        let prevBlank = first === '';
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) { item.push(''); prevBlank = true; i++; continue; }
          let content: string;
          if (lead(l).cols >= m.contentCol) content = fromCol(l, m.contentCol);
          else {
            // Any marker here ends the item: a sibling, or the start of a new list.
            if (prevBlank || open || listMarker(l) || interrupts(l, depth)) break;
            content = l;
          }
          item.push(content);
          prevBlank = false;
          open = open ? (fenceCloses(content, open) ? null : open) : fenceOpen(content);
          i++;
        }
        while (item.length && isBlank(item[item.length - 1])) item.pop();
        list.items.push({ checked, children: parseBlocks(item, depth + 1) });
        while (i < lines.length && isBlank(lines[i])) i++;
        m = i < lines.length ? listMarker(lines[i]) : null;
      }
      out.push(list);
      continue;
    }

    const align = tableAt(lines, i);
    if (align) {
      const width = align.length;
      const head = cellInlines(splitRow(line));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].indexOf('|') !== -1 && !interrupts(lines[i], depth)) {
        // Truncated to the header's width but never padded: padding would make the AST
        // header-width x row-count, quadratic in the input.
        rows.push(cellInlines(splitRow(lines[i]).slice(0, width)));
        i++;
      }
      out.push({ kind: 'table', align, head, rows });
      continue;
    }

    const para: string[] = [trimSpTab(line)];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines[i], depth) && !tableAt(lines, i)) {
      para.push(trimSpTab(lines[i]));
      i++;
    }
    out.push({ kind: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return out;
}

/** An ATX heading's text: marker and an optional closing `#` run stripped. */
function headingText(line: string): string {
  const { idx } = lead(line);
  let s = trimSpTab(line.slice(idx + runAt(line, idx, '#')));
  let k = s.length;
  while (k > 0 && s[k - 1] === '#') k--;
  if (k === 0) s = '';
  else if (k < s.length && isSpTab(s[k - 1])) s = trimSpTab(s.slice(0, k));
  return s;
}

// ---------------------------------------------------------------- inlines

const ASCII_PUNCT = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const SPECIAL = '\\`<*_~[]!';
const BR_TOKENS = ['<br>', '<br/>', '<br />'];
const isWs = (c: string | undefined) => c === undefined || /\s/.test(c);
const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
type DelimType = '*' | '**' | '_' | '__' | '~~';
const DELIM_KIND: Record<DelimType, 'em' | 'strong' | 'del'> = { '*': 'em', '**': 'strong', '_': 'em', '__': 'strong', '~~': 'del' };

/** Every maximal backtick run's start, grouped by run length: the code-span closer index. */
function backtickRuns(s: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < s.length;) {
    if (s[i] !== '`') { i++; continue; }
    const k = runAt(s, i, '`');
    const at = runs.get(k);
    if (at) at.push(i); else runs.set(k, [i]);
    i += k;
  }
  return runs;
}

function mergeText(items: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of items) {
    const last = out[out.length - 1];
    if (n.kind === 'text' && last?.kind === 'text') out[out.length - 1] = { kind: 'text', text: last.text + n.text };
    else out.push(n);
  }
  return out;
}

/**
 * Inline content as nodes. One left-to-right pass over an output stack: an opener
 * (`*`, `[` …) is pushed as a literal text node, and a matching closer replaces the
 * stack from that opener up with one wrapper node. A wrap therefore always takes a
 * suffix, which keeps every opener below it at a stable index, and lets the
 * suffix-maximum stack `peaks` answer "how deep is everything from here up" in
 * O(log n).
 */
function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  const depths: number[] = [];
  // Indices into `out` whose depth exceeds every later item's (strictly decreasing).
  const peaks: number[] = [];
  const delims: Record<DelimType, number[]> = { '*': [], '**': [], '_': [], '__': [], '~~': [] };
  const brackets: { index: number; image: boolean }[] = [];
  const runs = backtickRuns(s);
  const runPos = new Map<number, number>();
  let acc: { kind: 'text'; text: string } | null = null;

  const push = (node: Inline, depth: number) => {
    while (peaks.length && depths[peaks[peaks.length - 1]] <= depth) peaks.pop();
    peaks.push(out.length);
    out.push(node);
    depths.push(depth);
    acc = null;
  };
  const text = (t: string) => {
    if (acc && out[out.length - 1] === acc) acc.text += t;
    else { const node = { kind: 'text' as const, text: t }; push(node, 0); acc = node; }
  };
  /** Depth of the deepest item at index `from` or above. */
  const depthFrom = (from: number) => {
    let lo = 0;
    let hi = peaks.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (peaks[mid] < from) lo = mid + 1; else hi = mid; }
    return lo < peaks.length ? depths[peaks[lo]] : 0;
  };
  /** Replace `out[at..]` (the opener and everything after it) with `make(children)`. */
  const wrap = (at: number, make: (children: Inline[]) => Inline) => {
    const depth = 1 + depthFrom(at + 1);
    const children = mergeText(out.slice(at + 1));
    out.length = at;
    depths.length = at;
    while (peaks.length && peaks[peaks.length - 1] >= at) peaks.pop();
    // Openers inside the wrapped range can no longer match anything outside it.
    for (const stack of Object.values(delims)) while (stack.length && stack[stack.length - 1] >= at) stack.pop();
    while (brackets.length && brackets[brackets.length - 1].index >= at) brackets.pop();
    push(make(children), depth);
  };

  const delim = (type: DelimType, canOpen: boolean, canClose: boolean) => {
    const stack = delims[type];
    if (canClose && stack.length) {
      const at = stack[stack.length - 1];
      if (1 + depthFrom(at + 1) <= MAX_INLINE_NEST) {
        stack.pop();
        wrap(at, (children) => ({ kind: DELIM_KIND[type], children }));
        return;
      }
    }
    if (canOpen) { stack.push(out.length); push({ kind: 'text', text: type }, 0); return; }
    text(type);
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.includes(s[i + 1])) { text(s[i + 1]); i += 2; continue; }
    if (c === '`') {
      const k = runAt(s, i, '`');
      const at = runs.get(k) ?? [];
      let p = runPos.get(k) ?? 0;
      while (p < at.length && at[p] < i + k) p++;
      runPos.set(k, p);
      if (p < at.length) {
        let code = s.slice(i + k, at[p]).replaceAll('\n', ' ');
        if (code.length > 1 && code[0] === ' ' && code[code.length - 1] === ' ' && !/^ +$/.test(code)) code = code.slice(1, -1);
        push({ kind: 'code', text: code }, 0);
        i = at[p] + k;
      } else { text('`'.repeat(k)); i += k; }
      continue;
    }
    if (c === '<') {
      const br = BR_TOKENS.find((t) => s.slice(i, i + t.length).toLowerCase() === t);
      if (br) { push({ kind: 'br' }, 0); i += br.length; } else { text('<'); i++; }
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      const len = runAt(s, i, c);
      const prev = s[i - 1];
      const next = s[i + len];
      let canOpen = !isWs(next);
      let canClose = !isWs(prev);
      if (c === '_') { canOpen &&= !isAlnum(prev); canClose &&= !isAlnum(next); }
      const types: DelimType[] | null = c === '~'
        ? (len === 2 ? ['~~'] : null)
        : len === 1 ? [c] : len === 2 ? [`${c}${c}` as DelimType] : len === 3 ? (canClose ? [c, `${c}${c}` as DelimType] : [`${c}${c}` as DelimType, c]) : null;
      if (!types || (!canOpen && !canClose)) text(c.repeat(len));
      else for (const t of types) delim(t, canOpen, canClose);
      i += len;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      brackets.push({ index: out.length, image });
      push({ kind: 'text', text: image ? '![' : '[' }, 0);
      i += image ? 2 : 1;
      continue;
    }
    if (c === ']' && brackets.length) {
      const top = brackets[brackets.length - 1];
      let j = i + 2;
      if (s[i + 1] === '(') while (j < s.length && !/[\s()]/.test(s[j])) j++;
      if (s[i + 1] !== '(' || s[j] !== ')') { brackets.pop(); text(']'); i++; continue; }
      const url = s.slice(i + 2, j);
      const href = top.image ? undefined : safeHref(url);
      if (href !== undefined && 1 + depthFrom(top.index + 1) <= MAX_INLINE_NEST) {
        wrap(top.index, (children) => ({ kind: 'link', href, children }));
        // No link inside a link: every earlier `[` stays literal.
        brackets.length = 0;
      } else {
        // An image, a disallowed URL, or too deep: the whole source shows as text.
        brackets.pop();
        text(`](${url})`);
      }
      i = j + 1;
      continue;
    }
    let j = i + 1;
    while (j < s.length && !SPECIAL.includes(s[j])) j++;
    text(s.slice(i, j));
    i = j;
  }
  return mergeText(out);
}
