import { ServerCodeBlock } from 'fumadocs-ui/components/codeblock.rsc';

import { cn } from '@/lib/cn';

/** A highlighted, copyable code block rendered on the server. */
export function Code({
  code,
  lang = 'ts',
  title,
  className,
  fullHeight,
}: {
  code: string;
  lang?: string;
  title?: string;
  className?: string;
  /** Show every line instead of scrolling after 600px. */
  fullHeight?: boolean;
}) {
  return (
    <ServerCodeBlock
      code={code}
      lang={lang}
      codeblock={{
        ...(title ? { title } : {}),
        className: cn('my-0 shadow-sm', className),
        ...(fullHeight ? { viewportProps: { className: 'max-h-none' } } : {}),
      }}
    />
  );
}
