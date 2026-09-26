# Jev Events is a library, not a hosted service

Jev Events runs inside the developer's own web app or worker. Each product registers its own OAuth apps
and keeps its users' tokens in its own database, so Jev Events never holds anyone's tokens. We rejected
hosted sign-in, the model integration platforms such as Composio and Pipedream Connect use: whoever owns
a Gmail OAuth app must pass Google's restricted-scope review, including a yearly third-party security
assessment, and hold every user's mailbox tokens. A product that reads Gmail goes through that review for
its own app anyway.

## Consequences

The engine stays host-ready: all state goes through the storage interface and nothing assumes a single
process, so a hosted layer could run the same code later. What a library can't remove is registering an
OAuth app with each provider and passing its review. That stays with each product.
