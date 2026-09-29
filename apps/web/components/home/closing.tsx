import { Footer } from '@/components/site/footer';
import { Ctas } from './ctas';
import { Waitlist } from './waitlist';
import './home.css';

/** The blue close of the home page: the way in again, the waitlist, and the footer. */
export function Closing() {
  return (
    <section className="closing on-field" aria-labelledby="closing-title">
      <h2 id="closing-title" className="closing-title">
        <span className="nowrap">Try it out</span> <span className="nowrap">on a live</span>
        <br />
        <span className="nowrap">Twitch chat.</span>
      </h2>
      <Ctas />
      <Waitlist />
      <Footer />
    </section>
  );
}
