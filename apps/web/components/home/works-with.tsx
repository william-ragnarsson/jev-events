import Link from 'next/link';

import {
  DiscordIcon,
  GitHubIcon,
  GmailIcon,
  GoogleCalendarIcon,
  GoogleDriveIcon,
  LinearIcon,
  NotionIcon,
  OutlookIcon,
  SlackIcon,
  TeamsIcon,
  TwitchIcon,
  WebhookIcon,
  YouTubeIcon,
} from '@/components/brand-icons';
import './home.css';

const APPS = [
  { name: 'Gmail', Icon: GmailIcon },
  { name: 'Outlook', Icon: OutlookIcon },
  { name: 'Google Calendar', Icon: GoogleCalendarIcon },
  { name: 'Slack', Icon: SlackIcon },
  { name: 'Microsoft Teams', Icon: TeamsIcon },
  { name: 'Discord', Icon: DiscordIcon },
  { name: 'Linear', Icon: LinearIcon },
  { name: 'GitHub', Icon: GitHubIcon },
  { name: 'Notion', Icon: NotionIcon },
  { name: 'Google Drive', Icon: GoogleDriveIcon },
  { name: 'Twitch', Icon: TwitchIcon },
  { name: 'YouTube', Icon: YouTubeIcon },
];

/** Every app in one plain grid, and the way in for the rest. */
export function WorksWith() {
  return (
    <section className="home-section" aria-labelledby="works-title">
      <h2 id="works-title" className="home-heading">
        Works with
      </h2>
      <ul className="apps">
        {APPS.map(({ name, Icon }) => (
          <li key={name}>
            <Icon aria-hidden="true" />
            <span>{name}</span>
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
