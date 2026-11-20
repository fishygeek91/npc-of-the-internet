---
"@npc/door-web": minor
---

The porch and shrine verify a chain incrementally: a refetch asks for the tail after the verified head, keeps one verifier, and drops that state for one full export when the cursor is unknown or the tail does not extend it. A full verify yields about every 50 ms so the page can paint.
