---
"@npc/atlas": patch
---

Bump the root `fast-uri` override from the pinned `4.1.2` (itself now a fixable HIGH advisory) to `>=4.1.3` (resolves 4.2.1), clearing the Trivy gate that blocked the `npc-atlas-api` v0.3.1 image from publishing (#147). The vulnerable path was `packages/atlas > fastify > @fastify/ajv-compiler > ajv > fast-uri`; runtime, door-discord, and backup images were unaffected and published normally.
