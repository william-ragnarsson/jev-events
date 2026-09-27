/**
 * The builder's output as markdown, for people's coding agents: "Copy for your agent", the prompt
 * at the top of the docs, and the docs text agents read (`/llms-full.txt`), where the builder
 * itself can't render.
 */

import { site } from '../site.ts';
import { CATALOG, type IntegrationId, type Step } from './catalog.ts';
import { generate, recipeOptions, starter, type BuilderConfig, type Generated, type GeneratedFile, type RecipeEntry, type Target } from './generate.ts';

/** A fenced code block, indented to sit inside a list item. */
export function fence(lang: string, code: string, title?: string, indent = ''): string {
  const body = code.replace(/\n$/, '');
  const ticks = body.includes('```') ? '````' : '```';
  return [`${ticks}${lang}${title ? ` title="${title}"` : ''}`, ...body.split('\n'), ticks].map((line) => (line ? indent + line : line)).join('\n');
}

export function stepsMarkdown(steps: readonly Step[]): string {
  return steps
    .map((step, index) => {
      const marker = `${index + 1}. `;
      const indent = ' '.repeat(marker.length);
      return [
        marker + step.text,
        ...(step.command ? ['', fence('bash', step.command, undefined, indent)] : []),
        ...(step.value ? ['', fence('text', step.value, undefined, indent)] : []),
      ].join('\n');
    })
    .join('\n\n');
}

export function filesMarkdown(files: readonly GeneratedFile[]): string {
  return files.map((file) => fence(file.lang, file.code, file.path)).join('\n\n');
}

const WHERE: Record<Target, string> = {
  local: 'On your machine, with your own account',
  users: "In your web app, for your users' accounts",
};

/** What `<Builder integration="…" />` starts with, both ways, for the docs text agents read. */
export function builderMarkdown(integration: IntegrationId, entries: readonly RecipeEntry[]): string {
  const spec = CATALOG[integration];
  const base = starter(integration, recipeOptions(entries, spec.recipeGroup));
  return (['local', 'users'] as const)
    .map((target) => {
      const generated = generate({ ...base, target, dryRun: true });
      return [`### ${WHERE[target]}`, '', stepsMarkdown(generated.steps), '', filesMarkdown(generated.files)].join('\n');
    })
    .join('\n\n');
}

const DRY_RUN = 'Keep `dryRun: true`, so native actions only log what they would do. Never set `dryRun: false` unless I say so.';

/** "Copy for your agent": what the builder made, as instructions. */
export function builderPrompt(config: BuilderConfig, generated: Generated): string {
  const spec = CATALOG[config.integration];
  const where =
    config.target === 'local'
      ? `on my machine, with my own ${spec.name} account`
      : `in this Next.js app, so my users can connect their ${spec.name} accounts`;
  return [
    `Set up a Jev Events monitor for ${spec.name} ${where}. Jev Events asks Jev, TypeSafe's model, questions about each new ${spec.noun}, and acts on the answers.`,
    '',
    `Follow these steps, and use these files as they are. Stop and tell me when a step needs me, such as signing in, creating an app or pasting a key.${generated.acts ? ` ${DRY_RUN}` : ''}`,
    '',
    `Docs: ${site.url}${spec.docs}`,
    '',
    '## Steps',
    '',
    stepsMarkdown(generated.steps),
    '',
    '## Files',
    '',
    filesMarkdown(generated.files),
    '',
  ].join('\n');
}

/** A stream the docs prompt can name: an integration, or anything else. */
export type PromptStream = IntegrationId | 'other';

export interface PromptOptions {
  streams: readonly PromptStream[];
  /** What should happen, in the person's words. */
  goal: string;
  target: Target;
}

/** The prompt at the top of the docs, for any coding agent. */
export function agentPrompt(options: PromptOptions): string {
  const goal = options.goal.trim();
  const streams = options.streams.map((stream) =>
    stream === 'other' ? `another stream (${site.url}/docs/integrations/custom)` : `${CATALOG[stream].name} (${site.url}${CATALOG[stream].docs})`,
  );
  const target =
    options.target === 'local'
      ? 'On my machine, with my own account.'
      : 'In this web app, for my users: each of them connects their own account.';
  return [
    `Add Jev Events (${site.url}) to this project. It watches a stream, such as an inbox or a chat, asks Jev, TypeSafe's model, questions about each new item, and runs code on the answers.`,
    '',
    `What should happen: ${goal || 'ask me, and suggest questions and actions that fit.'}`,
    `What to watch: ${streams.length > 0 ? list(streams) : 'ask me: Gmail, Google Calendar, Slack, Twitch chat or something else.'}`,
    `Where it runs: ${target}`,
    '',
    'How:',
    `1. Read ${site.url}/llms-full.txt. It has every docs page, and each integration's page has complete, working code for both ways of running it.`,
    '2. Start from that code. Use the built-in recipes where one fits, and write your own questions with noul() or choice() where none does.',
    '3. Tell me each step that needs me, such as creating an app, signing in or getting a TypeSafe API key, with the exact commands.',
    `4. ${DRY_RUN}`,
    '',
  ].join('\n');
}

function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
