# TASK.2026-08-17 — modal-proxy provider + Kimi-K3 (Windows/WSL bootstrap)

## Task
Integrate Nbiish Modal Kimi-K3 deployment. Bootstrap repo for Windows/WSL machine.

## Chain of Draft
- Read llms.txt, AGENTS.md. Bound.
- main = develop at cb16ff9. Pulled clean.
- Worktree feat/modal-kimi-k3. Sibling path.
- Endpoint: nbiish--ep-kimi-k3-nbiish-server.us-west.modal.direct/v1.
- Bearer = token_id dot secret. Single combined value.
- New provider modal-proxy. Env key MODAL_PROXY_API_KEY.
- Model moonshotai/Kimi-K3. Presented modal-proxy-kimi-k3.
- Specs: 262K ctx, 262K out. Tools yes. Vision no. Reasoning yes.
- Kimi family: reasoning stripped. providers.txt cell NO*.
- Pricing 0/0. Own deployment, no per-token billing.
- Fallback: insert after modal-glm-5.1-fp8. Same band.
- bin/pqc-secrets committed = Mach-O arm64. Dead here.
- Wrapper: darwin binary else uv Python engine. Same bundle format.
- Bump execFileSync timeouts. uv cold start exceeds 10s.
- Machine PQC: keygen fresh. Pack modal key only.
- Gates: model-specs validator, cline-kilo validator, npm test.
- Smoke: port 11436. Verify PQC load + chat 200.

#### 
Deliverables: bin wrapper + darwin binary rename, providers.txt two rows + header, model-specs.json kimi-k3, routing-defaults.ts candidate + chain, provider-pricing.ts entry, index.ts tier order + prefix map, llms.txt counts, this task file. No secrets in any file.
