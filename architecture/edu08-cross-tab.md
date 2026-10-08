# EDU-08 cross-tab recovery boundary

Cross-tab classroom saves use a persisted content revision compare-and-swap. A conflict draft retains the captured owner and payload separately from the active classroom.

Recovery copies are self-contained: media rows and generated-agent rows are cloned under new IDs, and all stage, scene, chat, and content references are remapped inside one IndexedDB transaction. The source classroom remains unchanged and the copied classroom can survive source cleanup.

Conflict actions capture the active owner and edit revision before awaiting IndexedDB work. Read-latest aborts if navigation or a new edit occurs during that wait and keeps the newest draft. Saving an older retained draft never cancels a debounce owned by a newer active owner; it flushes that owner when needed so the edit is durable before the recovery copy completes.
