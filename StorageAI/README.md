# StorageAI Task Manager and Plan

## Checklist

- [x] All previous tasks completed.
- [x] Centralized window sizing (single source of truth) under `src/ui/main_window.py`.
- [x] Improve item name normalization for LLM/regex: strip quantifiers (e.g., "sticks of"), remove plural descriptors, and singularize common plurals (e.g., "coat hangers" → "coat hanger").
- [x] Improve box slot-filling: LLM-assisted normalization with spoken-letter mapping (e.g., "bee"/"be" → `B`, strip "box " prefix) and robust matching to existing boxes.
- [x] Multi-intent: propagate shared destination box (full names supported) to all ADD ops when stated once.
- [x] FIND: list all similar items above the semantic threshold (with boxes and scores), in addition to the best hit.
- [x] Box letter failsafes: map "are" → `R` and support "R as in <word>" style answers.