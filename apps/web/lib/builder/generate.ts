/**
 * Turns the code builder's choices into files and setup steps. It's pure, so the docs page and
 * `test/builder.test.ts`, which type-checks everything it writes, see the same output.
 */

import { BACKFILL, CATALOG, str, type ActionSpec, type IntegrationId, type IntegrationSpec, type SourceSpec, type Step } from './catalog.ts';

export type { Step };

/** Where the code runs: on your machine with your own account, or in your web app for your users. */
export type Target = 'local' | 'users';

export interface ChoiceLabel {
  name: string;
  /** What the label means, for Jev. Empty for a catch-all, such as "other". */
  description: string;
}

export type QuestionConfig =
  | { kind: 'recipe'; id: string; type: 'noul' | 'choice'; labels: readonly string[] }
  | { kind: 'noul'; id: string; text: string }
  | { kind: 'choice'; id: string; text: string; labels: readonly ChoiceLabel[] };

export interface RuleConfig {
  /** A yes/no question's id, or "<id>:<label>" for a choice. */
  event: string;
  /** Fire at this probability or higher. */
  min?: number;
  /** From this probability up to `min`, emit "review" instead. */
  review?: number;
  /** An action's id from the catalog, or "log" for your own code. */
  do: string;
  values?: Readonly<Record<string, string>>;
}

export interface BuilderConfig {
  integration: IntegrationId;
  /** A source's id from the catalog. */
  source: string;
  /** The source's input, such as Slack channels. */
  sourceValue?: string;
  questions: readonly QuestionConfig[];
  rules: readonly RuleConfig[];
  target: Target;
  dryRun: boolean;
  /** Where your web app runs, such as "https://example.com". */
  site?: string;
}

export interface GeneratedFile {
  path: string;
  lang: 'ts' | 'json' | 'dotenv';
  code: string;
}

export interface Generated {
  files: GeneratedFile[];
  steps: Step[];
  /** Whether a native action runs, so `dryRun` matters. */
  acts: boolean;
  /** The code the choices wrote, such as the question and its action, to mark where it appears. */
  marks: string[];
}

/** A recipe as `generated/recipes.json` lists it. */
export interface RecipeEntry {
  group: string;
  id: string;
  type: string;
  usage: string;
  instructions: unknown;
  criteria: unknown;
}

export interface RecipeOption {
  id: string;
  type: 'noul' | 'choice';
  /** A choice's labels. */
  labels: string[];
  /** What it asks Jev. */
  instructions: string;
}

/** The recipes the builder offers from a group: the yes/no and choice ones that take no argument. */
export function recipeOptions(entries: readonly RecipeEntry[], group: string): RecipeOption[] {
  return entries.flatMap((entry): RecipeOption[] => {
    if (entry.group !== group || entry.usage.includes('(') || !IDENTIFIER.test(entry.id)) return [];
    if (entry.type !== 'noul' && entry.type !== 'choice') return [];
    const labels = entry.type === 'choice' && entry.criteria && typeof entry.criteria === 'object' ? Object.keys(entry.criteria) : [];
    return [{ id: entry.id, type: entry.type, labels, instructions: typeof entry.instructions === 'string' ? entry.instructions : '' }];
  });
}

export function recipeQuestion(recipe: RecipeOption): QuestionConfig {
  return { kind: 'recipe', id: recipe.id, type: recipe.type, labels: recipe.labels };
}

/** What's picked in the builder: a question from the catalog's picks, how sure Jev has to be, and what to do. */
export interface Picks {
  /** The question's event, such as "kind:newsletter". */
  ask: string;
  /** What to do: an action's id, or "log" for your own code. */
  act: string;
  min: number;
  target: Target;
}

/** How sure Jev has to be, as the builder offers it. */
export const MINS = [0.7, 0.8, 0.9] as const;

/** What the builder starts with: the first question and the first thing to do, at 0.8. */
export function firstPicks(integration: IntegrationId, target: Target = 'local'): Picks {
  const { picks } = CATALOG[integration];
  return { ask: picks.ask[0]!.event, act: picks.act[0]!.do, min: 0.8, target };
}

