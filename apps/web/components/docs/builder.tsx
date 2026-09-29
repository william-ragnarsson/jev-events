'use client';

import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';

import recipeEntries from '@/generated/recipes.json';
import { CATALOG, type IntegrationId, type Step } from '@/lib/builder/catalog';
import { firstPicks, generate, MINS, pickedConfig, recipeOptions, type Picks, type Target } from '@/lib/builder/generate';
import { CodeLines, CopyButton } from './code';
import { InlineCode } from './inline-code';

const WHERE: readonly { target: Target; label: string }[] = [
  { target: 'local', label: 'On your machine' },
  { target: 'users', label: 'For your users' },
];

/**
 * An integration's builder: where it runs, one question, how sure Jev has to be and what to do,
 * picked on blue. Under that, the code those picks write, with what they changed marked, and the
 * steps to run it. The picks come from the catalog (lib/builder/catalog.ts).
 */
export function Builder({ integration }: { integration: IntegrationId }) {
  const id = useId();
  const spec = CATALOG[integration];
  const [picks, setPicks] = useState<Picks>(() => firstPicks(integration));
  const [tab, setTab] = useState('lib/jev.ts');
  const recipes = useMemo(() => recipeOptions(recipeEntries, spec.recipeGroup), [spec.recipeGroup]);
  const generated = useMemo(() => generate(pickedConfig(integration, recipes, picks)), [integration, recipes, picks]);

  const users = picks.target === 'users';
  const files = generated.files;
  const file = files.find((candidate) => candidate.path === tab) ?? files[0]!;
  const ask = spec.picks.ask.find((option) => option.event === picks.ask) ?? spec.picks.ask[0]!;
  const pick = (patch: Partial<Picks>) => setPicks((current) => ({ ...current, ...patch }));
  const tabId = (path: string) => `${id}-tab-${files.findIndex((candidate) => candidate.path === path)}`;

  // Arrow keys, Home and End move between the files, as in any tab list.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = files.indexOf(file);
    const keys: Record<string, number> = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: files.length - 1 };
    const to = keys[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = (to + files.length) % files.length;
    setTab(files[next]!.path);
    event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <>
      <div className="docs-builder">
        <div className="docs-builder-band on-field">
          <span id={`${id}-where`} className="field-label">
            Where it runs
          </span>
          <div className="field-row">
            <div role="radiogroup" aria-labelledby={`${id}-where`} className="field-seg">
              {WHERE.map((where) => (
                <label key={where.target}>
                  <input
                    type="radio"
                    name={`${id}-where`}
                    className="field-input-hidden"
                    checked={picks.target === where.target}
                    onChange={() => pick({ target: where.target })}
                  />
                  <span>{where.label}</span>
                </label>
              ))}
            </div>
            <p className="field-hint">
              {users
                ? `In your Next.js app, where each of your users connects their own ${spec.account}.`
                : `With your own ${spec.account}, on your computer. The quickest way to try it.`}
            </p>
          </div>

          <div className="docs-builder-cols">
            <div>
              <span id={`${id}-ask`} className="field-label">
                What to ask
              </span>
              <div role="radiogroup" aria-labelledby={`${id}-ask`} className="field-options">
                {spec.picks.ask.map((option) => (
                  <label key={option.event} className="field-choice">
                    <input
                      type="radio"
                      name={`${id}-ask`}
                      className="field-input-hidden"
                      checked={picks.ask === option.event}
                      onChange={() => pick({ ask: option.event })}
                    />
                    <span className="field-box" aria-hidden="true" />
                    {option.label}
                  </label>
                ))}
              </div>
              <span id={`${id}-min`} className="field-label">
                When Jev is at least
              </span>
              <div role="radiogroup" aria-labelledby={`${id}-min`} className="field-seg is-mono">
                {MINS.map((min) => (
                  <label key={min}>
                    <input
                      type="radio"
                      name={`${id}-min`}
                      className="field-input-hidden"
                      checked={picks.min === min}
                      onChange={() => pick({ min })}
                    />
                    <span>{min}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <span id={`${id}-act`} className="field-label">
                What to do
              </span>
              <div role="radiogroup" aria-labelledby={`${id}-act`} className="field-options">
                {spec.picks.act.map((option) => (
                  <label key={option.do} className="field-choice">
                    <input
                      type="radio"
                      name={`${id}-act`}
                      className="field-input-hidden"
                      checked={picks.act === option.do}
                      onChange={() => pick({ act: option.do })}
                    />
                    <span className="field-box" aria-hidden="true" />
                    {option.label.replaceAll('{name}', ask.name ?? '')}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="docs-code">
          <div className="docs-code-bar">
            {users ? (
              <div role="tablist" aria-label="Files" className="docs-tabs" onKeyDown={onTabKey}>
                {files.map((candidate) => (
                  <button
                    key={candidate.path}
                    id={tabId(candidate.path)}
                    type="button"
                    role="tab"
                    aria-selected={candidate === file}
                    aria-controls={`${id}-code`}
                    tabIndex={candidate === file ? 0 : -1}
                    className="docs-tab"
                    onClick={() => setTab(candidate.path)}
                  >
                    {candidate.path}
                  </button>
                ))}
              </div>
            ) : (
              <span className="docs-file">{file.path}</span>
            )}
            <CopyButton text={() => file.code} reset={file.code} />
          </div>
          <pre
            id={`${id}-code`}
            tabIndex={0}
            {...(users ? { role: 'tabpanel', 'aria-labelledby': tabId(file.path) } : { 'aria-label': file.path })}
          >
            <CodeLines code={file.code} lang={file.lang} marks={generated.marks} />
          </pre>
        </div>
      </div>

      <h2 id="run-it">Run it</h2>
      <div className="docs-steps">
        {generated.steps.map((step, index) => (
          <StepItem key={`${picks.target}-${index}`} step={step} />
        ))}
      </div>
    </>
  );
}

function StepItem({ step }: { step: Step }) {
  const copy = step.command ?? step.value;
  return (
    <div className="docs-step">
      <p>
        <Inline text={step.text} />
      </p>
      {copy ? (
        <div className="docs-cmd">
          <pre>{copy}</pre>
          <CopyButton text={() => copy} />
        </div>
      ) : null}
    </div>
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
        <InlineCode key={match.index}>{match[1]}</InlineCode>
      ) : (
        <a key={match.index} href={match[3]} target="_blank" rel="noreferrer noopener">
          {match[2]}
        </a>
      ),
    );
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}
