import {
  Benchmarks,
  CodeShowcase,
  FinalCta,
  Hero,
  HowItWorks,
  Integrations,
  Recipes,
  RelaySource,
  Safety,
  TryIt,
} from '@/components/home/sections';
import { LiveFeed } from '@/components/live-feed';
import { LiveStats } from '@/components/live-stats';
import { RelayProvider } from '@/components/relay/relay-provider';
import { site } from '@/lib/site';

export default function HomePage() {
  return (
    <RelayProvider url={site.relayUrl}>
      <Hero feed={<LiveFeed />} />
      <LiveStats />
      <HowItWorks />
      <Integrations />
      <CodeShowcase />
      <Safety />
      <RelaySource />
      <Benchmarks />
      <Recipes />
      <TryIt />
      <FinalCta />
    </RelayProvider>
  );
}
