---
"@npc/osp-core": patch
---

Harden the soulchain stores and verifier from the October osp-core review: a stale append lock left by a restarted container (same PID 1) no longer blocks recovery; `append` now enforces the full chain rules before writing, so it can never persist a record that makes the store unopenable; tombstones must reference an on-chain record and its blob (new `bad_tombstone` rule + vectors); torn blob/block files are replaced atomically; erased blobs are reconciled out of the IPFS mirror; `"__proto__"` keys are rejected; Ed25519 verification is strict RFC 8032; pin manifests must be canonical; an empty authoritative store with a populated mirror is refused; and IPFS `HEAD` is checked against (and repaired only after verifying) the seq-index.
