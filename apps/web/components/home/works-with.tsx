import Link from 'next/link';

import { WebhookIcon } from '@/components/brand-icons';

import { APPS } from './apps';
import './home.css';

/** Every app in one plain grid, and the way in for the rest. */
export function WorksWith() {
  return (
    <section className="home-section" aria-labelledby="works-title">
      <h2 id="works-title" className="home-heading">
        Works with
      </h2>
      <ul className="apps">
        {APPS.map(({ name, Icon, does, scale }) => (
          <li key={name}>
            <Icon aria-hidden="true" style={{ scale }} />
            <span>{name}</span>
            <small>{does}</small>
          </li>
        ))}
      </ul>
      <p className="apps-custom">
        <WebhookIcon aria-hidden="true" />
        <Link href="/docs/integrations/custom">Or send your own events through a webhook.</Link>
      </p>
    </section>
  );
}
