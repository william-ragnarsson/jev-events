# Monitors run per connection

Jev Events is designed around products whose users each connect their own accounts, not around one
developer watching their own. A monitor is written once and runs for every connection, or once for a
single fixed stream such as a public Twitch channel. `monitor()` replaces `listen()`, which tied one
stream to one set of credentials, before the first npm release, so there's only one concept to learn.
Watching your own accounts is a product with one user.
