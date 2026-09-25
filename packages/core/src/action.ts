import { ACTION, type Action, type Item, type Source, type TriggeredEvent } from "./types.js";

export interface ActionDefinition<P extends string, I extends Item, S extends Source<I, string>> {
  platform: P;
  name: string;
  describe(event: TriggeredEvent<I>): string;
  run(event: TriggeredEvent<I>, source: S): Promise<void>;
}

/** Define a native action. Connectors use this for `twitch.timeout()`, `discord.deleteMessage()` and so on. */
export function defineAction<P extends string, I extends Item, S extends Source<I, string> = Source<I, string>>(
  definition: ActionDefinition<P, I, S>,
): Action<P, I> {
  return {
    [ACTION]: true,
    platform: definition.platform,
    name: definition.name,
    describe: definition.describe,
    run: (event, source) => definition.run(event, source as S),
  };
}

export function isAction(value: unknown): value is Action {
  return typeof value === "object" && value !== null && (value as Partial<Action>)[ACTION] === true;
}
