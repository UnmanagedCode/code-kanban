import { Checkbox } from '@/components/ui/checkbox';
import { plainText, safeHref, type Align, type Block, type Inline, type ListItem } from '@/lib/planMarkdown';

// The renderer for parsePlan's closed AST: each kind maps to one fixed element with
// text children. This file is the plan's only link sink (tests/frontendSafety.test.mjs
// pins its shape): the href is re-checked here, and a link opens in a new top-level
// context with no opener and no referrer, so it can never navigate the host frame.

/** By markdown level; the element is h{level + 3}, as the Plan section sits under an h3. */
const HEADING_CLASS: Record<number, string> = {
  1: 'text-lg font-semibold',
  2: 'text-base font-semibold',
  3: 'text-sm font-semibold',
  4: 'text-sm font-medium',
  5: 'text-sm font-medium',
  6: 'text-sm font-medium',
};

const ALIGN_CLASS: Record<NonNullable<Align>, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };
const cellClass = (align: Align) => `border px-2 py-1 align-top ${align ? ALIGN_CLASS[align] : 'text-left'}`;

export function PlanMarkdown({ blocks }: { blocks: Block[] }) {
  return <>{blocks.map((b, i) => <BlockNode key={i} block={b} />)}</>;
}

function BlockNode({ block }: { block: Block }) {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(6, block.level + 3)}` as 'h4';
      return <Tag className={HEADING_CLASS[block.level]}><Inlines nodes={block.children} /></Tag>;
    }
    case 'paragraph':
      return <p><Inlines nodes={block.children} /></p>;
    case 'code':
      return <pre className="overflow-x-auto rounded border bg-muted p-2 font-mono text-xs"><code>{block.text}</code></pre>;
    case 'list': {
      const items = block.items.map((item, i) => <Item key={i} item={item} />);
      return block.ordered
        ? <ol start={block.start} className="list-decimal space-y-1 pl-5">{items}</ol>
        : <ul className="list-disc space-y-1 pl-5">{items}</ul>;
    }
    case 'quote':
      return <blockquote className="space-y-2 border-l-2 pl-3 text-muted-foreground"><PlanMarkdown blocks={block.children} /></blockquote>;
    case 'table':
      return (
        <div className="overflow-x-auto">
          <table className="border-collapse text-xs">
            <thead>
              <tr>{block.head.map((cell, c) => <th key={c} className={`${cellClass(block.align[c])} font-semibold`}><Inlines nodes={cell} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>{row.map((cell, c) => <td key={c} className={cellClass(block.align[c])}><Inlines nodes={cell} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'hr':
      return <hr />;
  }
}

function Item({ item }: { item: ListItem }) {
  const body = <div className="min-w-0 space-y-1"><PlanMarkdown blocks={item.children} /></div>;
  if (item.checked === null) return <li>{body}</li>;
  const first = item.children[0];
  const name = first?.kind === 'paragraph' || first?.kind === 'heading' ? plainText(first.children) : '';
  return (
    <li className="flex list-none items-start gap-2">
      <Checkbox checked={item.checked} disabled aria-label={name || 'Task'} className="mt-0.5 disabled:opacity-100" />
      {body}
    </li>
  );
}

function Inlines({ nodes }: { nodes: Inline[] }) {
  return <>{nodes.map((n, i) => <InlineNode key={i} node={n} />)}</>;
}

function InlineNode({ node }: { node: Inline }) {
  switch (node.kind) {
    case 'text':
      return <>{node.text}</>;
    case 'code':
      return <code className="rounded bg-muted px-1 font-mono text-xs">{node.text}</code>;
    case 'strong':
      return <strong className="font-semibold"><Inlines nodes={node.children} /></strong>;
    case 'em':
      return <em><Inlines nodes={node.children} /></em>;
    case 'del':
      return <del><Inlines nodes={node.children} /></del>;
    case 'link':
      return <a href={safeHref(node.href)} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2"><Inlines nodes={node.children} /></a>;
    case 'br':
      return <br />;
  }
}
