# TASK 2026-08-29: GitHub Copilot OAuth Device Flow & UI Login Fix

- User clicks Copilot login.
- Device flow returned userCode.
- UI missed opening verificationUri.
- Add clipboard copy userCode.
- Auto-open https://github.com/login/device.
- Re-render pending status card.
- Add detectLocalCopilotSession hosts.json.
- Rebuild and test.
####
