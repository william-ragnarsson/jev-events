import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { manifest as packageManifest, manifestUrl as packageManifestUrl } from "@jev-events/slack";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CATALOG, INTEGRATIONS, twitchLogin, type IntegrationId } from "../lib/builder/catalog.js";
import {
  actionsFor,
  generate,
  identifier,
  recipeOptions,
  recipeQuestion,
  resolveQuestions,
  siteUrl,
  starter,
  valuesFor,
  type BuilderConfig,
  type Generated,
  type QuestionConfig,
  type RecipeEntry,
  type RuleConfig,
  type Target,
} from "../lib/builder/generate.js";
import { manifest, manifestUrl } from "../lib/builder/slack-manifest.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RECIPES = JSON.parse(readFileSync(join(ROOT, "apps/web/generated/recipes.json"), "utf8")) as RecipeEntry[];

/** What the builder opens with for an integration. */
function starterConfig(integration: IntegrationId, target: Target, extra: Partial<BuilderConfig> = {}): BuilderConfig {
  return { ...starter(integration, recipeOptions(RECIPES, CATALOG[integration].recipeGroup)), target, dryRun: true, ...extra };
}

/** Awkward things people type, which must still come out as working code. */
const AWKWARD: QuestionConfig[] = [
  { kind: "noul", id: "Needs my OK?", text: 'Is it "odd", with `backticks`, ${braces} and\na new line?' },
  { kind: "noul", id: "review", text: "" },
  {
    kind: "choice",
    id: "Kind",
    text: "",
    labels: [
      { name: "Bug report", description: "Something's broken" },
      { name: "bug-report", description: "" },
      { name: "🙂", description: "Just an emoji" },
    ],
  },
];

const SOURCE_VALUES: Partial<Record<IntegrationId, string>> = { slack: "general, #random", twitch: "https://www.twitch.tv/Jev_Events/" };

interface Case {
  name: string;
  config: BuilderConfig;
}

/** Every integration, source and target: as the builder opens, with everything picked, and with nothing to do. */
function cases(): Case[] {
  return INTEGRATIONS.flatMap((spec) =>
    spec.sources.flatMap((source) =>
      (["local", "users"] as const).flatMap((target): Case[] => {
        const questions = [...recipeOptions(RECIPES, spec.recipeGroup).map(recipeQuestion), ...AWKWARD];
        const events = resolveQuestions(spec.id, questions).flatMap((question) => question.events);
        // Every action the source can take, each on another answer, and your own code with a review band.
        const rules: RuleConfig[] = [
          ...actionsFor(spec.id, source.id).map((action, index) => ({ event: events[index % events.length]!, min: 0.8, review: 0.5, do: action.id })),
          { event: events.at(-1)!, min: 0.7, review: 0.4, do: "log" },
        ];
        const name = `${spec.id}-${source.id}-${target}`;
        return [
          { name: `${name}-starter`, config: starterConfig(spec.id, target, { source: source.id }) },
          {
            name: `${name}-everything`,
            config: { integration: spec.id, source: source.id, sourceValue: SOURCE_VALUES[spec.id], questions, rules, target, dryRun: false, site: "localhost:3000/" },
          },
          {
            name: `${name}-judged`,
            config: { integration: spec.id, source: source.id, questions: [{ kind: "noul", id: "", text: "" }], rules: [], target, dryRun: true },
          },
        ];
      }),
    ),
  );
}

const ALL = cases().map((entry) => ({ ...entry, generated: generate(entry.config) }));

function file(generated: Generated, path: string): string {
  const found = generated.files.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`No ${path} in ${generated.files.map((candidate) => candidate.path).join(", ")}`);
  return found.code;
}

