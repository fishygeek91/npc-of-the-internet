# @npc/osp-cli

The `osp` command-line tool for initializing and inspecting a local soulchain.

## Protect `soul.key`

**Treat `soul.key` like a root password.** Anyone with this file can sign soulchain records as the Wanderer. Keep it offline, restrict file permissions (`0o600` on init), never commit it, and never copy it into `blobs/` or `chain.jsonl`.

`osp init` refuses to run when `soul.key` or `chain.jsonl` already exists in the target directory (exit 2). There is no `--force` — delete the file yourself if you intentionally want a new identity. Re-running init on a live soulchain would otherwise replace the private key with no recovery copy.

## Commands

| Command | Description |
| --- | --- |
| `osp init <dir>` | Generate a soul key, write genesis from the charter, append to a new chain |
| `osp verify <dir>` | Verify signatures, links, and schema for the full chain (read-only) |
| `osp verify --from-ipfs <head-cid> [--gateway <url>]` | Fetch head→genesis via trustless gateway raw blocks, then verify (no CI network) |
| `osp manifest <dir>` | Build/sign a pin manifest for an `IpfsSoulStore` directory; print manifest CID |
| `osp export-car <dir> --out <path>` | Build/sign manifest and write a CARv1 rooted at the manifest CID |
| `osp log <dir>` | Stream a human-readable listing of chain records |
| `osp show <cid> --dir <dir>` | Pretty-print one record by CID |

### Pin manifest / CAR (`IpfsSoulStore` layout)

`osp manifest` and `osp export-car` require an on-disk `IpfsSoulStore` (`blocks/`, `HEAD`, `seq-index.jsonl`) plus `soul.key` (default `<dir>/soul.key`, override with `--soul-key`). Use `--generated-at <iso>` for deterministic timestamps in tests.

### Charter resolution

`osp init` loads the Wanderer's charter from `spec/osp/genesis.md` when run inside this repository. Override with `--charter <path>`. Init fails clearly if the charter file is missing or empty.

### Verify is read-only

`osp verify` opens the store with `FileSoulStore.openReadOnly`. It never creates `blobs/` or `chain.jsonl`, so it works on read-only mounts and restored backups. An empty or uninitialized directory exits `2` instead of silently laying out a store.

### Door keys for verify

Pass repeatable `--door-key <doorId=base64url>` flags to supply Door public keys for cosignature verification.

## Walkthrough

From the repository root after `pnpm install` and `pnpm --filter @npc/osp-cli build`:

```bash
DIR=$(mktemp -d)
node packages/osp-cli/dist/cli.js init "$DIR" --charter spec/osp/genesis.md
node packages/osp-cli/dist/cli.js verify "$DIR"
node packages/osp-cli/dist/cli.js log "$DIR"
CID=$(node packages/osp-cli/dist/cli.js verify "$DIR" 2>/dev/null; node packages/osp-cli/dist/cli.js log "$DIR" | awk '{print $3}' | tr -d '…' )
# Or read Genesis CID from init output:
node packages/osp-cli/dist/cli.js show "$CID" --dir "$DIR"
```

Typical init output:

```
Soul public key: <base64url Ed25519 public key>
Genesis CID: bagu…
```

`osp verify` prints nothing and exits `0` when the chain is valid. On failure it prints structured lines such as `[broken_prev_link] seq=2 cid=bagu…: prev must equal CID of record at seq 1` and exits `1`.

## Test

```bash
pnpm --filter @npc/osp-cli test
```

The e2e test invokes the **built** `dist/cli.js` via `child_process` (init → verify → log → show → tamper → verify fails).
