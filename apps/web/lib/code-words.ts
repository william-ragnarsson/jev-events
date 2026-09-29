/** Code up to this long stays on one line, which still fits across a phone. */
const SHORT = 30;
/** A word of brackets alone, which stays with the word after it (`{`) or before it (`})`). */
const OPENS = /^[^\w\s]*[([{]$/;
const CLOSES = /^[)\]}][^\w\s]*$/;

/**
 * The parts of code inside a sentence that a line may end between (see
 * components/docs/inline-code.tsx): all of short code, and longer code at its spaces, never beside a
 * bracket on its own.
 */
export function codeWords(code: string): string[] {
  if (code.length <= SHORT) return [code];
  const parts: string[] = [];
  for (const word of code.split(' ')) {
    const last = parts.at(-1);
    if (last !== undefined && (OPENS.test(last.slice(last.lastIndexOf(' ') + 1)) || CLOSES.test(word))) {
      parts[parts.length - 1] = `${last} ${word}`;
    } else {
      parts.push(word);
    }
  }
  return parts;
}
