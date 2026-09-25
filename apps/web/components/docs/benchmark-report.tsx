import { Callout } from 'fumadocs-ui/components/callout';
import type { ReactNode } from 'react';

import { benchmarks, percent, type BenchmarkRun, type FlagReport } from '@/lib/benchmarks';

/** How each eval mode asks Jev, in words. Batched runs are named like "batched-8". */
function modeName(mode: string): string {
  if (mode === 'single') return 'One message per request, as the library sends it';
  if (mode === 'plain') return 'One message per request, bare text';
  const batch = /^batched-(\d+)$/.exec(mode);
  return batch ? `${batch[1]} messages per request` : mode;
}

const FLAG_NAMES: Record<string, string> = {
  hateful: 'recipes.chat.hateful',
  question: 'recipes.chat.question',
  streamIssue: 'recipes.chat.streamIssue',
  spam: 'recipes.chat.spam',
};

const date = (value: string) => new Date(value).toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });
const ms = (value: number | null) => (value === null ? '–' : `${Math.round(value)} ms`);
const usd = (value: number | null) => (value === null ? '–' : `$${value.toFixed(4)}`);

/** Everything the latest published eval run measured. Renders nothing made up when there's no run. */
export function BenchmarkReport() {
  const { runs } = benchmarks;
  if (runs.length === 0) {
    return (
      <Callout title="No published run yet" type="info">
        The numbers on this page are filled in by <code>npm run eval</code> and <code>npm run eval:report</code> with a
        real TypeSafe key. Until the first run is published, this page shows no scores at all, on purpose. You can run
        the suite yourself today; it takes a few minutes and costs a few cents at most.
      </Callout>
    );
  }
  const headline = runs.find((run) => run.mode === 'single') ?? (runs[0] as BenchmarkRun);
  return (
    <div className="not-prose my-6 grid grid-cols-1 gap-10 text-sm">
      <RunsTable runs={runs} />
      <section>
        <h3 className="font-semibold">What kind of message is it?</h3>
        <p className="mt-1 text-fd-muted-foreground">
          <code>recipes.chat.kind</code>, {modeName(headline.mode).toLowerCase()}. Accuracy counts the gold label; lenient
          accuracy also accepts a second label the annotator marked as fair.
        </p>
        <KindTable run={headline} />
      </section>
      {Object.entries(headline.flags).map(([flag, report]) => (
        <section key={flag}>
          <h3 className="font-semibold">
            <code>{FLAG_NAMES[flag] ?? flag}</code>
          </h3>
          <p className="mt-1 text-fd-muted-foreground">
            {report.positives} positive and {report.negatives} negative examples. Precision: of the messages flagged at a
            threshold, how many were right. Recall: of the messages that should be flagged, how many were.
          </p>
          <FlagTable report={report} />
        </section>
      ))}
      <section>
        <h3 className="font-semibold">By slice</h3>
        <p className="mt-1 text-fd-muted-foreground">
          Hateful agreement uses p ≥ 0.5. Slices overlap: a message can be both slang and non-English.
        </p>
        <SliceTable run={headline} />
      </section>
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-xl border">
      <table className="w-full text-left text-[13px]">
        <thead className="bg-fd-muted/60 text-xs text-fd-muted-foreground">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="px-3 py-2 font-medium whitespace-nowrap">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y font-mono tabular-nums">
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 whitespace-nowrap first:font-sans">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunsTable({ runs }: { runs: BenchmarkRun[] }) {
  return (
    <section>
      <h3 className="font-semibold">Runs</h3>
      <Table
        head={['Mode', 'Model', 'Date', 'Answered', 'p50', 'p95', 'Tokens / msg', 'Per 1,000 msgs']}
        rows={runs.map((run) => [
          modeName(run.mode),
          run.model,
          date(run.date),
          `${run.answered}/${run.items}`,
          ms(run.latencyMs.p50),
          ms(run.latencyMs.p95),
          run.tokens.inputPerItem === null ? '–' : Math.round(run.tokens.inputPerItem),
          usd(run.tokens.usdPer1kItems),
        ])}
      />
    </section>
  );
}

function KindTable({ run }: { run: BenchmarkRun }) {
  const { kind } = run;
  return (
    <>
      <Table
        head={['', 'Accuracy', 'Lenient accuracy', 'Messages']}
        rows={[['All labels', percent(kind.accuracy), percent(kind.lenientAccuracy), kind.n]]}
      />
      <Table
        head={['Label', 'Precision', 'Recall', 'Gold', 'Predicted']}
        rows={Object.entries(kind.perLabel).map(([label, score]) => [
          label,
          percent(score.precision),
          percent(score.recall),
          score.gold,
          score.predicted,
        ])}
      />
      <Table
        head={['Confidence at least', 'Answers kept', 'Lenient accuracy']}
        rows={kind.byConfidence.map((row) => [row.min, percent(row.coverage), percent(row.lenientAccuracy)])}
      />
    </>
  );
}

function FlagTable({ report }: { report: FlagReport }) {
  return (
    <Table
      head={['Threshold', 'Precision', 'Recall', 'F1', 'False positive rate']}
      rows={report.thresholds.map((score) => [
        `p ≥ ${score.threshold}${report.best?.threshold === score.threshold ? '  (best F1)' : ''}`,
        percent(score.precision),
        percent(score.recall),
        score.f1 === null ? '–' : score.f1.toFixed(2),
        percent(score.falsePositiveRate),
      ])}
    />
  );
}

function SliceTable({ run }: { run: BenchmarkRun }) {
  return (
    <Table
      head={['Slice', 'Messages', 'Kind (lenient)', 'Hateful agreement', 'False alarms', 'Misses']}
      rows={Object.entries(run.slices).map(([name, slice]) => [
        name,
        slice.n,
        percent(slice.kindAccuracy),
        percent(slice.hatefulAgreement),
        slice.hatefulFalsePositives,
        slice.hatefulMisses,
      ])}
    />
  );
}
