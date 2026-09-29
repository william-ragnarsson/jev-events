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
  YouTubeIcon,
} from '@/components/brand-icons';

/**
 * Every app Jev Events works with, and in a few words what it watches there. The marks all fill their
 * 24px box on the long side, so square ones look bigger than wide ones; `scale` evens out the area
 * each one covers.
 */
export const APPS = [
  { name: 'Gmail', Icon: GmailIcon, does: 'Analyse incoming mail', scale: 1.08 },
  { name: 'Outlook', Icon: OutlookIcon, does: 'Sort new email', scale: 1 },
  { name: 'Google Calendar', Icon: GoogleCalendarIcon, does: 'Weigh new invites', scale: 0.94 },
  { name: 'Slack', Icon: SlackIcon, does: 'Watch channel messages', scale: 0.94 },
  { name: 'Microsoft Teams', Icon: TeamsIcon, does: 'Watch team chats', scale: 0.97 },
  { name: 'Discord', Icon: DiscordIcon, does: 'Watch server messages', scale: 1.07 },
  { name: 'Linear', Icon: LinearIcon, does: 'Triage new issues', scale: 0.94 },
  { name: 'GitHub', Icon: GitHubIcon, does: 'Triage issues and PRs', scale: 0.95 },
  { name: 'Notion', Icon: NotionIcon, does: 'Follow page edits', scale: 0.96 },
  { name: 'Google Drive', Icon: GoogleDriveIcon, does: 'Check new files', scale: 1 },
  { name: 'Twitch', Icon: TwitchIcon, does: 'Moderate live chat', scale: 1.01 },
  { name: 'YouTube', Icon: YouTubeIcon, does: 'Read new comments', scale: 1.11 },
];
