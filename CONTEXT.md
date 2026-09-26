# Jev Events

A TypeScript library for products that watch their users' streams, such as inboxes, calendars and chats,
ask Jev about each item as it arrives, and act on the answers.

## Language

### Streams

**Integration**:
The package for one platform or product family, such as Twitch or Google, with its sources, native
actions and sign-in.
_Avoid_: connector, module, plugin

**Connection**:
One grant of access from one of a product's users: their Google account, Slack workspace, Discord server
or Twitch channel. Public streams need none.
_Avoid_: account, install, integration

**Source**:
One kind of stream an integration offers, such as new calendar invites or a channel's chat.
_Avoid_: feed, trigger

**Item**:
One unit a source emits: an email, a calendar event, a chat message.
_Avoid_: event (see **Event**), record

**Delivery**:
How a source learns about new items: push, where the platform notifies, or polling, where Jev Events asks
on a timer.
_Avoid_: transport, mode

**Cursor**:
Where a source left off for one connection, so nothing is missed or judged twice.
_Avoid_: checkpoint, sync token, historyId, deltaLink

**Account facts**:
Facts an integration derives from the connected account and attaches to an item, such as "the organizer
is from the user's company".
_Avoid_: metadata, enrichment

**Profile**:
What the product tells Jev about the person behind a connection, so "important" means important to them.
_Avoid_: persona, user context

### Judging and acting

**Monitor**:
A source, questions and handlers, written once and run for every connection, or once for a single fixed
stream.
_Avoid_: listener, watcher, rule

**Question**:
What Jev decides about each item: a label (`choice`), a yes-or-no probability (`noul`) or a point on a
scale (`score`).

**Outcome**:
A named answer that fires, such as `kind:question` or `hateful`.
_Avoid_: trigger, label (a label is one option of a choice question)

**Event**:
What a monitor emits: an outcome firing, or a built-in event such as `judged`, `review` or `action`. A
calendar event is an item, not an event in this sense.

**Policy**:
The threshold an outcome must reach to fire (`min` or `atLeast`), with an optional review band below it.
_Avoid_: rule

**Review band**:
The range of answers just below a policy's threshold that goes to a person instead of acting.
_Avoid_: grey zone

**Handler**:
What runs when an outcome fires: the developer's own function or a native action.
_Avoid_: callback, listener

**Native action**:
Something Jev Events does on the platform when an outcome fires, such as trashing an email or accepting
an invite.
_Avoid_: built-in action, platform action

**Dry-run**:
The default state of a monitor, in which native actions only report what they would do.
_Avoid_: test mode, simulation

**Protected**:
Describes an item that native actions never touch because of who it's from: a Twitch moderator, a
colleague at the user's company, someone the user has emailed.
_Avoid_: allowlisted, VIP, exempt

**Trash**:
Moving the user's own content to the platform's recoverable trash, the only way a native action removes
mail, files or calendar events.
_Avoid_: delete (for the user's own content)
