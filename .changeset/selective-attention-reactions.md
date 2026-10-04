---
"@npc/door-sdk": minor
"@npc/runtime": minor
"@npc/door-discord": minor
---

Selective attention, reactions, and live residency transcript.

- door-sdk: additive door/0.1 capabilities `session.reactions` (outbound `reaction: { emoji, target_msg_id }`, text-less reaction frames) and `session.addressing` (inbound `addressed`). Spec updated in `spec/door/api.md`.
- runtime: `Session.observe` — the Wanderer reads a room log and decides to speak, react, both, or stay silent (one Brain call per burst, deterministic floor guard). `NPC_ATTENTION_MODE=selective|always` (default `selective`). New `ResidencyTranscript` records observed + spoken lines in memory for `depart()` distillation (WHITEPAPER §3.2).
- door-discord: advertises both capabilities; addressed detection (@mention / reply to the Wanderer), msg_id ↔ Discord id mapping for threaded replies and reactions, typing indicator, and screen-safe mention rendering (raw `@name` would trip the immune `pii.handle` screen).

Deploy the runtime and door-discord images together: a pre-release runtime rejects a `hello` that lists the new capability values.
