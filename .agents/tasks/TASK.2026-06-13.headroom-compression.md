# TASK: Headroom Compression Integration

## Chain-of-Draft
- headroom-ai = proxy-based compressor
- TS SDK compress() → HTTP /v1/compress
- Toggle like wafer ZDR pattern
- Enabled default, persisted JSON
- Insert before prompt caching
####

## Deliverables
1. `headroom-ai` npm dependency added
2. `headroom-config.json` at `~/.config/local-router/` — `{ enabled: true, proxyUrl: "http://localhost:8787" }`
3. Toggle state: `let headroomEnabled = true` + load/persist like wafer ZDR
4. `compressWithHeadroom(body, model)` — calls headroom compress, replaces `body.messages` in-place
5. Wired into `proxyModelAttempt` pipeline: sanitize → **headroom** → caching → provider
6. Config API: `GET/PUT /api/headroom-config`
7. ConfigApiDeps updated with headroom state + persist + payload
8. Tests verifying toggle on/off, fallback on proxy unavailable
9. `llms.txt` updated with `headroom-config.json` in settings map
