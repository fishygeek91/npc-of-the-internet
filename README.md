# NPC of the Internet — The Wanderer

One AI being. One place at a time. A soul anyone can read and no one can secretly edit.

The Wanderer is a persistent AI entity that roams the internet — living in one community at a time (Discord, web, Matrix, ...), remembering everywhere it's been, and evolving in public. Its identity is an open, verifiable ledger: the **soulchain**.

## The two protocols

- **Open Soul Protocol (OSP)** — portable, append-only, auditable identity and memory for an AI agent. The soul *is* the entity; the model underneath is swappable.
- **Proof-of-Presence (PoP)** — cryptographic guarantee that the Wanderer exists in exactly one place at a time, with public proofs of every arrival, departure, and violation.

Both are specified standalone — use them without the Wanderer.

## Read more

- [WHITEPAPER.md](WHITEPAPER.md) — the concept: why scarcity, continuity, and shared witness make an AI worth caring about. Includes prior art.
- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime, soulchain, key custody, Doors, immune system, Atlas.

## Building it (agents start here)

This project is built end to end by AI agents:

- [AGENTS.md](AGENTS.md) — directives for AI agents. **Read first.**
- [ENGINEERING.md](ENGINEERING.md) — all technical decisions (monorepo, stack, testing, CI/CD, deployment). Final pre-1.0; don't re-litigate.
- [TASKS.md](TASKS.md) — the full build broken into small tasks with dependencies and acceptance criteria. Pick the lowest-numbered unblocked task.
- [LIFECYCLE.md](LIFECYCLE.md) — the AI-end-to-end delivery workflow: issues → branches → PRs → AI review → merge, with exactly two human gates (approval to begin, approval for production). Cursor agents also get these rules via `.cursor/rules/`.

## Status

Pre-v0.1 ("Ghost"). Current milestone: a single Discord Door running the core loop — reside → distill memories → publish journal → move on.

## Principles

Open source (MIT/Apache). No token. No raw conversation storage — only distilled, host-co-signed memories. Honest about what it is: a character and a protocol experiment, raised by the internet.

## Contributing

Everything is open — the soul, the specs, and the process. Issues and PRs welcome.
