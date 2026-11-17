---
"@npc/runtime": minor
---

Wire BudgetedBrain into the residency daemon. A known exhausted balance appends a soul-signed sleep record, heartbeats and travel pause while asleep, and `wanderer wake` clears a provider or unknown-spend latch. `wanderer budget-init` creates the spend journal; boot no longer does.
