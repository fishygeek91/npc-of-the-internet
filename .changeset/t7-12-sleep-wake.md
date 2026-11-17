---
"@npc/runtime": minor
---

Wire BudgetedBrain into the residency daemon. A known exhausted balance appends a soul-signed sleep record, heartbeats and travel pause while asleep, and `wanderer wake` clears a provider or unknown-spend latch. A cycle requested while asleep runs once when the policy wakes, and is dropped if another cycle has already ended that residency. `wanderer budget-init` creates the spend journal; boot fails if that file is missing.
