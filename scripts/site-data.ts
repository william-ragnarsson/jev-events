/**
 * Data the website shows, taken from the code itself so the two never drift:
 *   apps/web/generated/recipes.json   every recipe, exactly as the library defines it
 *   apps/web/generated/relay.json     the source of the live feed's judge, shown on the landing page
 *   apps/web/generated/snippets.json  apps/web/snippets/*.ts (type-checked), minus `// @hide` lines
 *   apps/web/generated/dataset.json   counts from the chat eval set, so the site never overstates it
 *
 * Run `npm run site:data` after changing either; a test fails when the files are stale.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { recipes, type Question } from "jev-events";

import { FLAGS, hasFlag, loadDataset } from "../evals/lib/dataset.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const GENERATED = `${ROOT}apps/web/generated/`;
const RELAY_SOURCE = "apps/live-relay/src/judge.ts";

export interface RecipeEntry {
  /** How you'd write it, e.g. `recipes.chat.hateful` or `recipes.chat.spoiler("Elden Ring")`. */
  usage: string;
  group: string;
  id: string;
  type: Question["type"];
  instructions: unknown;
  criteria: unknown;
}

export function recipeEntries(): RecipeEntry[] {
  const entries: RecipeEntry[] = [];
  for (const [group, members] of Object.entries(recipes)) {
    for (const [id, value] of Object.entries(members as Record<string, unknown>)) {
      const example = typeof value === "function" ? '"Elden Ring"' : undefined;
      const question = (typeof value === "function" ? (value as (subject: string) => Question)("Elden Ring") : value) as Question;
      entries.push({
        usage: `recipes.${group}.${id}${example ? `(${example})` : ""}`,
        group,
        id,
        type: question.type,
        instructions: question.instructions ?? null,
        criteria: question.criteria ?? null,
      });
    }
  }
  return entries;
}

/** Snippets are real modules so the compiler checks them; declarations they need are hidden. */
export function snippets(): Record<string, string> {
  const dir = `${ROOT}apps/web/snippets/`;
  const result: Record<string, string> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".ts")).sort()) {
    let hiding = false;
    const lines = readFileSync(`${dir}${file}`, "utf8")
      .split("\n")
      .filter((line) => {
        if (line.trim() === "// @hide-start") return !(hiding = true);
        if (line.trim() === "// @hide-end") return (hiding = false);
        return !hiding && !line.trimEnd().endsWith("// @hide");
      });
    result[file.replace(/\.ts$/, "")] = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return result;
}

export function datasetSummary() {
  const examples = loadDataset(`${ROOT}evals/datasets/chat.jsonl`);
  const tags: Record<string, number> = {};
  for (const example of examples) for (const tag of example.tags ?? []) tags[tag] = (tags[tag] ?? 0) + 1;
  return {
    items: examples.length,
    borderline: examples.filter((example) => example.borderline).length,
    languages: new Set(examples.map((example) => example.lang)).size,
    nonEnglish: examples.filter((example) => example.lang !== "en").length,
    flags: Object.fromEntries(FLAGS.map((flag) => [flag, examples.filter((example) => hasFlag(example, flag)).length])),
    tags,
  };
}

export function siteData(): Record<string, unknown> {
  return {
    "recipes.json": recipeEntries(),
    "relay.json": { path: RELAY_SOURCE, source: readFileSync(`${ROOT}${RELAY_SOURCE}`, "utf8") },
    "snippets.json": snippets(),
    "dataset.json": datasetSummary(),
  };
}

export const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [file, value] of Object.entries(siteData())) {
    writeFileSync(`${GENERATED}${file}`, serialize(value));
    process.stdout.write(`wrote apps/web/generated/${file}\n`);
  }
}
