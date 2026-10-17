import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, safeHref, plainText, MAX_NEST, MAX_INLINE_NEST } from '../frontend/src/lib/planMarkdown.ts';

// The plan-body Markdown parser. A plan is model-written and the page is
// same-origin with an unauthenticated, bash-capable API, so the contract is
// security first: no HTML channel, a closed node vocabulary, only http(s)/mailto
// links, no images, bounded nesting with nothing dropped. Linear time is pinned
// in tests/parserTiming.test.mjs.

const p = (text) => [{ kind: 'paragraph', children: text }];
const t = (text) => ({ kind: 'text', text });
/** The single paragraph's inlines. */
const inl = (src) => {
  const blocks = parsePlan(src);
  assert.equal(blocks.length, 1, JSON.stringify(blocks));
  assert.equal(blocks[0].kind, 'paragraph');
  return blocks[0].children;
};

/** Every node in the tree, depth-first. */
function* walk(blocks) {
  for (const b of blocks) {
    yield b;
    if (b.kind === 'list') for (const it of b.items) { yield it; yield* walk(it.children); }
    else if (b.kind === 'quote') yield* walk(b.children);
    else if (b.kind === 'table') for (const row of [b.head, ...b.rows]) for (const cell of row) yield* walkInline(cell);
    else if (b.kind === 'heading' || b.kind === 'paragraph') yield* walkInline(b.children);
  }
}
function* walkInline(nodes) {
  for (const n of nodes) { yield n; if (n.children) yield* walkInline(n.children); }
}
const containerDepth = (blocks) => Math.max(0, ...blocks.map((b) => (
  b.kind === 'quote' ? 1 + containerDepth(b.children)
    : b.kind === 'list' ? 1 + Math.max(0, ...b.items.map((it) => containerDepth(it.children))) : 0)));
const inlineDepth = (nodes) => Math.max(0, ...nodes.map((n) => (n.children ? 1 + inlineDepth(n.children) : 0)));
const allText = (blocks) => [...walk(blocks)].filter((n) => typeof n.text === 'string').map((n) => n.text).join('\n');

