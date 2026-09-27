import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      // The Google page was split in two. Links to it, such as the first google README's, land on Gmail.
      { source: '/docs/integrations/google', destination: '/docs/integrations/gmail', permanent: true },
    ];
  },
};

export default withMDX(config);