/** The builder's picks as a configuration: one question, and one thing to do on its answer. */
export function pickedConfig(integration: IntegrationId, recipes: readonly RecipeOption[], picks: Picks): BuilderConfig {
  const spec = CATALOG[integration];
  const ask = spec.picks.ask.find((pick) => pick.event === picks.ask) ?? spec.picks.ask[0]!;
  const act = spec.picks.act.find((pick) => pick.do === picks.act) ?? spec.picks.act[0]!;
  const source = spec.sources[0]!;
  const { question } = ask;
  const recipe = 'recipe' in question ? recipes.find((option) => option.id === question.recipe) : undefined;
  const values = Object.fromEntries(Object.entries(act.values ?? {}).map(([key, value]) => [key, value.replaceAll('{name}', ask.name ?? '')]));
  return {
    integration,
    source: source.id,
    sourceValue: source.param?.default ?? '',
    questions: 'recipe' in question ? (recipe ? [recipeQuestion(recipe)] : []) : [{ kind: 'noul', id: question.id, text: question.noul }],
    rules: [{ event: ask.event, min: picks.min, do: act.do, values }],
    target: picks.target,
    dryRun: true,
  };
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Event names a monitor already has. A question with one of these names gets "Question" added. */
const SPECIAL = new Set(['judged', 'review', 'action', 'dropped', 'error']);

/** A camelCase identifier from what someone typed: "Needs reply" becomes `needsReply`. */
export function identifier(text: string, fallback: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word === word.toUpperCase() ? word.toLowerCase() : word));
  const joined = words
    .map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join('')
    .replace(/^[0-9]+/, '');
  return joined ? joined[0]!.toLowerCase() + joined.slice(1) : fallback;
}

function unique(id: string, used: Set<string>): string {
  let candidate = id;
  for (let n = 2; used.has(candidate); n++) candidate = `${id}${n}`;
  used.add(candidate);
  return candidate;
}

export interface ResolvedQuestion {
  /** Its key in `questions`: an identifier, unique in the monitor. */
  id: string;
  kind: QuestionConfig['kind'];
  type: 'noul' | 'choice';
  /** Its value in `questions`, which may span lines. */
  code: string;
  /** What it emits: the id for yes/no, and "<id>:<label>" for each label of a choice. */
  events: string[];
  /** The label names of a choice, as they appear in its events. */
  labels: string[];
}

/** The questions as the code will have them, with ids and labels made into unique identifiers. */
export function resolveQuestions(integration: IntegrationId, questions: readonly QuestionConfig[]): ResolvedQuestion[] {
  const spec = CATALOG[integration];
  const used = new Set<string>();
  return questions.flatMap((question, index): ResolvedQuestion[] => {
    if (question.kind === 'recipe' && !IDENTIFIER.test(question.id)) return [];
    const base = identifier(question.id, `question${index + 1}`);
    const id = unique(SPECIAL.has(base) ? `${base}Question` : base, used);
    switch (question.kind) {
      case 'recipe': {
        const labels = question.type === 'choice' ? [...question.labels] : [];
        return [{ id, kind: 'recipe', type: question.type, code: `recipes.${spec.recipeGroup}.${question.id}`, events: question.type === 'choice' ? labels.map((label) => `${id}:${label}`) : [id], labels }];
      }
      case 'noul': {
        const text = question.text.trim();
        return [{ id, kind: 'noul', type: 'noul', code: text ? `noul(${str(text)})` : 'noul()', events: [id], labels: [] }];
      }
      case 'choice': {
        const usedLabels = new Set<string>();
        const labels = question.labels.map((label, n) => ({ name: unique(identifier(label.name, `label${n + 1}`), usedLabels), description: label.description.trim() }));
        const code = [
          `choice(${str(question.text.trim() || 'Which one fits best?')}, {`,
          ...labels.map((label) => `  ${label.name}: ${label.description ? str(label.description) : 'null'},`),
          '})',
        ].join('\n');
        return [{ id, kind: 'choice', type: 'choice', code, events: labels.map((label) => `${id}:${label.name}`), labels: labels.map((label) => label.name) }];
      }
    }
  });
}

/** The actions that work on a source. */
export function actionsFor(integration: IntegrationId, source: string): ActionSpec[] {
  return CATALOG[integration].actions.filter((action) => !action.only || action.only.includes(source));
}

/** An action's inputs, with defaults for what's missing. An input without a placeholder can't be empty. */
export function valuesFor(action: ActionSpec, values: Readonly<Record<string, string>> = {}): Record<string, string> {
  return Object.fromEntries(
    action.params.map((param) => {
      const value = values[param.key] ?? param.default;
      return [param.key, value.trim() || param.placeholder !== undefined ? value : param.default];
    }),
  );
}

interface ResolvedRule {
  event: string;
  min?: number;
  review?: number;
  /** The native action's code, or undefined for your own code. */
  action?: string;
}

