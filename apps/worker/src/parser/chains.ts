import type { MessageEvidence } from "@easycal/contracts/event";
import type { RawMessageRow } from "@easycal/db";
import type { MessageChain } from "./contract.js";

/**
 * Groups a chat's messages into candidate chains: a post plus the replies that
 * continue it. Telegram channels routinely split an event across a post and a
 * follow-up ("venue changed", "RSVP link"), and the parser needs to see them together.
 *
 * Messages with no reply relationship each form a chain of one.
 */
export function assembleChains(
  messages: RawMessageRow[],
  telegramChatId: string,
): MessageChain[] {
  const byTelegramId = new Map(messages.map((message) => [message.telegramMessageId, message]));

  // Union-find over the reply graph, so a post and all its replies land in one chain.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (const message of messages) parent.set(message.telegramMessageId, message.telegramMessageId);
  for (const message of messages) {
    const replyTo = message.replyToMessageId;
    // Only join when the parent is inside the window; otherwise treat it as a root.
    if (replyTo && byTelegramId.has(replyTo)) union(replyTo, message.telegramMessageId);
  }

  const grouped = new Map<string, RawMessageRow[]>();
  for (const message of messages) {
    const root = find(message.telegramMessageId);
    const bucket = grouped.get(root);
    if (bucket) bucket.push(message);
    else grouped.set(root, [message]);
  }

  return [...grouped.entries()].map(([root, chainMessages]) => ({
    chainId: `${telegramChatId}:${root}`,
    messages: chainMessages
      .sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())
      .map((message) => toEvidence(message, telegramChatId)),
  }));
}

export function toEvidence(message: RawMessageRow, telegramChatId: string): MessageEvidence {
  return {
    telegramChatId,
    telegramMessageId: message.telegramMessageId,
    sentAt: message.sentAt.toISOString(),
    normalizedText: message.normalizedText,
    links: message.entities,
  };
}
