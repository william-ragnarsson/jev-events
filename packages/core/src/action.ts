import { ACTION, type Action, type ActionContext, type Item, type TriggeredEvent } from "./types.js";

export interface ActionDefinition<P extends string, I extends Item, S> {
  platform: P;
  /** A dotted name such as "twitch.timeout". */
  name: string;
  describe(event: TriggeredEvent<I>): string;
  run(event: TriggeredEvent<I>, ctx: ActionContext<S>): Promise<void>;
}

/** Define a native action. Integrations use this for `twitch.timeout()`, `google.gmail.trash()` and so on. */
export function defineAction<P extends string, I extends Item = Item, S = unknown>(
  definition: ActionDefinition<P, I, S>,
): Action<P, I, S> {
  return {
    [ACTION]: true,
    platform: definition.platform,
    name: definition.name,
    describe: definition.describe,
    run: (event, ctx) => definition.run(event, ctx),
  };
}

export function isAction(value: unknown): value is Action {
  return typeof value === "object" && value !== null && (value as Partial<Action>)[ACTION] === true;
}
