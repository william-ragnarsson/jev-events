import { APPS } from './apps';
import './home.css';

/** Every app's logo and name in one row under the hero; what each does is in Works with. */
export function LogoBand() {
  return (
    <section className="logo-band" aria-label="Works with">
      <ul>
        {APPS.map(({ name, Icon, scale }) => (
          <li key={name}>
            <Icon aria-hidden="true" style={{ scale }} />
            <span>{name}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
