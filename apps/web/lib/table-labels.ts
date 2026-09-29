/**
 * Gives each table cell its column's header as `data-label`, for phones, where a table's rows
 * stack and each cell sits under that label (see components/docs/docs.css). A table of two columns
 * gets none: its first cell names the row and the second tells about it.
 */

/** What this reads of the page's hast tree. */
interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

export function rehypeTableLabels() {
  return (tree: Node) => {
    for (const table of find(tree, 'table')) {
      const [head, ...rows] = find(table, 'tr');
      const labels = head ? cells(head).map(text) : [];
      if (labels.length < 3) continue;
      for (const row of rows) {
        cells(row).forEach((cell, index) => {
          if (labels[index]) cell.properties = { ...cell.properties, dataLabel: labels[index] };
        });
      }
    }
  };
}

function find(node: Node, tagName: string): Node[] {
  return (node.children ?? []).flatMap((child) => (child.tagName === tagName ? [child] : find(child, tagName)));
}

function cells(row: Node): Node[] {
  return (row.children ?? []).filter((child) => child.tagName === 'th' || child.tagName === 'td');
}

function text(node: Node): string {
  return node.value ?? (node.children ?? []).map(text).join('').trim();
}