test('safeHref passes only absolute http, https and mailto URLs, as the URL parser serialises them', () => {
  assert.equal(safeHref('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeHref('HTTP://X.TEST'), 'http://x.test/');
  assert.equal(safeHref('mailto:a@b.test'), 'mailto:a@b.test');
  // No relative resolution against the plugin's origin, and every other scheme in any spelling.
  for (const raw of [
    'javascript:alert(1)', 'JaVaScRiPt:x', ' javascript:x', 'java\tscript:x', 'java\nscript:x', '\x01javascript:x',
    'data:text/html,<script>', 'vbscript:x', 'file:///etc/passwd', 'blob:x', 'ftp://x', 'foo', '/api/x', '//evil.test', '#frag', '',
  ]) assert.equal(safeHref(raw), undefined, JSON.stringify(raw));
});

const BLOCK_KEYS = {
  heading: ['kind', 'level', 'children'], paragraph: ['kind', 'children'], code: ['kind', 'text'],
  list: ['kind', 'ordered', 'start', 'items'], quote: ['kind', 'children'], table: ['kind', 'align', 'head', 'rows'], hr: ['kind'],
};
const INLINE_KEYS = {
  text: ['kind', 'text'], code: ['kind', 'text'], strong: ['kind', 'children'], em: ['kind', 'children'],
  del: ['kind', 'children'], link: ['kind', 'href', 'children'], br: ['kind'],
};
const CORPUS = [
  '# H1 `code` #', '###### H6', '1. one\n2. two\n   - nested *em* **strong** ~~del~~ _u_ __s__', '- [ ] open\n- [x] done',
  '| a | b |\n|:--|--:|\n| x\\|y | <br> z |\n| ragged |', '> quote\nlazy\n> > nested', '```html\n<script>alert(1)</script>\n```', '---',
  '[ok](https://x.test) [js](javascript:alert(1)) [rel](rel.md) ![img](https://x.test/p.png) <a href="javascript:x">a</a>',
  '<img src=x onerror=alert(1)> <iframe src=x></iframe> <br onclick=x> <style>p{}</style> &lt;b&gt;',
  '[a [b](https://x.test)](https://y.test) [x](data:text/html,<script>) [y](HTTPS://Z.TEST "t")',
  '> '.repeat(30) + 'deep', '*'.repeat(9) + 'x' + '_'.repeat(9), 'a\\*b\\_c\\`d\\[e',
];

test('the AST is a closed vocabulary: no image, html or attribute channel, and every link href passes safeHref', () => {
  let nodes = 0;
  let links = 0;
  for (const src of CORPUS) {
    for (const n of walk(parsePlan(src))) {
      nodes++;
      if (!('kind' in n)) { assert.deepEqual(Object.keys(n).sort(), ['checked', 'children']); continue; }
      // `code` is both a block and an inline kind, with the same keys.
      const allowed = BLOCK_KEYS[n.kind] ?? INLINE_KEYS[n.kind];
      assert.ok(allowed, `unknown kind ${n.kind}`);
      for (const k of Object.keys(n)) assert.ok(allowed.includes(k), `${n.kind} carries ${k}`);
      if ('text' in n) assert.equal(typeof n.text, 'string');
      if (n.kind === 'link') { links++; assert.equal(safeHref(n.href), n.href); }
    }
  }
  // Liveness: the walk reaches the tree, and both allowed links in the corpus (ok, b).
  assert.ok(nodes > 50, `walked only ${nodes} nodes`);
  assert.equal(links, 2);
});

test('no node kind outside the closed sets: block kinds at block positions, inline kinds at inline positions', () => {
  const blockKinds = new Set(Object.keys(BLOCK_KEYS));
  const inlineKinds = new Set(Object.keys(INLINE_KEYS));
  const checkInline = (nodes) => { for (const n of nodes) { assert.ok(inlineKinds.has(n.kind), n.kind); if (n.children) checkInline(n.children); } };
  const checkBlocks = (blocks) => {
    for (const b of blocks) {
      assert.ok(blockKinds.has(b.kind), b.kind);
      assert.deepEqual(Object.keys(b).sort(), [...BLOCK_KEYS[b.kind]].sort(), b.kind);
      if (b.kind === 'heading' || b.kind === 'paragraph') checkInline(b.children);
      if (b.kind === 'quote') checkBlocks(b.children);
      if (b.kind === 'list') for (const it of b.items) { assert.deepEqual(Object.keys(it).sort(), ['checked', 'children']); checkBlocks(it.children); }
      if (b.kind === 'table') for (const row of [b.head, ...b.rows]) for (const cell of row) checkInline(cell);
    }
  };
  for (const src of CORPUS) checkBlocks(parsePlan(src));
});

test('HTML stays text: tags and placeholders render as their literal source', () => {
  for (const src of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<details><summary>x</summary>', '<id>', '<a href="javascript:x">a</a>']) {
    assert.deepEqual(parsePlan(src), p([t(src)]), src);
  }
});

test('<br> is the one recognised tag, and only with no attributes', () => {
  assert.deepEqual(inl('a<br>b'), [t('a'), { kind: 'br' }, t('b')]);
  assert.deepEqual(inl('<BR/>'), [{ kind: 'br' }]);
  assert.deepEqual(inl('<br />'), [{ kind: 'br' }]);
  assert.deepEqual(inl('<br onclick=x>'), [t('<br onclick=x>')]);
  assert.deepEqual(inl('<br class=y>'), [t('<br class=y>')]);
});

test('links: an allowed URL is a link node; any other URL, a nested link and an image show as their source', () => {
  assert.deepEqual(inl('[t](https://x.test)'), [{ kind: 'link', href: 'https://x.test/', children: [t('t')] }]);
  assert.deepEqual(inl('see [*t*](mailto:a@b.test).'), [t('see '), { kind: 'link', href: 'mailto:a@b.test', children: [{ kind: 'em', children: [t('t')] }] }, t('.')]);
  for (const src of ['[t](javascript:alert(1))', '[t](rel.md)', '[t](#a)', '[t](https://x.test "title")', '[t] (https://x.test)', '![i](https://x.test/p.png)']) {
    assert.deepEqual(inl(src), [t(src)], src);
  }
  const nested = inl('[a [b](https://x.test)](https://y.test)');
  assert.deepEqual(nested, [t('[a '), { kind: 'link', href: 'https://x.test/', children: [t('b')] }, t('](https://y.test)')]);
  // An image inside link text stays source text too.
  const withImage = inl('[![i](https://x.test/p.png)](https://y.test)');
  assert.equal([...walkInline(withImage)].filter((n) => n.kind === 'link').length, 1);
  assert.equal(plainText(withImage), '![i](https://x.test/p.png)');
});

test('ATX headings: levels 1–6, closing hashes stripped, 7+ hashes or no space is a paragraph', () => {
  for (let level = 1; level <= 6; level++) {
    assert.deepEqual(parsePlan(`${'#'.repeat(level)} Title`), [{ kind: 'heading', level, children: [t('Title')] }]);
  }
  assert.deepEqual(parsePlan('## Use `x` ##'), [{ kind: 'heading', level: 2, children: [t('Use '), { kind: 'code', text: 'x' }] }]);
  assert.deepEqual(parsePlan('# C#'), [{ kind: 'heading', level: 1, children: [t('C#')] }]);
  assert.deepEqual(parsePlan('#'), [{ kind: 'heading', level: 1, children: [] }]);
  assert.deepEqual(parsePlan('####### x'), p([t('####### x')]));
  assert.deepEqual(parsePlan('#tag'), p([t('#tag')]));
  assert.deepEqual(parsePlan('    # four spaces'), p([t('# four spaces')]));
});

test('fences: backtick and tilde, contents verbatim, the info string dropped, an unclosed fence runs to the end', () => {
  assert.deepEqual(parsePlan('```js\n<script>x</script>\n**not bold** [l](https://x.test)\n```\nafter'), [
    { kind: 'code', text: '<script>x</script>\n**not bold** [l](https://x.test)' }, ...p([t('after')]),
  ]);
  assert.deepEqual(parsePlan('~~~\n```\n~~~'), [{ kind: 'code', text: '```' }]);
  assert.deepEqual(parsePlan('````\n```\n`````\nx'), [{ kind: 'code', text: '```' }, ...p([t('x')])]);
  assert.deepEqual(parsePlan('```\na\n\nb'), [{ kind: 'code', text: 'a\n\nb' }]);
  assert.deepEqual(parsePlan('  ```\n  a\n b\n  ```'), [{ kind: 'code', text: 'a\nb' }]);
  // A backtick in the info string makes it an inline code span, not a fence.
  assert.deepEqual(parsePlan('```a``` b'), p([{ kind: 'code', text: 'a' }, t(' b')]));
});

test('lists: bullets, ordered with its start, nesting by content indent, lazy lines, task items', () => {
  assert.deepEqual(parsePlan('3. three\n4) four'), [
    { kind: 'list', ordered: true, start: 3, items: [{ checked: null, children: p([t('three')]) }] },
    { kind: 'list', ordered: true, start: 4, items: [{ checked: null, children: p([t('four')]) }] },
  ]);
  assert.deepEqual(parsePlan('- a\n  - b\n    more\nlazy\n\n- c\n+ d'), [
    {
      kind: 'list', ordered: false, start: 1, items: [
        { checked: null, children: [...p([t('a')]), { kind: 'list', ordered: false, start: 1, items: [{ checked: null, children: p([t('b\nmore\nlazy')]) }] }] },
        { checked: null, children: p([t('c')]) },
      ],
    },
    { kind: 'list', ordered: false, start: 1, items: [{ checked: null, children: p([t('d')]) }] },
  ]);
  assert.deepEqual(parsePlan('- [ ] open\n- [x] done\n- [X] Done\n- [y] not'), [{
    kind: 'list', ordered: false, start: 1, items: [
      { checked: false, children: p([t('open')]) }, { checked: true, children: p([t('done')]) },
      { checked: true, children: p([t('Done')]) }, { checked: null, children: p([t('[y] not')]) },
    ],
  }]);
  // A list interrupts a paragraph (an ordered one only from 1); "2." mid-sentence stays text.
  assert.equal(parsePlan('Steps:\n- a')[1].kind, 'list');
  assert.deepEqual(parsePlan('in version\n2. stays text'), p([t('in version\n2. stays text')]));
  assert.deepEqual(parsePlan('1.5x faster'), p([t('1.5x faster')]));
  assert.equal(plainText(parsePlan('- [ ] Ship **it**')[0].items[0].children[0].children), 'Ship it');
});

test('GFM tables: per-column alignment, \\| as a literal pipe, rows truncated but never padded, a mismatched delimiter is no table', () => {
  assert.deepEqual(parsePlan('| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | x\\|y | `z` | <br> |\n| only |\n| 1 | 2 | 3 | 4 | 5 |\nafter'), [
    {
      kind: 'table', align: ['left', 'center', 'right', null],
      head: [[t('a')], [t('b')], [t('c')], [t('d')]],
      rows: [
        [[t('1')], [t('x|y')], [{ kind: 'code', text: 'z' }], [{ kind: 'br' }]],
        // Never padded: a header-wide pad per row would make the AST header width x rows.
        [[t('only')]],
        [[t('1')], [t('2')], [t('3')], [t('4')]],
      ],
    },
    ...p([t('after')]),
  ]);
  assert.deepEqual(parsePlan('a | b\n--- | ---\nc | d'), [{ kind: 'table', align: [null, null], head: [[t('a')], [t('b')]], rows: [[[t('c')], [t('d')]]] }]);
  assert.deepEqual(parsePlan('| a | b |\n|---|\n| c |'), p([t('| a | b |\n|---|\n| c |')]));
  // A pipe-less dash row is a rule, not a one-column delimiter.
  assert.deepEqual(parsePlan('| a |\n---'), [...p([t('| a |')]), { kind: 'hr' }]);
  // The header ends a paragraph above it.
  assert.deepEqual(parsePlan('intro\n| a |\n|---|').map((b) => b.kind), ['paragraph', 'table']);
});

test('blockquotes nest and take lazy continuation lines; a blank line ends one', () => {
  assert.deepEqual(parsePlan('> a\nlazy\n> > b\n\nafter'), [
    { kind: 'quote', children: [...p([t('a\nlazy')]), { kind: 'quote', children: p([t('b')]) }] },
    ...p([t('after')]),
  ]);
  assert.deepEqual(parsePlan('>no space'), [{ kind: 'quote', children: p([t('no space')]) }]);
});

test('rules and paragraphs: 3+ of - * _ with spaces is a rule (never a setext underline); soft breaks stay in one paragraph', () => {
  for (const src of ['---', '***', '_ _ _', ' - - -', '-----']) assert.deepEqual(parsePlan(src), [{ kind: 'hr' }], src);
  assert.deepEqual(parsePlan('--'), p([t('--')]));
  assert.deepEqual(parsePlan('Title\n---'), [...p([t('Title')]), { kind: 'hr' }]);
  assert.deepEqual(parsePlan('  one  \ntwo\n\nthree'), [...p([t('one\ntwo')]), ...p([t('three')])]);
  assert.deepEqual(parsePlan('# a\r\nb\r\n'), [{ kind: 'heading', level: 1, children: [t('a')] }, ...p([t('b')])]);
});

test('emphasis, strong and strike; intraword _ and spaced * stay literal; code spans verbatim; backslash escapes', () => {
  const em = (k, ...c) => ({ kind: k, children: c });
  assert.deepEqual(inl('*a* _b_ **c** __d__ ~~e~~'), [em('em', t('a')), t(' '), em('em', t('b')), t(' '), em('strong', t('c')), t(' '), em('strong', t('d')), t(' '), em('del', t('e'))]);
  assert.deepEqual(inl('***both***'), [em('strong', em('em', t('both')))]);
  assert.deepEqual(inl('file_card_x and snake_case_name'), [t('file_card_x and snake_case_name')]);
  assert.deepEqual(inl('2 * 3 * 4'), [t('2 * 3 * 4')]);
  assert.deepEqual(inl('~one~ ~~~three~~~'), [t('~one~ ~~~three~~~')]);
  assert.deepEqual(inl('**unclosed'), [t('**unclosed')]);
  assert.deepEqual(inl('`*a* <b>` and ``x ` y`` and `unmatched'), [
    { kind: 'code', text: '*a* <b>' }, t(' and '), { kind: 'code', text: 'x ` y' }, t(' and `unmatched'),
  ]);
  assert.deepEqual(inl('`a\nb`'), [{ kind: 'code', text: 'a b' }]);
  assert.deepEqual(inl('\\*a\\* \\<br> \\[x](https://x.test) \\q'), [t('*a* <br> [x](https://x.test) \\q')]);
  // A closer matches the top of its own stack; an opener of another type left between goes literal.
  assert.deepEqual(inl('**a *b** c'), [em('strong', t('a *b')), t(' c')]);
});

test('container nesting stops at MAX_NEST and the deeper markers stay as paragraph text', () => {
  const quotes = parsePlan(`${'> '.repeat(50)}deep`);
  assert.equal(containerDepth(quotes), MAX_NEST);
  let inner = quotes;
  for (let d = 0; d < MAX_NEST; d++) inner = inner[0].children;
  assert.deepEqual(inner, p([t(`${'> '.repeat(50 - MAX_NEST)}deep`)]));

  const list = parsePlan(Array.from({ length: 50 }, (_, k) => `${'  '.repeat(k)}- item${k}`).join('\n'));
  assert.equal(containerDepth(list), MAX_NEST);
  const text = allText(list);
  for (let k = 0; k < 50; k++) assert.ok(text.includes(`item${k}`), `item${k} dropped`);
});

test('inline nesting stops at MAX_INLINE_NEST and the deeper delimiters stay literal', () => {
  const levels = 20;
  const src = `${'*a _a '.repeat(levels)}x ${'a_ a* '.repeat(levels)}`.trim();
  const nodes = inl(src);
  assert.equal(inlineDepth(nodes), MAX_INLINE_NEST);
  const text = plainText(nodes);
  assert.equal(text.replace(/[*_]/g, ''), src.replace(/[*_]/g, ''));
  assert.equal(text.replace(/[^*_]/g, '').length, 4 * levels - 2 * MAX_INLINE_NEST);
});

test('empty and whitespace-only input is no blocks', () => {
  assert.deepEqual(parsePlan(''), []);
  assert.deepEqual(parsePlan('  \n\n\t\n'), []);
});