/** Type-check the files with the compiler, as the project they're pasted into would. */
function typecheck(dir: string, rootNames: string[], settings: Record<string, unknown>): string {
  const converted = ts.convertCompilerOptionsFromJson(
    {
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      esModuleInterop: true,
      isolatedModules: true,
      noEmit: true,
      // The packages' own source, as `npm i` would install them.
      customConditions: ["source"],
      types: ["node"],
      typeRoots: [join(ROOT, "node_modules/@types")],
      paths: {
        "jev-events": [join(ROOT, "packages/core/src/index.ts")],
        "@jev-events/google": [join(ROOT, "packages/google/src/index.ts")],
        "@jev-events/slack": [join(ROOT, "packages/slack/src/index.ts")],
        "@jev-events/twitch": [join(ROOT, "packages/twitch/src/index.ts")],
        "next/server": [join(ROOT, "node_modules/next/server.d.ts")],
        pg: [join(ROOT, "node_modules/@types/pg/index.d.ts")],
      },
      ...settings,
    },
    dir,
  );
  if (converted.errors.length > 0) throw new Error(ts.flattenDiagnosticMessageText(converted.errors[0]!.messageText, "\n"));
  const program = ts.createProgram({ rootNames, options: converted.options });
  const mine = program.getSourceFiles().filter((source) => source.fileName.startsWith(dir));
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...mine.flatMap((source) => [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]),
  ];
  return ts.formatDiagnostics(diagnostics, { getCanonicalFileName: (name) => name, getCurrentDirectory: () => dir, getNewLine: () => "\n" });
}

function write(path: string, code: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, code);
  return path;
}

describe("the code the builder writes", () => {
  let dir: string;
  const local: string[] = [];
  const users: string[] = [];

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "jev-builder-")));
    // `npm pkg set type=module`, which the steps for your own machine include, for top-level await.
    write(join(dir, "local/package.json"), '{ "type": "module" }\n');
    for (const { name, config, generated } of ALL) {
      for (const output of generated.files) {
        if (output.lang !== "ts") continue;
        // `@/` is the Next.js app's root.
        const code = output.code.replace('"@/lib/jev"', '"../../../../lib/jev"');
        (config.target === "local" ? local : users).push(write(join(dir, config.target, name, output.path), code));
      }
    }
    // Stand-ins for the two packages the web app code imports that this repo doesn't install, so it runs.
    write(join(dir, "node_modules/pg/package.json"), '{ "name": "pg", "type": "module", "main": "index.js" }\n');
    write(join(dir, "node_modules/pg/index.js"), "export class Pool {\n  async query() {\n    return { rows: [], rowCount: 0 };\n  }\n}\n");
    write(join(dir, "node_modules/next/package.json"), '{ "name": "next", "type": "module" }\n');
    write(join(dir, "node_modules/next/server.js"), "export function after() {}\n");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("type-checks on your machine, where tsx runs monitor.ts", () => {
    expect(local.length).toBeGreaterThan(0);
    expect(typecheck(dir, local, { target: "es2023", lib: ["es2023"], module: "nodenext", moduleResolution: "nodenext", verbatimModuleSyntax: true })).toBe("");
  }, 120_000);

  it("type-checks in a Next.js app", () => {
    expect(users.length).toBeGreaterThan(0);
    // Next.js's own tsconfig.json.
    const next = { target: "es2017", lib: ["dom", "dom.iterable", "esnext"], module: "esnext", moduleResolution: "bundler", resolveJsonModule: true };
    expect(typecheck(dir, users, next)).toBe("");
  }, 120_000);

  it("builds every monitor it writes for your machine", async () => {
    for (const { name, config, generated } of ALL.filter((entry) => entry.config.target === "local")) {
      // Everything but the last two lines, which start it.
      const code = file(generated, "monitor.ts");
      const variable = CATALOG[config.integration].sources.find((source) => source.id === config.source)!.variable;
      const ending = new RegExp(`\\nawait ${variable}\\.start\\(\\);\\nconsole\\.log\\(".*"\\);\\n$`);
      expect(code, name).toMatch(ending);
      const path = write(join(dir, "run", `${name}.ts`), code.replace(ending, `\nexport default ${variable};\n`));
      const built = ((await import(pathToFileURL(path).href)) as { default: { start: unknown } }).default;
      expect(typeof built.start, name).toBe("function");
    }
  }, 60_000);

  it("serves the web app's routes, and turns connect links away until signIn.user is filled in", async () => {
    vi.stubEnv("JEV_EVENTS_URL", undefined);
    vi.stubEnv("JEV_EVENTS_KEY", Buffer.alloc(32, 7).toString("base64url"));
    vi.stubEnv("CRON_SECRET", "cron-secret");
    for (const spec of INTEGRATIONS) for (const variable of spec.env) vi.stubEnv(variable.name, `${variable.name.toLowerCase()}-value`);

    for (const { name, config } of ALL.filter((entry) => entry.config.target === "users")) {
      const spec = CATALOG[config.integration];
      const { jev } = (await import(pathToFileURL(join(dir, "users", name, "lib/jev.ts")).href)) as {
        jev: { handle: (request: Request) => Promise<Response> };
      };
      const site = siteUrl(config.site);
      const connect = await jev.handle(new Request(`${site}/api/jev/connect/${spec.integration}?returnTo=/settings`));
      expect(connect.status, name).toBe(401);
      if (spec.delivery === "poll") {
        const cron = await jev.handle(new Request(`${site}/api/jev/cron`));
        expect(cron.status, name).toBe(401);
      }
    }
  }, 60_000);

  it("schedules the cron route in vercel.json, and lists every variable in .env.example", () => {
    for (const { name, config, generated } of ALL.filter((entry) => entry.config.target === "users")) {
      const spec = CATALOG[config.integration];
      const paths = generated.files.map((output) => output.path);
      expect(paths.includes("vercel.json"), name).toBe(spec.delivery === "poll");
      expect(paths.includes("worker.ts"), name).toBe(spec.delivery === "stream");
      if (spec.delivery === "poll") {
        expect(JSON.parse(file(generated, "vercel.json")), name).toEqual({ crons: [{ path: "/api/jev/cron", schedule: "*/5 * * * *" }] });
      }
      const set = file(generated, ".env.example")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => line.slice(0, line.indexOf("=")));
      const needed = ["TYPESAFE_API_KEY", "DATABASE_URL", "JEV_EVENTS_KEY", ...(spec.delivery === "poll" ? ["CRON_SECRET"] : []), ...spec.env.map((variable) => variable.name)];
      expect(set.toSorted(), name).toEqual(needed.toSorted());
    }
  });

  it("gives steps with commands to run and links to follow", () => {
    for (const { name, generated } of ALL) {
      expect(generated.steps.length, name).toBeGreaterThan(2);
      for (const step of generated.steps) {
        expect(step.text.trim(), name).not.toBe("");
        expect(step.command ?? "", name).not.toMatch(/^\$ /m);
        for (const [, url] of step.text.matchAll(/\]\(([^)]*)\)/g)) expect(url, name).toMatch(/^https:\/\//);
      }
    }
  });
});

