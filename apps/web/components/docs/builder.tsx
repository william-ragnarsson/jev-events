'use client';

import { CodeBlockTab, CodeBlockTabs, CodeBlockTabsList, CodeBlockTabsTrigger } from 'fumadocs-ui/components/codeblock';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Plus, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import recipeEntries from '@/generated/recipes.json';
import { CATALOG, type ActionSpec, type IntegrationId, type ParamSpec } from '@/lib/builder/catalog';
import {
  actionsFor,
  generate,
  recipeOptions,
  recipeQuestion,
  resolveQuestions,
  starter,
  type BuilderConfig,
  type ChoiceLabel,
  type GeneratedFile,
  type QuestionConfig,
  type RecipeOption,
  type ResolvedQuestion,
  type RuleConfig,
  type Step,
  type Target,
} from '@/lib/builder/generate';
import { builderPrompt } from '@/lib/builder/markdown';
import { cn } from '@/lib/cn';
import { CopyButton, INPUT, Segmented } from './controls';

interface QuestionState {
  /** Stays the same while the question is edited, so rules keep pointing at it. */
  key: string;
  config: QuestionConfig;
  /** Your own choice's labels, the same way. */
  labelKeys: string[];
}

interface RuleState {
  key: string;
  /** Its question's key. */
  question: string;
  /** For a choice: a recipe's label, or your own label's key. */
  label?: string;
  min: string;
  review: string;
  /** An action's id, or "log" for your own code. */
  do: string;
  values: Record<string, string>;
}

interface State {
  target: Target;
  source: string;
  sourceValue: string;
  questions: QuestionState[];
  rules: RuleState[];
  dryRun: boolean;
  site: string;
}

let added = 0;
/** A key for something added in the browser. The first render's keys are `s0`, `s1`… so the server's match. */
const newKey = () => `n${++added}`;

function labelRef(question: QuestionState, index: number): string | undefined {
  return question.config.kind === 'choice' ? question.labelKeys[index] : question.config.kind === 'recipe' ? question.config.labels[index] : undefined;
}

function labelIndex(question: QuestionState, label: string | undefined): number {
  if (label === undefined) return -1;
  return question.config.kind === 'choice' ? question.labelKeys.indexOf(label) : question.config.kind === 'recipe' ? question.config.labels.indexOf(label) : -1;
}

function initial(integration: IntegrationId, recipes: readonly RecipeOption[]): State {
  const base = starter(integration, recipes);
  let count = 0;
  const key = () => `s${count++}`;
  const questions = base.questions.map((config) => ({ key: key(), config, labelKeys: config.kind === 'choice' ? config.labels.map(() => key()) : [] }));
  const resolved = resolveQuestions(integration, base.questions);
  const rules = base.rules.flatMap((rule): RuleState[] => {
    const index = resolved.findIndex((question) => question.events.includes(rule.event));
    const question = questions[index];
    const names = resolved[index];
    if (!question || !names) return [];
    const label = names.type === 'choice' ? labelRef(question, names.events.indexOf(rule.event)) : undefined;
    return [
      {
        key: key(),
        question: question.key,
        ...(label !== undefined ? { label } : {}),
        min: rule.min?.toString() ?? '',
        review: rule.review?.toString() ?? '',
        do: rule.do,
        values: { ...rule.values },
      },
    ];
  });
  return { target: 'local', source: base.source, sourceValue: base.sourceValue ?? '', questions, rules, dryRun: true, site: '' };
}

/** The event a rule listens to, such as "needsReply" or "kind:newsletter", by the code's names. */
function eventOf(rule: RuleState, questions: readonly QuestionState[], resolved: readonly ResolvedQuestion[]): string | undefined {
  const index = questions.findIndex((question) => question.key === rule.question);
  const question = questions[index];
  const names = resolved[index];
  if (!question || !names) return undefined;
  return names.type === 'noul' ? names.id : names.events[labelIndex(question, rule.label)];
}

function number(text: string): number | undefined {
  const value = Number.parseFloat(text);
  return Number.isFinite(value) ? value : undefined;
}

function toConfig(integration: IntegrationId, state: State, resolved: readonly ResolvedQuestion[]): BuilderConfig {
  const rules = state.rules.flatMap((rule): RuleConfig[] => {
    const event = eventOf(rule, state.questions, resolved);
    const min = number(rule.min);
    const review = number(rule.review);
    return event ? [{ event, ...(min !== undefined ? { min } : {}), ...(review !== undefined ? { review } : {}), do: rule.do, values: rule.values }] : [];
  });
  return {
    integration,
    source: state.source,
    sourceValue: state.sourceValue,
    questions: state.questions.map((question) => question.config),
    rules,
    target: state.target,
    dryRun: state.dryRun,
    site: state.site,
  };
}

