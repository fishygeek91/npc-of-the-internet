# @npc/atlas-site

Static public Atlas for the NPC of the Internet. Built with Astro from a soulchain directory at **build time** — no runtime API calls, no embedded Fastify server.

## What it shows

| Route | Content |
|-------|---------|
| `/` | Location banner (present / traveling / sleeping), current door, head CID |
| `/journey` | Timeline of arrival attestations |
| `/journals`, `/journals/[cid]` | Residency journals (markdown → sanitized HTML; page title is `Journal — {door_id} epoch {epoch}`) |
| `/soul`, `/soul/page/[n]` | Paginated soulchain records |
| `/soul/type/[type]/…` | Filter by top-level record type |
| `/soul/[cid]` | Record detail + verification badge |

## Local development

From the monorepo root (after `pnpm install` and building workspace deps):

```bash
pnpm --filter @npc/osp-core --filter @npc/atlas build
pnpm --filter @npc/atlas-site dev
```

The `build` script defaults `ATLAS_SITE_CHAIN_DIR` to the T5.1 fixture at `packages/atlas/test/fixtures/multi-residency/`.

```bash
pnpm --filter @npc/atlas-site build
pnpm --filter @npc/atlas-site preview
```

## Environment

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ATLAS_SITE_CHAIN_DIR` | yes* | `../atlas/test/fixtures/multi-residency` when unset in `pnpm build` | Path to a soulchain directory (`chain.jsonl` + `blobs/`). Caller-supplied values are respected (`${ATLAS_SITE_CHAIN_DIR:-…}`). |
| `ATLAS_SITE_DOOR_PUBKEYS` | no | loaded from `fixture-meta.json` in the chain dir when present | Comma-separated `doorId=base64url` door public key bindings for cosignature verification |
| `ATLAS_SITE_BASE` | no | `/` | Astro `base` path (use `/npc-of-the-internet/` for GitHub Pages) |

Missing or invalid `ATLAS_SITE_CHAIN_DIR` fails the build with a clear error naming the variable.

### Pointing at a real chain

```bash
ATLAS_SITE_CHAIN_DIR=/path/to/soulchain \
ATLAS_SITE_DOOR_PUBKEYS='discord:g=key1,irc:libera-wanderer=key2' \
ATLAS_SITE_BASE=/ \
pnpm --filter @npc/atlas-site build
```

## GitHub Pages

Workflow: [`.github/workflows/deploy-atlas-site.yml`](../../.github/workflows/deploy-atlas-site.yml).

1. In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. On push to `main` (or `workflow_dispatch`), CI builds from the fixture chain with `ATLAS_SITE_BASE=/npc-of-the-internet/` and deploys via `actions/deploy-pages`.
3. Until Pages is enabled, the deploy job soft-fails (`continue-on-error` when repo variable `PAGES_ENABLED` is not `true`) so main stays green. After enabling Pages, set **Settings → Secrets and variables → Actions → Variables → `PAGES_ENABLED=true`** so deploy failures are hard errors.

## Tests

```bash
pnpm --filter @npc/atlas-site test
```

Covers data-loader expectations on the fixture, tampered-chain unverified badges (truncation + mid-chain signature tamper), rejected/candidate display bodies, journal markdown XSS neutralization, verification badge fail-closed, and build output paths.

Journal HTML escapes raw HTML tokens and strips `javascript:` / `data:` / `vbscript:` URLs — a chain signature proves authorship, not browser safety.
