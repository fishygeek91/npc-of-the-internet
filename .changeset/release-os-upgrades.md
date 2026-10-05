---
"@npc/runtime": patch
"@npc/door-discord": patch
"@npc/atlas": patch
---

Release images now apply OS security updates at build time (`apt-get upgrade` on the Node images, `apk upgrade` on the backup image). v0.4.0's images were never published: the Trivy gate blocked all four on base-layer CVEs that already had fixed packages (libpcre2 CVE-2026-103111; OpenSSL CVE-2026-75804 / CVE-2026-84782). No application code changes — v0.4.1 ships the v0.4.0 features.
