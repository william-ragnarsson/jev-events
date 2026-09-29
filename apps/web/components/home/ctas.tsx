import Link from 'next/link';

/** The two ways to start, under the hero and again at the bottom of the page. */
export function Ctas() {
  return (
    <div className="ctas">
      <Link href="/try" className="cta-button">
        Try it in your browser
      </Link>
      <Link href="/docs/quickstart" className="cta-link">
        Read the quickstart →
      </Link>
    </div>
  );
}
