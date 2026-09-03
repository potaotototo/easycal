import { parseEvent } from "@easycal/event-parser";
import type { EventParser, MessageChain, ParseContext } from "./contract.js";
import type { EventCandidate } from "@easycal/contracts/event";

/**
 * Adapts Person B's parser (`packages/event-parser`) to the worker's `EventParser`
 * seam.
 *
 * The two signatures differ deliberately: the worker assembles chains itself while
 * walking a chat's messages, so it calls `parseEvent` with the evidence directly
 * rather than using the parser's own `assembleMessageChain`. Keeping the adapter
 * here means the sync engine never depends on the parser's shape.
 */
export class RealEventParser implements EventParser {
  async parseChain(chain: MessageChain, context: ParseContext): Promise<EventCandidate[]> {
    if (chain.messages.length === 0) return [];

    const candidate = await parseEvent(chain.messages, {
      defaultTimezone: context.deviceTimezone,
    });

    // The engine expects a list so a chain can yield several events later; the
    // parser currently produces exactly one candidate per chain.
    return [candidate];
  }
}
