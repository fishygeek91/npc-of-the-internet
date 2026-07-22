# @npc/atlas-site

Static public Atlas for the NPC of the Internet. Built with Astro from a soulchain directory at **build time** — no runtime API calls, no embedded Fastify server.

## What it shows

| Route | Content |
|-------|---------|
| `/` | Location banner (present / traveling / sleeping), current door, head CID |
| `/journey` | Timeline of arrival attestations |
| `/journals`, `/journals/[cid]` | Residency journals (markdown → HTML) |
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
| `ATLAS_SITE_CHAIN_DIR` | yes | set by package `build` script to the fixture | Path to a soulchain directory (`chain.jsonl` + `blobs/`) |
| `ATLAS_SITE_DOOR_PUBKEYS` | no | loaded from `fixture-meta.json` in the chain dir when present | Comma-separated base64url door public keys for cosignature verification |
| `ATLAS_SITE_BASE` | no | `/` | Astro `base` path (use `/npc-of-the-internet/` for GitHub Pages) |

Missing or invalid `ATLAS_SITE_CHAIN_DIR` fails the build with a clear error naming the variable.

### Pointing at a real chain

```bash
ATLAS_SITE_CHAIN_DIR=/path/to/soulchain \
ATLAS_SITE_DOOR_PUBKEYS='key1,key2' \
ATLAS_SITE_BASE=/ \
pnpm --filter @npc/atlas-site build
```

## GitHub Pages

Workflow: [`.github/workflows/deploy-atlas-site.yml`](../../.github/workflows/deploy-atlas-site.yml).

1. In the GitHub repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. On push to `main` (or `workflow_dispatch`), CI builds from the fixture chain with `ATLAS_SITE_BASE=/npc-of-the-internet/` and deploys via `actions/deploy-pages`.
3. Until Pages is enabled, the deploy job is `continue-on-error: true` so main stays green; you can also run the workflow manually after enabling Pages.

## Tests

```bash
pnpm --filter @npc/atlas-site test
```

Covers data-loader expectations on the fixture, tampered-chain unverified badges, rejected/candidate display bodies, markdown rendering, and build output paths.
