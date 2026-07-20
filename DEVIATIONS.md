# DEVIATIONS.md

Smallest workarounds when ENGINEERING.md or spec prose blocks implementation. One paragraph per entry; link the task if applicable.

## T1.1 — CID base32 prefix (`bafy` vs `bagu`)

Spec and issue prose sometimes example soulchain CIDs as CIDv1 base32 strings beginning with `bafy…` (dag-pb). Normative encoding in `spec/osp/records.md` requires the **dag-json** codec with **sha2-256**, which yields CIDv1 base32 prefixes `bagu…`. Implementation and tests follow the codec requirement; informal `bafy` examples in prose are non-normative.
