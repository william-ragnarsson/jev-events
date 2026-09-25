import { describe, expectTypeOf, it } from "vitest";

import type * as Relay from "../../live-relay/src/relay.js";
import type * as Web from "../components/relay/types.js";

describe("relay wire format", () => {
  it("is the same on both ends", () => {
    expectTypeOf<Web.FeedEntry>().toEqualTypeOf<Relay.FeedEntry>();
    expectTypeOf<Web.RelayStatus>().toEqualTypeOf<Relay.RelayStatus>();
    expectTypeOf<Web.RelayState>().toEqualTypeOf<Relay.RelayState>();
  });
});
