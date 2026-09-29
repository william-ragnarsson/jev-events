import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { INTEGRATIONS } from "../lib/builder/catalog.js";
import { agentPrompt, builderMarkdown, fence, stepsMarkdown } from "../lib/builder/markdown.js";
import { COMPONENTS, llmsText, type DocsData } from "../lib/llms.js";
import { site } from "../lib/site.js";

const WEB = fileURLToPath(new URL("../", import.meta.url));
const DOCS = join(WEB, "content/docs");

function json<T>(path: string): T {
  return JSON.parse(readFileSync(join(WEB, path), "utf8")) as T;
}

const DATA: DocsData = {
  snippets: json("generated/snippets.json"),
  recipes: json("generated/recipes.json"),
  dataset: json("generated/dataset.json"),
};

function pages(dir = DOCS): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".mdx") ? [path] : [];
  });
}

describe("the docs agents read", () => {
  const LEFT = new RegExp(`<(${COMPONENTS.join("|")})\\b`);

  it.each(pages().map((path) => [relative(DOCS, path), path]))("%s has no site components left", (_, path) => {
    const text = llmsText(readFileSync(path, "utf8"), DATA);
    expect(text).not.toMatch(LEFT);
  });

  it("has a page for every integration the builder knows, with the builder on it", () => {
    for (const spec of INTEGRATIONS) {
      const path = join(WEB, "content", `${spec.docs.replace(/^\/docs/, "docs")}.mdx`);
      expect(existsSync(path), path).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`<Builder integration="${spec.id}" />`);
    }
  });

  it("writes out a snippet's code", () => {
    const text = llmsText('Before\n\n<Snippet name="quickstart" title="monitor.ts" />\n\nAfter', DATA);
    expect(text).toContain('```ts title="monitor.ts"');
    expect(text).toContain(DATA.snippets.quickstart!.trim());
  });

  it("drops what only lays the page out, and reads props quoted either way", () => {
    const page = [
      "<Steps>",
      "",
      "## Install",
      "",
      '```ts title="monitor.ts" mark="twitch.chat()"',
      "twitch.chat();",
      "```",
      "",
      "</Steps>",
      "",
      "<Rows>",
      "",
      "- **Source** One row.",
      "",
      "</Rows>",
      "",
      `<Snippet name="quickstart" title="monitor.ts" mark='"some_live_channel"' />`,
    ].join("\n");
    const text = llmsText(page, DATA);
    expect(text).not.toMatch(/<\/?(Steps|Rows)>|mark=/);
    expect(text).toMatch(/^## Install\n\n```ts title="monitor.ts"\ntwitch\.chat\(\);\n```\n\n- \*\*Source\*\* One row\.\n\n/);
    expect(text).toContain(DATA.snippets.quickstart!.trim());
  });

  it("lists a recipe group with each label as its event", () => {
    const text = llmsText('<RecipeList group="email" />', DATA);
    expect(text).toContain("- `recipes.email.needsReply` (yes/no)");
    expect(text).toMatch(/`"kind:newsletter"`/);
  });

  it("writes out the builder's code both ways", () => {
    const text = llmsText('<Builder integration="gmail" />', DATA);
    expect(text).toContain("### On your machine");
    expect(text).toContain("npx jev-events auth google");
    expect(text).toContain('```ts title="monitor.ts"');
    expect(text).toContain("### In your web app");
    expect(text).toContain('```ts title="lib/jev.ts"');
    expect(text).toContain('```json title="vercel.json"');
    expect(text).toBe(builderMarkdown("gmail", DATA.recipes));
  });

  it("drops the agent prompt and fills in counts", () => {
    expect(llmsText('A<AgentPrompt />B', DATA)).toBe("AB");
    expect(llmsText('<Dataset field="items" />', DATA)).toBe(String(DATA.dataset.items));
    expect(llmsText('<Dataset field="otherLanguages" />', DATA)).toBe(String(DATA.dataset.languages - 1));
  });

  it("leaves what it doesn't know as it was", () => {
    for (const tag of ['<Snippet name="nope" />', '<Builder integration="fax" />', '<RecipeList group="nope" />', '<Dataset field="nope" />']) {
      expect(llmsText(tag, DATA)).toBe(tag);
    }
  });
});

describe("markdown for agents", () => {
  it("indents code to sit inside a list item", () => {
    const steps = Array.from({ length: 10 }, (_, index) => ({ text: `Step ${index + 1}`, command: "echo hi" }));
    const markdown = stepsMarkdown(steps);
    expect(markdown).toContain("1. Step 1\n\n   ```bash\n   echo hi\n   ```");
    expect(markdown).toContain("10. Step 10\n\n    ```bash\n    echo hi\n    ```");
  });

  it("fences code that has fences in it with more backticks", () => {
    expect(fence("md", "```ts\nx\n```\n")).toBe("````md\n```ts\nx\n```\n````");
  });

  it("asks when the prompt at the top of the docs is left empty", () => {
    const prompt = agentPrompt({ streams: [], goal: "  ", target: "local" });
    expect(prompt).toContain("What should happen: ask me, and suggest questions and actions that fit.");
    expect(prompt).toContain("What to watch: ask me: Gmail, Google Calendar, Slack, Twitch chat or something else.");
    expect(prompt).toContain("Where it runs: On my machine, with my own account.");
    expect(prompt).toContain(`${site.url}/llms-full.txt`);
    expect(prompt).toContain("Keep `dryRun: true`");
  });

  it("names what was picked, with each docs page", () => {
    const prompt = agentPrompt({ streams: ["gmail", "slack", "other"], goal: "Archive newsletters.", target: "users" });
    expect(prompt).toContain("What should happen: Archive newsletters.");
    expect(prompt).toContain(
      `What to watch: Gmail (${site.url}/docs/integrations/gmail), Slack (${site.url}/docs/integrations/slack) and another stream (${site.url}/docs/integrations/custom)`,
    );
    expect(prompt).toContain("each of them connects their own account");
  });
});
