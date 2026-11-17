---
"@npc/atlas-site": patch
---

Render journal markdown with marked 18. HTML declarations keep trailing text inside the escaped token, and blank lines around HTML blocks are trimmed. Raw HTML and dangerous URL schemes stay neutralized.
