#!/usr/bin/env bash
# Smoke-test ops/scripts/preflight-keys.mjs (#197).
# Keys are 32-byte fills (0x11 raw, 0x22 base64url). Never print private key bytes.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="${root}/ops/scripts/preflight-keys.mjs"
entry="${root}/packages/osp-core/dist/index.js"
hint="preflight-keys: build @npc/osp-core first (pnpm --filter @npc/osp-core build)"

if [[ ! -f "${entry}" ]]; then
  printf "%s\n" "${hint}" >&2
  exit 2
fi

tmp="$(mktemp -d)"
backup="$(mktemp)"
cp "${entry}" "${backup}"

# Restore a swapped dist if this script exits early. Keys live only in tmp.
cleanup() {
  if [[ -f "${backup}" ]]; then
    cp "${backup}" "${entry}"
    rm -f "${backup}"
  fi
  rm -rf "${tmp}"
}
trap cleanup EXIT

PREFLIGHT_TMP="${tmp}" node --input-type=module <<'EOF'
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PREFLIGHT_TMP;
if (dir === undefined || dir === "") {
  process.stderr.write("preflight-keys-ci: missing temp dir\n");
  process.exit(1);
}
writeFileSync(join(dir, "raw.key"), Buffer.alloc(32, 0x11));
const textKey = Buffer.alloc(32, 0x22);
writeFileSync(join(dir, "b64.key"), `${textKey.toString("base64url")}\n`);
writeFileSync(join(dir, "bad.key"), "not-a-key\n");
EOF

# Print the public key, or fail when it is not 43-char base64url.
expect_pub() {
  local mode="$1"
  local file="$2"
  local pub
  pub="$(node "${helper}" "${mode}" "${file}")" || exit 1
  if [[ ! "${pub}" =~ ^[A-Za-z0-9_-]{43}$ ]]; then
    printf "preflight-keys-ci: %s did not print a public key\n" "${mode}" >&2
    exit 1
  fi
  printf "%s" "${pub}"
}

soul_raw="$(expect_pub soul "${tmp}/raw.key")" || exit 1
door_raw="$(expect_pub door "${tmp}/raw.key")" || exit 1
soul_b64="$(expect_pub soul "${tmp}/b64.key")" || exit 1
door_b64="$(expect_pub door "${tmp}/b64.key")" || exit 1

if [[ "${soul_raw}" != "${door_raw}" || "${soul_b64}" != "${door_b64}" ]]; then
  printf "preflight-keys-ci: soul and door modes disagreed\n" >&2
  exit 1
fi
if [[ "${soul_raw}" == "${soul_b64}" ]]; then
  printf "preflight-keys-ci: distinct fill keys produced the same public key\n" >&2
  exit 1
fi

set +e
node "${helper}" soul "${tmp}/bad.key" >"${tmp}/bad.out" 2>"${tmp}/bad.err"
bad_code=$?
set -e
if [[ "${bad_code}" -ne 1 ]]; then
  printf "preflight-keys-ci: bad key exited %s, want 1\n" "${bad_code}" >&2
  cat "${tmp}/bad.err" >&2
  exit 1
fi
if grep -F -q "not-a-key" "${tmp}/bad.out" "${tmp}/bad.err"; then
  printf "preflight-keys-ci: bad-key output echoed the input\n" >&2
  exit 1
fi

# A module that loads without the parser export must use the build hint (exit 2).
printf "%s\n" 'export const packageName = "@npc/osp-core";' >"${entry}"
ENTRY="${entry}" node --input-type=module <<'EOF'
import { createRequire } from "node:module";

const entryPath = process.env.ENTRY;
if (entryPath === undefined || entryPath === "") {
  process.stderr.write("preflight-keys-ci: missing dist entry\n");
  process.exit(1);
}
const loaded = createRequire(entryPath)(entryPath);
if (loaded === null || typeof loaded !== "object") {
  process.stderr.write("preflight-keys-ci: stale stub did not load\n");
  process.exit(1);
}
if (typeof loaded.parsePrivateKeyBytes === "function") {
  process.stderr.write("preflight-keys-ci: stale stub still exported the parser\n");
  process.exit(1);
}
EOF
set +e
node "${helper}" soul "${tmp}/raw.key" >"${tmp}/stale.out" 2>"${tmp}/stale.err"
stale_code=$?
set -e
if [[ -f "${backup}" ]]; then
  cp "${backup}" "${entry}"
  if ! cmp -s "${backup}" "${entry}"; then
    printf "preflight-keys-ci: failed to restore osp-core dist\n" >&2
    exit 1
  fi
  rm -f "${backup}"
fi
if [[ "${stale_code}" -ne 2 ]]; then
  printf "preflight-keys-ci: stale build exited %s, want 2\n" "${stale_code}" >&2
  cat "${tmp}/stale.err" >&2
  exit 1
fi
if [[ -s "${tmp}/stale.out" ]]; then
  printf "preflight-keys-ci: stale build wrote to stdout\n" >&2
  exit 1
fi
if ! grep -F -x -q "${hint}" "${tmp}/stale.err"; then
  printf "preflight-keys-ci: stale build did not print the build hint\n" >&2
  cat "${tmp}/stale.err" >&2
  exit 1
fi

printf "preflight-keys-ci: raw, base64url, bad key, and stale build ok\n"
