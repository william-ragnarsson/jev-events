'use client';

import { useState } from 'react';

import { INTEGRATIONS } from '@/lib/builder/catalog';
import type { Target } from '@/lib/builder/generate';
import { agentPrompt, type PromptStream } from '@/lib/builder/markdown';
import { CopyButton, INPUT, Segmented } from './controls';

const STREAMS: readonly { id: PromptStream; label: string }[] = [
  ...INTEGRATIONS.map((spec) => ({ id: spec.id, label: spec.name })),
  { id: 'other', label: 'Something else' },
];

/** A prompt to paste into a coding agent, which then sets Jev Events up in the project. */
export function AgentPrompt() {
  const [streams, setStreams] = useState<PromptStream[]>([]);
  const [goal, setGoal] = useState('');
  const [target, setTarget] = useState<Target>('local');
  const prompt = agentPrompt({ streams, goal, target });

  return (
    <div className="not-prose my-6 overflow-hidden rounded-xl border bg-fd-card text-sm">
      <div className="flex flex-col gap-4 p-4">
        <fieldset>
          <legend className="mb-2 font-medium">What to watch</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {STREAMS.map((stream) => (
              <label key={stream.id} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  className="accent-(--color-fd-primary)"
                  checked={streams.includes(stream.id)}
                  onChange={(event) =>
                    setStreams((current) =>
                      event.target.checked ? STREAMS.map((s) => s.id).filter((id) => id === stream.id || current.includes(id)) : current.filter((id) => id !== stream.id),
                    )
                  }
                />
                {stream.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-2">
          <span className="font-medium">What should happen</span>
          <textarea
            rows={2}
            value={goal}
            placeholder="For example: label emails that need a reply, and archive newsletters."
            onChange={(event) => setGoal(event.target.value)}
            className={INPUT}
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="font-medium">Where it runs</span>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
            <Segmented
              label="Where it runs"
              value={target}
              onChange={setTarget}
              options={[
                { value: 'local', label: 'On my machine' },
                { value: 'users', label: 'For my users' },
              ]}
            />
            <span className="text-fd-muted-foreground">
              {target === 'local' ? 'With your own account. The quickest way to try it.' : 'In your web app, where each user connects their own account.'}
            </span>
          </div>
        </div>
      </div>
      <div className="border-t">
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <span className="text-xs text-fd-muted-foreground">The prompt</span>
          <CopyButton text={() => prompt}>Copy prompt</CopyButton>
        </div>
        <pre className="max-h-72 overflow-auto px-4 pt-2 pb-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-fd-muted-foreground">{prompt}</pre>
      </div>
    </div>
  );
}
