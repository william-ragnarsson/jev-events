import { describe, expect, it } from "vitest";

import { codeWords } from "../lib/code-words.js";
import { rehypeTableLabels } from "../lib/table-labels.js";

type Node = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Node[] };

const el = (tagName: string, children: Node[] = []): Node => ({ type: "element", tagName, properties: {}, children });
const text = (value: string): Node => ({ type: "text", value });

/** A page holding one table. */
function page(head: string[], ...rows: string[][]): Node {
  const row = (tag: string, cells: string[]) => el("tr", cells.map((cell) => el(tag, cell ? [text(cell)] : [])));
  const table = el("table", [el("thead", [row("th", head)]), el("tbody", rows.map((cells) => row("td", cells)))]);
  return { type: "root", children: [table] };
}

function labels(tree: Node): unknown[][] {
  rehypeTableLabels()(tree);
  const body = tree.children![0]!.children![1]!;
  return body.children!.map((tr) => tr.children!.map((td) => td.properties?.dataLabel));
}

describe("tables on a phone", () => {
  it("label each cell with its column's header", () => {
    const tree = page(["Question", "Shorthand", "Means"], ["noul", "0.93", "The probability of yes"]);
    expect(labels(tree)).toEqual([["Question", "Shorthand", "Means"]]);
  });

  it("leave a blank header's cells unlabelled", () => {
    const tree = page(["Flag", "Default", ""], ["--min", "0.8", "How sure Jev has to be"]);
    expect(labels(tree)).toEqual([["Flag", "Default", undefined]]);
  });

  it("leave a table of two columns alone, since its rows already read as a name and what it is", () => {
    const tree = page(["Option", "What it does"], ["secret", "Require a bearer token"]);
    expect(labels(tree)).toEqual([[undefined, undefined]]);
  });
});

describe("inline code", () => {
  it("keeps short code on one line", () => {
    expect(codeWords("npx jev-events watch")).toEqual(["npx jev-events watch"]);
    expect(codeWords('{ "text": "..." }')).toEqual(['{ "text": "..." }']);
  });

  it("wraps longer code only at its spaces, keeping brackets with their words", () => {
    expect(codeWords("{ query: (text, values) => sql.unsafe(text, values) }")).toEqual([
      "{ query:",
      "(text,",
      "values)",
      "=>",
      "sql.unsafe(text,",
      "values) }",
    ]);
  });
});
