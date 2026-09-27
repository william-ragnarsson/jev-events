# Evals

Jev Events publishes accuracy, latency and cost numbers only when they come from this folder. The
benchmarks page and the landing page read them from `results/`.

## Datasets

### `datasets/chat.jsonl` (278 messages)

Short live-chat messages written for this project to read like real Twitch chat. None of them are
copied from real people. The labels deserve a second pair of eyes: if you disagree with one, open an
issue or a pull request. They cover what moderators run into:

| Slice | Examples |
| --- | --- |
| Hateful: identity attacks, harassment, threats, self-harm encouragement | 40, including 5 evasions such as `k y s` and 10 in other languages |
| Hard negatives: violent game talk, identity mentions, harsh banter, sarcasm | 56 |
| Slang and emotes (`bro is cooking`, `KEKW`, `he's him`) | 34 |
| Not English (es, pt, de, fr, ru, ja, ko, nl, sv, tr, pl, it) | 48 |
| Stream problems (`no sound?`, `audio desync`, `kein Ton`) and look-alikes (`my internet is dying`) | 21 + 6 |
| Spam, scams and self-promotion, including unicode and dotted evasions | 19 |

Each line holds the right answers for the chat recipes in `jev-events`:

```json
{"id":"r03","text":"go back where you came from","lang":"en","flags":["hateful"],"reply":{"author":"viewer_40","text":"greetings from Nigeria!"}}
```

| Field | Meaning |
| --- | --- |
| `kind` | The answer to `recipes.chat.kind`. Left out when no kind fits, as with hateful messages. |
| `kindAlso` | Other kinds a careful person would also accept. |
| `flags` | Yes/no recipes that should say yes: `hateful`, `question`, `streamIssue`, `spam`. Every other one should say no. |
| `tags` | Slices: `slang`, `sarcasm`, `banter`, `evasion`, `emote`, `identity-mention`, `in-game-violence`, `hard-negative`. |
| `borderline` | Reasonable people would label this differently. |
| `reply`, `firstMessage` | Context passed to Jev as facts, as the Twitch source does. |

Headline numbers use only the clear cases. Borderline items are still scored, and they are listed
in the results.

## Running

```bash
export TYPESAFE_API_KEY=...
npm run eval                      # one request per message, as the library sends them
npm run eval -- --mode all        # also plain text state, and 8 messages per request
npm run eval:report               # rebuild the benchmarks page from results/
```

| Mode | What's sent |
| --- | --- |
| `single` | `{ message: { text, author, ... } }` with each recipe pointed at `message`. This is what a monitor sends by default. |
| `plain` | Just the text, with the recipes unchanged. This checks whether the extra structure helps. |
| `batched-N` | N messages as `{ messages: [...] }`, with every recipe asked once per message and pointed at `` `messages[i]` ``. This is cheaper per request. Accuracy decides whether it becomes an option. |

Each run writes `results/<dataset>.<mode>.json`. A run reports:

- precision and recall for each yes/no recipe, at thresholds from 0.3 to 0.9, and the threshold with the best F1;
- kind accuracy (exact, and also accepting the listed alternatives), a confusion matrix, and accuracy by confidence;
- results for each slice;
- p50 and p95 latency, and input tokens and cost per 1,000 messages;
- every mistake, for error analysis.

`--mock` runs the whole pipeline offline against keyword rules. Use it to check the plumbing:
those results go to `results/mock/`, which is gitignored and never published.

## Adding examples

```bash
npm run eval:record -- <channel> --count 300
```

This saves public chat text to `datasets/raw/`, which is gitignored, without usernames. Before
adding any line to a dataset:

- rewrite or delete anything that could identify a person;
- label it by hand following the recipe definitions;
- mark it `borderline` if you had to think twice.