describe("the builder's starting point", () => {
  it.each(INTEGRATIONS.map((spec) => [spec.id] as const))("keeps every question and rule for %s", (integration) => {
    const spec = CATALOG[integration];
    const config = starterConfig(integration, "local");
    expect(config.questions).toHaveLength(spec.starter.questions.length);
    const code = file(generate(config), "monitor.ts");
    for (const rule of spec.starter.rules) expect(code).toContain(`.on(${JSON.stringify(rule.event)}, { min: ${rule.min} }`);
    expect(code).toContain("dryRun: true");
  });

  it("backfills on your machine when the source can, so there's something to see right away", () => {
    expect(file(generate(starterConfig("gmail", "local")), "monitor.ts")).toContain("source: google.gmail.inbox({ backfill: 5 }),");
    expect(file(generate(starterConfig("gmail", "users")), "lib/jev.ts")).toContain("source: google.gmail.inbox(),");
    expect(file(generate(starterConfig("twitch", "local")), "monitor.ts")).toContain("source: twitch.chat(),");
  });
});

describe("questions", () => {
  it("makes identifiers from what people type", () => {
    expect(identifier("Needs reply", "x")).toBe("needsReply");
    expect(identifier("URGENT", "x")).toBe("urgent");
    expect(identifier("needs_reply", "x")).toBe("needsReply");
    expect(identifier("Is it a bug?", "x")).toBe("isItABug");
    expect(identifier("3 things", "x")).toBe("things");
    expect(identifier("Crème brûlée", "x")).toBe("cremeBrulee");
    expect(identifier("🙂", "fallback")).toBe("fallback");
  });

  it("keeps ids unique and away from the built-in events", () => {
    const resolved = resolveQuestions("gmail", [
      { kind: "recipe", id: "kind", type: "choice", labels: ["work", "other"] },
      { kind: "noul", id: "Kind", text: "Is it a kind email?" },
      { kind: "noul", id: "error", text: "" },
      { kind: "recipe", id: "not valid", type: "noul", labels: [] },
    ]);
    expect(resolved.map((question) => question.id)).toEqual(["kind", "kind2", "errorQuestion"]);
    expect(resolved[0]!.events).toEqual(["kind:work", "kind:other"]);
    expect(resolved[0]!.code).toBe("recipes.email.kind");
    expect(resolved[1]!.code).toBe('noul("Is it a kind email?")');
    expect(resolved[2]!.code).toBe("noul()");
  });

  it("writes a choice with its labels as identifiers, and null for a label without a description", () => {
    const [question] = resolveQuestions("slack", [AWKWARD[2]!]);
    expect(question!.code).toBe(['choice("Which one fits best?", {', '  bugReport: "Something\'s broken",', "  bugReport2: null,", '  label3: "Just an emoji",', "})"].join("\n"));
    expect(question!.events).toEqual(["kind:bugReport", "kind:bugReport2", "kind:label3"]);
  });
});

