---
"@npc/atlas": patch
"@npc/door-discord": patch
---

Dependency security floors so the release images pass the Trivy gate: `fastify` ^5.12.2 in atlas-api (CVE-2026-76169, CVE-2026-84428, CVE-2026-84469, CVE-2026-84504; was 5.10.0) and a root `undici@6` override ^6.28.1 for door-discord's discord.js tree (CVE-2026-19534; was 6.27.0). v0.4.1 published only the runtime and backup images.
