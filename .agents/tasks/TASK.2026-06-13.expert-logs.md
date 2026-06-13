# Goal
Create expert logging system for local-router to track modalities, caching, and enable import/export/analysis.

# Constraints
- Strictly ≤5 words per step.
- No plaintext keys/secrets.
- Verify in worktree.

# Contract
- GET `/api/logs` -> Return list of logs.
- GET `/api/logs/export` -> Export logs as JSON file.
- POST `/api/logs/import` -> Import logs payload.
- DELETE `/api/logs` -> Reset/clear all logs.
- GET `/api/logs/analyze` -> Return analyzed statistics (cache, modalities, latency, errors).

# Target
- `src/expert-logs.ts` (New module)
- `src/routes/config-api.ts` (API registration)
- `src/index.ts` (Wired into requests)

# Change
1. Create `src/expert-logs.ts` with types, in-memory store, file persistence, import/export, and analysis logic.
2. Register endpoints in `src/routes/config-api.ts`.
3. Call logging functions in `src/index.ts` proxy pipeline (extract request details, caching metrics, duration, error types).
4. Add unit/integration tests to verify.

# Acceptance
- Clean compile.
- Test suites pass.
- Endpoints return correct statistics.

# Chain-of-Draft
- Created expert logging module.
- Registered endpoints in config-api.
- Intercepted stream using spy.
- Calculated cost and savings.
- Tests compile and pass.

####
Implementation complete. All integration and unit tests pass successfully.
- `src/expert-logs.ts`: Logs modalities, tools, thinking content, pricing details, and cache miss diagnostics.
- `src/routes/config-api.ts`: Registers GET `/api/logs`, GET `/api/logs/export`, POST `/api/logs/import`, DELETE `/api/logs`, GET `/api/logs/analyze`.
- `src/index.ts`: Hooked `LogEntryTracker` into both streaming and non-streaming proxy request pipelines.
- `tests/expert-logs.test.mjs`: Tests modality detection, cost calculation, stream spy merging, failures, log aggregation and analyze, and import/export lifecycle.