describe("rules", () => {
  const code = (rules: RuleConfig[], source = "invites") =>
    file(
      generate({ integration: "calendar", source, questions: [{ kind: "recipe", id: "likelySales", type: "noul", labels: [] }], rules, target: "local", dryRun: true }),
      "monitor.ts",
    );

  it("drops rules for answers that no longer exist, and actions the source can't take", () => {
    expect(code([{ event: "gone", min: 0.5, do: "log" }])).toContain('.on("judged"');
    expect(code([{ event: "likelySales", min: 0.5, do: "decline" }], "events")).not.toContain("decline");
    expect(code([{ event: "likelySales", min: 0.5, do: "decline" }], "invites")).toContain("google.calendar.decline(");
  });

  it("keeps probabilities between 0 and 1, and a review band only below min", () => {
    expect(code([{ event: "likelySales", min: 1.5, review: 0.2, do: "log" }])).toContain('.on("likelySales", { min: 1, review: 0.2 }');
    expect(code([{ event: "likelySales", min: 0.8, review: 0.9, do: "log" }])).toContain('.on("likelySales", { min: 0.8 }');
    expect(code([{ event: "likelySales", review: 0.4, do: "log" }])).toContain('.on("likelySales", (e) =>');
    expect(code([{ event: "likelySales", min: 0.9, review: 0.5, do: "log" }])).toContain('.on("review", (e) =>');
  });

  it("only mentions dryRun when a native action runs", () => {
    expect(code([{ event: "likelySales", min: 0.5, do: "log" }])).not.toContain("dryRun");
    expect(code([{ event: "likelySales", min: 0.5, do: "decline" }])).toContain("dryRun: true,");
  });

  it("fills in missing values, and leaves one empty only where that's allowed", () => {
    const [accept, decline] = CATALOG.calendar.actions;
    expect(valuesFor(decline!, {})).toEqual({ comment: "Thanks, but I'll pass." });
    expect(valuesFor(accept!, { comment: "" })).toEqual({ comment: "" });
    const label = CATALOG.gmail.actions.find((action) => action.id === "label")!;
    expect(valuesFor(label, { name: "  " })).toEqual({ name: "Needs reply" });
  });
});

describe("inputs", () => {
  it("turns what people type as their site into an origin", () => {
    expect(siteUrl(undefined)).toBe("https://example.com");
    expect(siteUrl(" example.com/ ")).toBe("https://example.com");
    expect(siteUrl("http://localhost:3000//")).toBe("http://localhost:3000");
  });

  it("turns what people type as a Twitch channel into its login", () => {
    expect(twitchLogin("#Jev_Events")).toBe("jev_events");
    expect(twitchLogin("@jev_events")).toBe("jev_events");
    expect(twitchLogin("https://www.twitch.tv/Jev_Events/")).toBe("jev_events");
    expect(twitchLogin("  ")).toBe("");
  });
});

describe("the Slack manifest in the browser", () => {
  it.each([
    {},
    { name: "Acme Alerts!" },
    { requestUrl: "https://example.com/api/jev/webhook/slack", redirectUrls: ["https://example.com/api/jev/callback/slack"] },
  ])("is the one @jev-events/slack builds, for %j", (options) => {
    expect(manifest(options)).toEqual(packageManifest(options));
    expect(manifestUrl(options)).toBe(packageManifestUrl(options));
  });
});
