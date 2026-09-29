'use client';

import { Fragment, useId, useState } from 'react';

import { INTEGRATIONS } from '@/lib/builder/catalog';
import type { Target } from '@/lib/builder/generate';
import { agentPrompt, agentPromptParts, type PromptStream } from '@/lib/builder/markdown';
import { CopyButton } from './code';

const STREAMS: readonly { id: PromptStream; label: string }[] = [
  ...INTEGRATIONS.map((spec) => ({ id: spec.id, label: spec.name })),
  { id: 'other', label: 'Something else' },
];

const WHERE: readonly { target: Target; label: string; hint: string }[] = [
  { target: 'local', label: 'On your machine', hint: 'With your own account. The quickest way to try it.' },
  { target: 'users', label: 'For your users', hint: 'In your web app, where each user connects their own account.' },
];

/**
 * The Introduction's blue block: what to watch, what should happen and where it runs, written into
 * a prompt for a coding agent, which then sets Jev Events up in the project. The answers show in
 * blue in the prompt, so it's clear what the choices changed.
 */
export function AgentPrompt() {
  const id = useId();
  const [streams, setStreams] = useState<PromptStream[]>(['gmail']);
  const [goal, setGoal] = useState('');
  const [target, setTarget] = useState<Target>('local');
  const options = { streams, goal, target };
  const { intro, answers, how } = agentPromptParts(options);
  const prompt = agentPrompt(options);

  // Kept in the order they're listed, however they were picked.
  const toggle = (stream: PromptStream, on: boolean) =>
    setStreams((current) => STREAMS.map((s) => s.id).filter((s) => (s === stream ? on : current.includes(s))));

  return (
    <section id="agent" className="docs-agent on-field" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Set it up with your coding agent</h2>
      <p>
        Pick what to watch and what should happen, then paste the prompt into Claude Code, Cursor or any other coding
        agent. It reads these docs, writes the code, and tells you each step that needs you.
      </p>

      <span id={`${id}-watch`} className="field-label">
        What to watch
      </span>
      <div role="group" aria-labelledby={`${id}-watch`} className="field-checks">
        {STREAMS.map((stream) => (
          <label key={stream.id} className="field-choice">
            <input
              type="checkbox"
              className="field-input-hidden"
              checked={streams.includes(stream.id)}
              onChange={(event) => toggle(stream.id, event.target.checked)}
            />
            <span className="field-box" aria-hidden="true">
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2 6.2 4.8 9 10 3" />
              </svg>
            </span>
            {stream.label}
          </label>
        ))}
      </div>

      <label htmlFor={`${id}-goal`} className="field-label">
        What should happen
      </label>
      <input
        id={`${id}-goal`}
        type="text"
        className="field-text"
        value={goal}
        placeholder="For example: label emails that need a reply, and archive newsletters."
        onChange={(event) => setGoal(event.target.value)}
      />

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
                checked={target === where.target}
                onChange={() => setTarget(where.target)}
              />
              <span>{where.label}</span>
            </label>
          ))}
        </div>
        <p className="field-hint">{WHERE.find((where) => where.target === target)?.hint}</p>
      </div>

      <span id={`${id}-prompt`} className="field-label">
        The prompt
      </span>
      <div role="region" aria-labelledby={`${id}-prompt`} tabIndex={0} className="docs-prompt">
        <p>{intro}</p>
        <p>
          {answers.map(([label, value], index) => (
            <Fragment key={label}>
              {index > 0 ? '\n' : null}
              {label}: <strong>{value}</strong>
            </Fragment>
          ))}
        </p>
        <p>{['How:', ...how].join('\n')}</p>
      </div>
      <CopyButton className="field-button" label="Copy the prompt" text={() => prompt} reset={prompt} hold />
    </section>
  );
}
