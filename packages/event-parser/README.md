# Event parser

Input: Telegram messages and entities, normalized into `MessageEvidence`.

Output: `EventCandidate` from `packages/contracts/src/event.ts`.

Implement deterministic extraction first. Use structured model extraction as a fallback, never as the final authority: validate absolute dates, parseable times, URL scheme, and evidence references before marking a candidate `confirmed`.

Use `fixtures/noc-sharing.expected.json` as the first acceptance fixture.

## Commands

```sh
npm install
npm test
npm run check
```

The public API exports normalization, chain assembly, deterministic extraction,
validated structured-model fallback, and the guarded `EventCandidate` to
`CalendarEvent` conversion.
