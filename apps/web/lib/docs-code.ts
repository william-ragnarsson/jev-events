import type { RehypeCodeOptions } from 'fumadocs-core/mdx-plugins';
import { parseCodeBlockAttributes } from 'fumadocs-core/mdx-plugins/codeblock-utils';

/**
 * How the docs print code: ink on white, comments in grey, and the parts that matter marked in
 * blue. Used for every fence in the docs (through fumadocs-mdx, see lib/source.ts) and for the
 * snippets the Snippet component highlights. A fence marks its parts with `mark`, split by `|`:
 *
 *   ```ts title="monitor.ts" mark="twitch.chat()|twitch.timeout({ seconds: 600 })"
 */

type Transformer = NonNullable<RehypeCodeOptions['transformers']>[number];
type Element = Parameters<NonNullable<Transformer['line']>>[0];
type Child = Element['children'][number];

const COMMENT = '#6B6862';

/** The one theme: every token in ink but comments, so a page has one color for what matters. */
export const MONO = {
  name: 'jev-mono',
  type: 'light' as const,
  colors: { 'editor.background': '#FFFFFF', 'editor.foreground': '#111111' },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment', 'string.comment'], settings: { foreground: COMMENT } },
  ],
};

/** A fence's `title` and `mark`, from its info line. */
export function parseMeta(meta: string): Record<string, unknown> {
  return parseCodeBlockAttributes(meta, ['title', 'mark']).attributes;
}

/** Which characters of `text` fall inside one of `marks`, every time each one appears. */
export function markedChars(text: string, marks: string[]): boolean[] {
  const on = new Array<boolean>(text.length).fill(false);
  for (const mark of marks) {
    if (!mark) continue;
    for (let at = text.indexOf(mark); at !== -1; at = text.indexOf(mark, at + mark.length)) {
      on.fill(true, at, at + mark.length);
    }
  }
  return on;
}

/** Splits `flags` into runs of the same value: [start, end, value]. */
function runs(flags: boolean[], from = 0, to = flags.length): [number, number, boolean][] {
  const out: [number, number, boolean][] = [];
  for (let start = from; start < to; ) {
    let end = start + 1;
    while (end < to && flags[end] === flags[start]) end++;
    out.push([start, end, flags[start]]);
    start = end;
  }
  return out;
}

export type Segment = { marked: boolean; parts: { text: string; comment: boolean }[] };

/**
 * One line of code in marked and unmarked stretches, each split into comment and code. The docs'
 * fences (below) and the builder's generated code (CodeLines) are both drawn from these.
 */
export function segments(line: string, comment: boolean[], mark: boolean[]): Segment[] {
  return runs(mark).map(([start, end, marked]) => ({
    marked,
    parts: runs(comment, start, end).map(([a, b, grey]) => ({ text: line.slice(a, b), comment: grey })),
  }));
}

const text = (value: string): Child => ({ type: 'text', value });
const element = (tagName: string, className: string, children: Child[]): Child => ({
  type: 'element',
  tagName,
  properties: { className: [className] },
  children,
});

function toHast(line: Segment[]): Child[] {
  return line.flatMap(({ marked, parts }) => {
    const nodes = parts.map((part) =>
      part.comment ? element('span', 'code-comment', [text(part.text)]) : text(part.text),
    );
    return marked ? [element('mark', 'code-mark', nodes)] : nodes;
  });
}

/**
 * Drops Shiki's token colors for the docs' two (grey comments and blue marks), and tells the `pre`
 * which language it holds, so the Pre component can pick a panel, a command box or an output box.
 */
export function transformerDocs(): Transformer {
  return {
    name: 'jev-docs',
    line(node) {
      let line = '';
      const comment: boolean[] = [];
      for (const token of node.children) {
        if (token.type !== 'element') continue;
        const value = token.children.map((child) => (child.type === 'text' ? child.value : '')).join('');
        const grey = String(token.properties.style ?? '').toLowerCase().includes(COMMENT.toLowerCase());
        line += value;
        for (let i = 0; i < value.length; i++) comment.push(grey);
      }
      const marks = typeof this.options.meta?.mark === 'string' ? this.options.meta.mark.split('|') : [];
      node.children = toHast(segments(line, comment, markedChars(line, marks)));
    },
    pre(node) {
      node.properties['data-lang'] = this.options.lang;
      delete node.properties.mark;
      delete node.properties.style;
      delete node.properties.class;
      delete node.properties.className;
    },
  };
}
