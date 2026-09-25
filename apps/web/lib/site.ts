export const site = {
  name: "Jev Events",
  url: "https://jevevents.dev",
  tagline: "Turn any stream into typed, semantic events.",
  description:
    "An open-source TypeScript library that asks TypeSafe's Jev about every chat message, comment or email as it arrives, and hands each answer to a moderation action or your own code.",
  github: "https://github.com/william-popmie/jev-events",
  npm: "https://www.npmjs.com/package/jev-events",
  typesafe: "https://typesafe.ai",
  typesafeDocs: "https://docs.typesafe.ai",
  /** The live relay behind the landing page feed. Unset: the page plays its recorded replay. */
  relayUrl: (process.env.NEXT_PUBLIC_RELAY_URL ?? "").replace(/\/$/, ""),
} as const;
