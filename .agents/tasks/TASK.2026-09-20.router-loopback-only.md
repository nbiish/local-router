# Task: router loopback-only removal — 2026-09-20
- scope: remove cloudflared + TLS/https exposure from local-router; restore Windows browser access
- branch: chore/router-remove-https-exposure (merged aed099d -> main e6dba0f, --no-ff; worktree+branch cleaned)
- gates: tsc clean; suite 171/0 (wafer-discovery excluded, pre-existing network flake)
- status: done (code + ops). open item: provider keys must be re-packed into PQC bundle (lost in 21:14 Windows-side bundle rewrite); chain exhausted until then
