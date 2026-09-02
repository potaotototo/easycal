import type { EventCandidate, MessageEvidence } from "@easycal/contracts/event";

/**
 * PROPOSED CONTRACT — belongs in `packages/contracts/src/parser.ts` once Person B
 * signs off (integration milestone 1, "contract freeze").
 *
 * It lives here for now because `packages/contracts` is shared and changes to it are
 * meant to be reviewed together. Nothing in the worker depends on the parser's
 * implementation, only on this interface, so swapping in Person B's real parser is a
 * one-line change in `apps/worker/src/index.ts`.
 */

export interface MessageChain {
  /** Stable id for the chain, derived from its source messages. */
  chainId: string;
  /** The chain's messages, oldest first. */
  messages: MessageEvidence[];
}

export interface ParseContext {
  /** Falls back to this when no timezone can be inferred from the location. */
  deviceTimezone: string;
  /** Resolves relative dates and rejects implausible years. ISO 8601. */
  now: string;
}

export interface EventParser {
  parseChain(chain: MessageChain, context: ParseContext): Promise<EventCandidate[]>;
}
