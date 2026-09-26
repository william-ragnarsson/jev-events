import { GoogleApiError, type GoogleApi } from "./api.js";

/**
 * Who native actions never touch. By default: people at your own company and people you've
 * emailed before. Pass `false` to protect no one.
 */
export interface ProtectOptions {
  /** People at your company: your address's domain and its subdomains. Never public domains like gmail.com. Default true. */
  company?: boolean;
  /** People you've sent mail to. Checked in your Sent folder, so it needs Gmail access. Default true. */
  emailedBefore?: boolean;
  /** Always protect these: addresses ("ann@acme.com") or domains ("acme.com", "@acme.com"). */
  addresses?: string[];
  /** Never protect these, even when a rule above matches. Same format as `addresses`. */
  except?: string[];
}

/** Webmail and other public domains. Sharing one of these with someone doesn't make them a colleague. */
export const PUBLIC_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
  "gmx.net", "web.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "mail.ru", "fastmail.com", "hey.com",
  "tutanota.com", "tuta.io", "qq.com", "163.com", "126.com", "naver.com", "hotmail.co.uk", "yahoo.co.uk",
  "outlook.de", "t-online.de", "orange.fr", "free.fr", "libero.it", "hotmail.se", "live.se", "telia.com",
]);

/** What your account knows about someone. */
export interface Person {
  address: string;
  /** It's the signed-in account. */
  you: boolean;
  /** Same company domain as you. */
  colleague: boolean;
  /** You've sent them mail. Undefined when your mail can't be searched. */
  emailedBefore: boolean | undefined;
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function domainOf(address: string): string {
  return normalizeAddress(address).split("@").pop() ?? "";
}

/** "ann@acme.com" matches that address; "acme.com" or "@acme.com" match the domain and its subdomains. */
export function matchesAny(address: string, patterns: readonly string[]): boolean {
  const normalized = normalizeAddress(address);
  const domain = domainOf(normalized);
  return patterns.some((raw) => {
    const pattern = normalizeAddress(raw);
    if (pattern.includes("@") && !pattern.startsWith("@")) return normalized === pattern;
    const target = pattern.replace(/^@/, "");
    return target !== "" && (domain === target || domain.endsWith(`.${target}`));
  });
}

/**
 * Facts about the people who write to you, from the signed-in account. "Emailed before" searches
 * your Sent folder once per address and remembers the answer.
 */
export class People {
  readonly me: string;
  readonly #api: GoogleApi;
  readonly #company: string | undefined;
  readonly #sent = new Map<string, Promise<boolean | undefined>>();
  #canSearch = true;

  constructor(api: GoogleApi, me: string) {
    this.#api = api;
    this.me = normalizeAddress(me);
    const domain = domainOf(this.me);
    this.#company = domain && !PUBLIC_DOMAINS.has(domain) ? domain : undefined;
  }

  /** Your company's domain, or undefined for a public one like gmail.com. */
  get company(): string | undefined {
    return this.#company;
  }

  async about(address: string): Promise<Person> {
    const normalized = normalizeAddress(address);
    const you = normalized === this.me;
    const domain = domainOf(normalized);
    const colleague = !you && this.#company !== undefined && (domain === this.#company || domain.endsWith(`.${this.#company}`));
    return { address: normalized, you, colleague, emailedBefore: you ? undefined : await this.emailedBefore(normalized) };
  }

  emailedBefore(address: string): Promise<boolean | undefined> {
    if (!this.#canSearch) return Promise.resolve(undefined);
    const key = normalizeAddress(address);
    let answer = this.#sent.get(key);
    if (!answer) {
      answer = this.#searchSent(key);
      this.#sent.set(key, answer);
      if (this.#sent.size > 500) this.#sent.delete(this.#sent.keys().next().value as string);
    }
    return answer;
  }

  async #searchSent(address: string): Promise<boolean | undefined> {
    try {
      const result = await this.#api.gmail<{ messages?: unknown[] }>("GET", "/messages", {
        query: { q: `in:sent {to:${address} cc:${address} bcc:${address}}`, maxResults: 1 },
      });
      return (result.messages?.length ?? 0) > 0;
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 403 && !error.rateLimited) {
        // No Gmail access (a calendar-only sign-in): skip the check rather than fail every item.
        this.#canSearch = false;
        return undefined;
      }
      this.#sent.delete(address);
      throw error;
    }
  }
}

/**
 * Why native actions must leave this person alone, or undefined when they may act.
 * `yourself` is the reason used when it's you, e.g. "from you" or "you organized it".
 */
export function protectedBecause(person: Person, options: ProtectOptions | false = {}, yourself = "from you"): string | undefined {
  if (options === false) return undefined;
  if (options.except && matchesAny(person.address, options.except)) return undefined;
  if (person.you) return yourself;
  if (options.addresses && matchesAny(person.address, options.addresses)) return "on your protect list";
  if (options.company !== false && person.colleague) return `colleague at ${domainOf(person.address)}`;
  if (options.emailedBefore !== false && person.emailedBefore) return `you've emailed ${person.address} before`;
  return undefined;
}
