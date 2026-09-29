import { Fragment, type ComponentProps } from 'react';

import { codeWords } from '@/lib/code-words';

/**
 * Code inside a sentence. Short code stays on one line and longer code wraps only at its spaces,
 * never beside a bracket on its own. Left to itself, a browser also breaks after a hyphen, colon or
 * question mark, and would end a line at `npx jev-`.
 */
export function InlineCode({ children, ...props }: ComponentProps<'code'>) {
  if (typeof children !== 'string') return <code {...props}>{children}</code>;
  return (
    <code {...props}>
      {codeWords(children).map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? ' ' : null}
          <span className="code-word">{part}</span>
        </Fragment>
      ))}
    </code>
  );
}