function defaults(action: ActionSpec | undefined): Record<string, string> {
  return Object.fromEntries((action?.params ?? []).map((param) => [param.key, param.default]));
}

/**
 * Pick what to watch, what to ask and what to do, and get the code with the steps to run it:
 * on your own machine, or in your web app for your users.
 */
export function Builder({ integration }: { integration: IntegrationId }) {
  const spec = CATALOG[integration];
  const recipes = useMemo(() => recipeOptions(recipeEntries, spec.recipeGroup), [spec.recipeGroup]);
  const [state, setState] = useState(() => initial(integration, recipes));
  const resolved = useMemo(() => resolveQuestions(integration, state.questions.map((question) => question.config)), [integration, state.questions]);
  const config = useMemo(() => toConfig(integration, state, resolved), [integration, state, resolved]);
  const generated = useMemo(() => generate(config), [config]);
  const actions = actionsFor(integration, state.source);
  const source = spec.sources.find((candidate) => candidate.id === state.source) ?? spec.sources[0]!;

  const update = (change: (state: State) => Partial<State>) => setState((current) => ({ ...current, ...change(current) }));
  const setQuestion = (key: string, change: (question: QuestionState) => QuestionState) =>
    update((current) => ({ questions: current.questions.map((question) => (question.key === key ? change(question) : question)) }));
  const removeQuestion = (key: string) =>
    update((current) => ({
      questions: current.questions.filter((question) => question.key !== key),
      rules: current.rules.filter((rule) => rule.question !== key),
    }));
  const setRule = (key: string, change: Partial<RuleState>) =>
    update((current) => ({ rules: current.rules.map((rule) => (rule.key === key ? { ...rule, ...change } : rule)) }));

  // Every event a rule can listen to, by question.
  const events = state.questions.flatMap((question, index) => {
    const names = resolved[index];
    if (!names) return [];
    if (names.type === 'noul') return [{ value: question.key, question: question.key, label: undefined, name: names.id }];
    return names.events.map((name, n) => ({ value: `${question.key}|${labelRef(question, n)}`, question: question.key, label: labelRef(question, n), name }));
  });
  const lastQuestion = state.questions.length === 1;

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border bg-fd-card text-sm">
      <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
        <Segmented
          label="Where it runs"
          value={state.target}
          onChange={(target) => update(() => ({ target }))}
          options={[
            { value: 'local', label: 'On my machine' },
            { value: 'users', label: 'For my users' },
          ]}
        />
        <p className="text-fd-muted-foreground">
          {state.target === 'local'
            ? `With your own ${spec.name}, on your computer. The quickest way to try it.`
            : `In your Next.js app, where each of your users connects their own ${spec.name}.`}
        </p>
      </div>

      <Section title="What to watch">
        {spec.sources.length > 1 ? (
          <div className="flex flex-col gap-2">
            {spec.sources.map((candidate) => (
              <label key={candidate.id} className="flex cursor-pointer items-start gap-2.5">
                <input
                  type="radio"
                  name={`${integration}-source`}
                  className="mt-1 accent-(--color-fd-primary)"
                  checked={candidate.id === state.source}
                  onChange={() =>
                    update((current) => {
                      const available = actionsFor(integration, candidate.id).map((action) => action.id);
                      return {
                        source: candidate.id,
                        sourceValue: candidate.param?.default ?? '',
                        rules: current.rules.map((rule) => (rule.do === 'log' || available.includes(rule.do) ? rule : { ...rule, do: 'log', values: {} })),
                      };
                    })
                  }
                />
                <span>
                  <span className="font-medium">{candidate.label}</span>
                  <span className="block text-fd-muted-foreground">{candidate.describe}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p>
            <span className="font-medium">{source.label}.</span> <span className="text-fd-muted-foreground">{source.describe}</span>
          </p>
        )}
        {source.param ? (
          <Field label={source.param.label} className="mt-3 max-w-sm">
            <TextInput param={source.param} value={state.sourceValue} onChange={(sourceValue) => update(() => ({ sourceValue }))} />
          </Field>
        ) : null}
        <Sample from={spec.sample.from} title={spec.sample.title} text={spec.sample.text} noun={spec.noun} />
      </Section>

      <Section title="What to ask" hint={`Jev answers every question about each ${spec.noun}, in one request.`}>
        <div className="flex flex-col gap-2">
          {recipes.map((recipe) => {
            const chosen = state.questions.find((question) => question.config.kind === 'recipe' && question.config.id === recipe.id);
            return (
              <label key={recipe.id} className={cn('flex items-start gap-2.5', chosen && lastQuestion ? 'cursor-not-allowed' : 'cursor-pointer')}>
                <input
                  type="checkbox"
                  className="mt-1 accent-(--color-fd-primary)"
                  checked={chosen !== undefined}
                  disabled={chosen !== undefined && lastQuestion}
                  title={chosen && lastQuestion ? 'A monitor asks at least one question.' : undefined}
                  onChange={() =>
                    chosen
                      ? removeQuestion(chosen.key)
                      : update((current) => ({ questions: [...current.questions, { key: newKey(), config: recipeQuestion(recipe), labelKeys: [] }] }))
                  }
                />
                <span className="min-w-0">
                  <code className="font-mono text-[13px]">recipes.{spec.recipeGroup}.{recipe.id}</code>
                  <span className="text-fd-muted-foreground"> · {recipe.type === 'noul' ? 'yes/no' : 'choice'}</span>
                  <span className="block text-fd-muted-foreground">
                    {recipe.instructions}
                    {recipe.labels.length > 0 ? <span className="font-mono text-xs"> {recipe.labels.join(' · ')}</span> : null}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {state.questions.some((question) => question.config.kind !== 'recipe') ? (
          <div className="mt-4 flex flex-col gap-3">
            {state.questions.map((question) =>
              question.config.kind === 'recipe' ? null : (
                <OwnQuestion
                  key={question.key}
                  question={question}
                  removable={!lastQuestion}
                  onChange={(change) => setQuestion(question.key, change)}
                  onRemove={() => removeQuestion(question.key)}
                  onRemoveLabel={(labelKey) =>
                    update((current) => ({ rules: current.rules.filter((rule) => rule.question !== question.key || rule.label !== labelKey) }))
                  }
                />
              ),
            )}
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            onClick={() => update((current) => ({ questions: [...current.questions, { key: newKey(), config: { kind: 'noul', id: '', text: '' }, labelKeys: [] }] }))}
          >
            <Plus className="size-3.5" /> Your own yes/no question
          </button>
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            onClick={() =>
              update((current) => ({
                questions: [
                  ...current.questions,
                  {
                    key: newKey(),
                    config: {
                      kind: 'choice',
                      id: '',
                      text: '',
                      labels: [
                        { name: '', description: '' },
                        { name: 'other', description: '' },
                      ],
                    },
                    labelKeys: [newKey(), newKey()],
                  },
                ],
              }))
            }
          >
            <Plus className="size-3.5" /> Your own choice
          </button>
        </div>
      </Section>

      <Section title="What to do" hint="Each rule runs when an answer is likely enough. Leave the rules out to print every answer.">
        {state.rules.length > 0 ? (
          <div className="flex flex-col gap-3">
            {state.rules.map((rule) => {
              const action = actions.find((candidate) => candidate.id === rule.do);
              const choice = rule.label !== undefined;
              return (
                <div key={rule.key} className="rounded-lg border bg-fd-background p-3">
                  <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                    <Field label="When">
                      <Select
                        value={rule.label !== undefined ? `${rule.question}|${rule.label}` : rule.question}
                        onChange={(value) => {
                          const event = events.find((candidate) => candidate.value === value);
                          if (event) setRule(rule.key, { question: event.question, label: event.label });
                        }}
                      >
                        {events.map((event) => (
                          <option key={event.value} value={event.value}>
                            {event.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="At least" hint="From 0 to 1">
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        inputMode="decimal"
                        value={rule.min}
                        placeholder={choice ? 'Chosen' : '0.5'}
                        onChange={(event) => setRule(rule.key, { min: event.target.value })}
                        className={cn(INPUT, 'w-24')}
                      />
                    </Field>
                    <Field label="Review from" hint="Below that, it emits review instead">
                      <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        inputMode="decimal"
                        value={rule.review}
                        placeholder="Off"
                        onChange={(event) => setRule(rule.key, { review: event.target.value })}
                        className={cn(INPUT, 'w-24')}
                      />
                    </Field>
                    <Field label="Do">
                      <Select value={rule.do} onChange={(value) => setRule(rule.key, { do: value, values: defaults(actions.find((candidate) => candidate.id === value)) })}>
                        <option value="log">Run my own code</option>
                        {actions.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>
                            {candidate.label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    {action?.params.map((param) => (
                      <Field key={param.key} label={param.label} className="min-w-40 flex-1">
                        <TextInput
                          param={param}
                          value={rule.values[param.key] ?? param.default}
                          onChange={(value) => setRule(rule.key, { values: { ...rule.values, [param.key]: value } })}
                        />
                      </Field>
                    ))}
                    <button
                      type="button"
                      aria-label="Remove this rule"
                      className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'ms-auto text-fd-muted-foreground')}
                      onClick={() => update((current) => ({ rules: current.rules.filter((candidate) => candidate.key !== rule.key) }))}
                    >
                      <X />
                    </button>
                  </div>
                  <p className="mt-2 text-fd-muted-foreground">
                    {action ? action.describe : `Your own code runs with the ${spec.noun} and every answer. It prints them here.`}
                  </p>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <button
            type="button"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
            disabled={events.length === 0}
            onClick={() =>
              update((current) => {
                const event = events[0]!;
                return {
                  rules: [
                    ...current.rules,
                    { key: newKey(), question: event.question, ...(event.label !== undefined ? { label: event.label } : {}), min: '', review: '', do: 'log', values: {} },
                  ],
                };
              })
            }
          >
            <Plus className="size-3.5" /> Add a rule
          </button>
          {generated.acts ? (
            <label className="flex cursor-pointer items-center gap-2">
              <input type="checkbox" className="accent-(--color-fd-primary)" checked={state.dryRun} onChange={(event) => update(() => ({ dryRun: event.target.checked }))} />
              <span>
                Dry-run <span className="text-fd-muted-foreground">(native actions only log what they would do)</span>
              </span>
            </label>
          ) : null}
        </div>
        {state.target === 'users' ? (
          <Field label="Your site" hint="For the redirect URLs in the steps" className="mt-4 max-w-sm">
            <input value={state.site} placeholder="example.com" onChange={(event) => update(() => ({ site: event.target.value }))} className={INPUT} />
          </Field>
        ) : null}
      </Section>

      <div className="border-t p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">The code</h3>
          <CopyButton text={() => builderPrompt(config, generated)}>Copy for your agent</CopyButton>
        </div>
        <Files files={generated.files} key={state.target} />
      </div>

      <div className="border-t p-4">
        <h3 className="mb-4 font-medium">Run it</h3>
        <Steps steps={generated.steps} />
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="border-t p-4 first-of-type:border-t-0">
      <h3 className="font-medium">{title}</h3>
      {hint ? <p className="mt-0.5 text-fd-muted-foreground">{hint}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: ReactNode }) {
  return (
    <label className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-fd-muted-foreground" title={hint}>
        {label}
      </span>
      {children}
    </label>
  );
}

function TextInput({ param, value, onChange }: { param: ParamSpec; value: string; onChange: (value: string) => void }) {
  return (
    <input
      type={param.kind === 'number' ? 'number' : 'text'}
      value={value}
      placeholder={param.placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={INPUT}
    />
  );
}

function Select({ value, onChange, children }: { value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} className={cn(INPUT, 'w-auto pe-7')}>
      {children}
    </select>
  );
}

/** A made-up item, so it's clear what Jev reads. */
function Sample({ from, title, text, noun }: { from: string; title?: string | undefined; text: string; noun: string }) {
  return (
    <figure className="mt-4">
      <figcaption className="mb-1.5 text-xs text-fd-muted-foreground">
        {/^[aeiou]/i.test(noun) ? 'An' : 'A'} {noun} it would read
      </figcaption>
      <div className="rounded-lg border bg-fd-background px-3 py-2.5">
        <div className="font-mono text-xs text-fd-muted-foreground">{from}</div>
        {title ? <div className="mt-1 font-medium">{title}</div> : null}
        <div className={cn(title ? 'text-fd-muted-foreground' : 'mt-1')}>{text}</div>
      </div>
    </figure>
  );
}

function OwnQuestion({
  question,
  removable,
  onChange,
  onRemove,
  onRemoveLabel,
}: {
  question: QuestionState;
  removable: boolean;
  onChange: (change: (question: QuestionState) => QuestionState) => void;
  onRemove: () => void;
  onRemoveLabel: (labelKey: string) => void;
}) {
  const { config } = question;
  if (config.kind === 'recipe') return null;
  const set = (patch: { id?: string; text?: string; labels?: readonly ChoiceLabel[] }) =>
    onChange((current) => ({ ...current, config: { ...current.config, ...patch } as QuestionConfig }));
  return (
    <div className="rounded-lg border bg-fd-background p-3">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <Field label="Name" hint="The event it fires, in the code" className="w-40">
          <input value={config.id} placeholder={config.kind === 'noul' ? 'refund' : 'topic'} onChange={(event) => set({ id: event.target.value })} className={cn(INPUT, 'font-mono')} />
        </Field>
        <Field label={config.kind === 'noul' ? 'Yes/no question' : 'Choice question'} className="min-w-48 flex-1">
          <input
            value={config.text}
            placeholder={config.kind === 'noul' ? 'Is this asking for a refund?' : 'What is this about?'}
            onChange={(event) => set({ text: event.target.value })}
            className={INPUT}
          />
        </Field>
        <button
          type="button"
          aria-label="Remove this question"
          disabled={!removable}
          title={removable ? undefined : 'A monitor asks at least one question.'}
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'text-fd-muted-foreground')}
          onClick={onRemove}
        >
          <X />
        </button>
      </div>
      {config.kind === 'choice' ? (
        <div className="mt-3 flex flex-col gap-2 border-t pt-3">
          <span className="text-xs text-fd-muted-foreground">Labels: Jev picks one. Leave a description empty for a catch-all.</span>
          {config.labels.map((label, index) => (
            <div key={question.labelKeys[index]} className="flex flex-wrap items-center gap-2">
              <input
                aria-label="Label"
                value={label.name}
                placeholder="billing"
                onChange={(event) => set({ labels: config.labels.map((candidate, n) => (n === index ? { ...candidate, name: event.target.value } : candidate)) })}
                className={cn(INPUT, 'w-36 font-mono')}
              />
              <input
                aria-label="What the label means"
                value={label.description}
                placeholder={label.name === 'other' ? 'Anything else' : 'About an invoice, a charge or a refund'}
                onChange={(event) => set({ labels: config.labels.map((candidate, n) => (n === index ? { ...candidate, description: event.target.value } : candidate)) })}
                className={cn(INPUT, 'min-w-48 flex-1')}
              />
              <button
                type="button"
                aria-label="Remove this label"
                disabled={config.labels.length <= 2}
                title={config.labels.length <= 2 ? 'A choice needs at least two labels.' : undefined}
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }), 'text-fd-muted-foreground')}
                onClick={() => {
                  const labelKey = question.labelKeys[index]!;
                  onChange((current) => ({
                    ...current,
                    config: { ...config, labels: config.labels.filter((_, n) => n !== index) },
                    labelKeys: current.labelKeys.filter((key) => key !== labelKey),
                  }));
                  onRemoveLabel(labelKey);
                }}
              >
                <X />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start text-fd-muted-foreground')}
            onClick={() =>
              onChange((current) => ({
                ...current,
                config: { ...config, labels: [...config.labels, { name: '', description: '' }] },
                labelKeys: [...current.labelKeys, newKey()],
              }))
            }
          >
            <Plus className="size-3.5" /> Add a label
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Files({ files }: { files: readonly GeneratedFile[] }) {
  if (files.length === 1) {
    const [file] = files;
    return <DynamicCodeBlock lang={file!.lang} code={file!.code} codeblock={{ title: file!.path }} />;
  }
  return (
    <CodeBlockTabs defaultValue={files[0]!.path} className="my-0">
      <CodeBlockTabsList>
        {files.map((file) => (
          <CodeBlockTabsTrigger key={file.path} value={file.path}>
            {file.path}
          </CodeBlockTabsTrigger>
        ))}
      </CodeBlockTabsList>
      {files.map((file) => (
        <CodeBlockTab key={file.path} value={file.path}>
          <DynamicCodeBlock lang={file.lang} code={file.code} />
        </CodeBlockTab>
      ))}
    </CodeBlockTabs>
  );
}

function Steps({ steps }: { steps: readonly Step[] }) {
  return (
    <ol className="flex flex-col gap-5">
      {steps.map((step, index) => (
        <li key={index} className="flex gap-3">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs text-fd-muted-foreground">{index + 1}</span>
          <div className="min-w-0 flex-1 pt-0.5 leading-6">
            <p>
              <Inline text={step.text} />
            </p>
            {step.command ? <DynamicCodeBlock lang="bash" code={step.command} codeblock={{ className: 'mt-2' }} /> : null}
            {step.value ? <DynamicCodeBlock lang="text" code={step.value} codeblock={{ className: 'mt-2' }} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** A step's text, with its `code` and [links](https://…). */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(
      match[1] !== undefined ? (
        <code key={match.index} className="rounded border bg-fd-muted px-1 py-px font-mono text-[0.85em]">
          {match[1]}
        </code>
      ) : (
        <a key={match.index} href={match[3]} target="_blank" rel="noreferrer" className="font-medium underline decoration-fd-primary/40 underline-offset-4 hover:decoration-fd-primary">
          {match[2]}
        </a>
      ),
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