/** The rules that still make sense: their event exists and their action works on the source. */
function resolveRules(config: BuilderConfig, questions: readonly ResolvedQuestion[]): ResolvedRule[] {
  const events = new Set(questions.flatMap((question) => question.events));
  const actions = actionsFor(config.integration, config.source);
  return config.rules.flatMap((rule): ResolvedRule[] => {
    if (!events.has(rule.event)) return [];
    const action = actions.find((candidate) => candidate.id === rule.do);
    if (rule.do !== 'log' && !action) return [];
    const min = probability(rule.min);
    const review = min === undefined ? undefined : probability(rule.review);
    return [
      {
        event: rule.event,
        ...(min !== undefined ? { min } : {}),
        ...(review !== undefined && min !== undefined && review < min ? { review } : {}),
        ...(action ? { action: action.code(valuesFor(action, rule.values)) } : {}),
      },
    ];
  });
}

function probability(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/** "a", "a and b", "a, b and c" */
function list(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** Your site's origin, for redirect URLs: "example.com/" becomes "https://example.com". */
export function siteUrl(site: string | undefined): string {
  const trimmed = (site ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'https://example.com';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

interface Context {
  config: BuilderConfig;
  spec: IntegrationSpec;
  source: SourceSpec;
  questions: ResolvedQuestion[];
  rules: ResolvedRule[];
  /** Filled in as the monitor's code is written. */
  marks: string[];
}

/** The files and setup steps for a builder configuration. */
export function generate(config: BuilderConfig): Generated {
  const spec = CATALOG[config.integration];
  const source = spec.sources.find((candidate) => candidate.id === config.source) ?? spec.sources[0]!;
  const questions = resolveQuestions(config.integration, config.questions);
  const context: Context = { config: { ...config, source: source.id }, spec, source, questions, rules: [], marks: [] };
  context.rules = resolveRules(context.config, questions);
  const { files, steps } = config.target === 'local' ? local(context) : users(context);
  return { files, steps, acts: context.rules.some((rule) => rule.action), marks: context.marks };
}

function coreImports(context: Context, extra: readonly string[]): string {
  const names = new Set(['monitor', ...extra]);
  for (const question of context.questions) names.add(question.kind === 'recipe' ? 'recipes' : question.kind);
  return `import { ${[...names].sort().join(', ')} } from "jev-events";`;
}

/** `const <variable> = monitor({ … }).on(…)` */
function monitorCode(context: Context): string[] {
  const { config, spec, source, questions, rules, marks } = context;
  const backfill = config.target === 'local' && source.backfill ? BACKFILL : undefined;
  const lines = [`const ${source.variable} = monitor({`];
  if (backfill) lines.push(`  // ${source.backfill}, so there's something to see right away.`);
  lines.push(`  source: ${source.code(config.sourceValue ?? '', backfill)},`);
  lines.push('  questions: {');
  for (const question of questions) {
    lines.push(`    ${question.id}: ${question.code.replaceAll('\n', '\n    ')},`);
    marks.push(`${question.id}: ${question.code.split('\n')[0]}`);
  }
  lines.push('  },');
  if (rules.some((rule) => rule.action)) {
    lines.push(
      config.dryRun
        ? '  // Native actions only log what they would do until you set dryRun: false.'
        : "  // Native actions run for real. Set dryRun: true to only log what they'd do.",
    );
    lines.push(`  dryRun: ${config.dryRun},`);
  }

  // Your own code, which prints what it's given, such as "[needsReply] Q3 deck".
  const who = config.target === 'users' ? '${e.connection?.userId}: ' : '';
  const handler = (label: string, note: string, more = '') => {
    const print = `console.log(\`[${label}] ${who}${spec.describeItem}\`${more})`;
    marks.push(print);
    return [`(e) => {`, `    // ${note}`, `    ${print};`, '  }'].join('\n');
  };

  const handlers: string[] = [];
  for (const rule of rules) {
    const policy = [...(rule.min !== undefined ? [`min: ${rule.min}`] : []), ...(rule.review !== undefined ? [`review: ${rule.review}`] : [])];
    const on = `${str(rule.event)}${policy.length > 0 ? `, { ${policy.join(', ')} }` : ''}`;
    marks.push(on);
    if (rule.action) marks.push(rule.action);
    const run = rule.action ?? handler(rule.event, `Your own code: e.item is the ${spec.noun}, and e.answers has every answer.`);
    handlers.push(`  .on(${on}, ${run})`);
  }
  if (rules.some((rule) => rule.review !== undefined)) {
    handlers.push(`  .on("review", ${handler('review: ${e.trigger.event}', 'Unsure answers, between review and min. e.trigger says which.')})`);
  }
  if (rules.length === 0) {
    handlers.push(`  .on("judged", ${handler('judged', `Every ${spec.noun} Jev judged, with its answers.`, ', e.answers')})`);
  }
  lines.push('})', ...handlers.flatMap((code) => code.split('\n')));
  lines[lines.length - 1] += ';';
  return lines;
}

/** What you see once it runs. `show` words where it shows up: "It prints what fired." */
function outcome(context: Context, show: (what: string) => string): string {
  const { config, spec, rules } = context;
  if (rules.length === 0) return show(`each ${spec.noun} with its answers`);
  const acts = rules.some((rule) => rule.action);
  return [
    ...(rules.some((rule) => !rule.action) ? [show('what fired')] : []),
    ...(acts
      ? [config.dryRun ? 'Native actions log a `[dry-run] would …` line instead of running. When those look right, set `dryRun: false`.' : 'Native actions run for real.']
      : []),
  ].join(' ');
}

function local(context: Context): Pick<Generated, 'files' | 'steps'> {
  const { config, spec, source } = context;
  const code = [
    coreImports(context, []),
    `import { ${spec.ns} } from "${spec.pkg}";`,
    '',
    ...monitorCode(context),
    '',
    `await ${source.variable}.start();`,
    `console.log(${str(source.watching)});`,
    '',
  ].join('\n');
  return {
    files: [{ path: 'monitor.ts', lang: 'ts', code }],
    steps: [
      {
        text: 'Make a folder for it, and install Jev Events and `tsx`, which runs TypeScript. Jev Events needs Node.js 22 or newer.',
        command: ['mkdir my-monitor && cd my-monitor', 'npm init -y && npm pkg set type=module', `npm i jev-events ${spec.pkg} tsx`].join('\n'),
      },
      { text: spec.signIn, command: `npx jev-events auth ${spec.integration}` },
      {
        text: 'Put your [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) in `.env`.',
        command: 'echo "TYPESAFE_API_KEY=<your key>" >> .env',
      },
      { text: 'Save the code as `monitor.ts`, and run it.', command: 'npx tsx --env-file=.env monitor.ts' },
      { text: outcome(context, (what) => `It prints ${what}.`) },
    ],
  };
}

function users(context: Context): Pick<Generated, 'files' | 'steps'> {
  const { config, spec, source } = context;
  const stream = spec.delivery === 'stream';
  const site = siteUrl(config.site);
  const base = `${site}/api/jev`;
  const callback = `${base}/callback/${spec.integration}`;
  const webhook = spec.delivery === 'webhook';

  const jev = [
    coreImports(context, ['postgresStore', 'runtime']),
    `import { ${spec.ns} } from "${spec.pkg}";`,
    ...(webhook ? ['import { after } from "next/server";'] : []),
    'import { Pool } from "pg";',
    '',
    ...monitorCode(context),
    '',
    'export const jev = runtime({',
    `  monitors: [${source.variable}],`,
    '  // Every connection, its tokens (encrypted with JEV_EVENTS_KEY)',
    "  // and where it's up to.",
    '  store: postgresStore(new Pool({ connectionString: process.env.DATABASE_URL })),',
    `  // Reads ${list(spec.env.map((variable) => variable.name))}.`,
    `  apps: [${spec.app}],`,
    '  signIn: {',
    "    // Who's signed in to your product. Replace this with your auth library's",
    '    // session lookup, such as `async () => (await auth())?.user?.id`.',
    '    // Until then, connect links answer 401.',
    '    user: async () => undefined,',
    '  },',
    ...(webhook ? ['  // Slack wants an answer within 3 seconds, so each message is judged after.', '  waitUntil: after,'] : []),
    '});',
    '',
  ].join('\n');

  const route = [
    'import { jev } from "@/lib/jev";',
    '',
    'export const GET = jev.handle;',
    'export const POST = jev.handle;',
    ...(spec.delivery === 'poll'
      ? ['', '// Seconds this function may run. A cron call stops checking after 50,', '// so this leaves room.', 'export const maxDuration = 60;']
      : webhook
        ? ['', '// Seconds this function may run, including judging after Slack has its answer.', 'export const maxDuration = 60;']
        : []),
    '',
  ].join('\n');

  const env = [
    '# Your TypeSafe API key: docs.typesafe.ai/introduction/quickstart',
    'TYPESAFE_API_KEY=',
    '# Postgres, where connections and their tokens are kept',
    'DATABASE_URL=',
    '# Encrypts tokens in the database. Print one with: npx jev-events key',
    'JEV_EVENTS_KEY=',
    ...(spec.delivery === 'poll' ? ['# Any long random string. The cron job sends it as', '# Authorization: Bearer <CRON_SECRET>', 'CRON_SECRET='] : []),
    ...spec.env.flatMap((variable) => [...(variable.comment ? [`# ${variable.comment}`] : []), `${variable.name}=`]),
    '# Where /api/jev is served. Only needed for connectUrl(),',
    '# or when a proxy changes the host',
    `# JEV_EVENTS_URL=${base}`,
    '',
  ].join('\n');

  const files: GeneratedFile[] = [
    { path: 'lib/jev.ts', lang: 'ts', code: jev },
    { path: 'app/api/jev/[...path]/route.ts', lang: 'ts', code: route },
  ];
  if (spec.delivery === 'poll') {
    files.push({ path: 'vercel.json', lang: 'json', code: `${JSON.stringify({ crons: [{ path: '/api/jev/cron', schedule: '*/5 * * * *' }] }, null, 2)}\n` });
  }
  if (stream) {
    files.push({
      path: 'worker.ts',
      lang: 'ts',
      code: [
        'import { jev } from "./lib/jev";',
        '',
        "// Chat needs a connection that stays open, which serverless functions can't",
        '// hold. This process keeps one open for every connected account, and picks',
        '// up new connections by itself.',
        'jev.start().catch((error: unknown) => {',
        '  console.error(error);',
        '  process.exit(1);',
        '});',
        '',
      ].join('\n'),
    });
  }
  files.push({ path: '.env.example', lang: 'dotenv', code: env });

  const install: Step = {
    text: 'In your Next.js app, install Jev Events, the integration and a Postgres client. Jev Events needs Node.js 22 or newer.',
    command: [`npm i jev-events ${spec.pkg} pg${stream ? ' tsx' : ''}`, 'npm i -D @types/pg'].join('\n'),
  };
  const place: Step = {
    text: `Add each file at its path. If your app keeps its code in \`src/\`, put \`lib/\` and \`app/\` in there${stream ? ', and import `./src/lib/jev` in `worker.ts`' : ''}.`,
  };
  const envStep: Step = {
    text: 'Copy `.env.example` to `.env.local` and fill it in, then set the same variables where you deploy. This prints a `JEV_EVENTS_KEY`:',
    command: 'npx jev-events key',
  };
  const signInStep: Step = {
    text: "In `lib/jev.ts`, replace the `signIn.user` stub with your auth library's session lookup, so each connection belongs to the right user.",
  };
  const connect: Step = {
    text: `Link signed-in users to the connect route, for example from your settings page. They come back to \`returnTo\` with \`?connected=${spec.integration}\`, or with \`?connect_error=cancelled\` or \`?connect_error=failed\` when it didn't work.`,
    value: `<a href="/api/jev/connect/${spec.integration}?returnTo=/settings">${spec.connectLabel}</a>`,
  };
  const seen = outcome(context, (what) => `Your logs show ${what}.`);

  const steps: Step[] = [install, place, ...spec.createApp({ callback, webhook: `${base}/webhook/${spec.integration}` }), envStep, signInStep];
  switch (spec.delivery) {
    case 'poll':
      steps.push(
        connect,
        {
          text: 'Deploy. On the Vercel Pro plan, `vercel.json` has Vercel call the cron route every 5 minutes. Hobby runs crons once a day, and fails the deploy on a more frequent schedule, so there, or on another host, delete `vercel.json` and have a scheduler such as cron-job.org send this every few minutes:',
          command: `curl -H "Authorization: Bearer $CRON_SECRET" ${base}/cron`,
        },
        { text: `${spec.tryIt} The next cron call judges it. ${seen}` },
      );
      break;
    case 'webhook':
      steps.push(
        {
          text: "Deploy. Then retry the Request URL on your app's Event Subscriptions page: Slack checks it once your site answers there.",
          value: `${base}/webhook/${spec.integration}`,
        },
        connect,
        { text: `${spec.tryIt} ${spec.name} sends it right away. ${seen}` },
      );
      break;
    case 'stream':
      steps.push(
        connect,
        {
          text: 'Deploy the site. Then run the worker on a host that keeps a process running, such as Railway, Fly.io or a VPS, with the same environment variables:',
          command: 'npx tsx worker.ts',
        },
        { text: `${spec.tryIt} The worker judges each ${spec.noun} as it arrives. ${seen}` },
      );
      break;
  }
  return { files, steps };
}
