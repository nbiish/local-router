# TASK: Router Candidate Toggles & Reordering
Date: 2026-06-06
Branch: feat/router-candidate-toggles
Worktree: ../router-candidate-toggles

## Goal
Add toggle/enable-disable functionality to router candidates + relocate auto-router order list below the `local-router/auto-router-main` listing in `/config` UI. The list should be actively re-ordered and affected by user toggling/reordering.

## Requirements
1. ✓ Add kilo-stepfun-step-3.7-flash-free model as Ready candidate in fallback system
2. ✓ Implement toggle on/off for each candidate in the router candidate list
3. ✓ Toggled-off candidates are logically skipped during fallback execution
4. ⏸ Move auto-router order list below `<h4>local-router/auto-router-main</h4>` in UI
5. ✓ User drag-and-drop reordering updates both visual order and execution order
6. ✓ Persist toggle state alongside candidate metadata

## Implementation Summary

### Type Changes
- Added `enabled?: boolean` to `RouterCandidate` type
- Default value: `true` for all new candidates
- Persists in router-models.json

### Backend Changes
1. **parseRouterCandidateLine**: Parses `enabled=false` from text format
2. **parseRouterModel**: Handles `enabled` field from JSON (defaults to true)
3. **routerCandidateEligibility**: Checks `candidate.enabled === false` → rejection reason 'candidate_disabled'
4. **addSingleCandidate** / **addFallbackGroupCandidate**: Initialize with `enabled: true`

### UI Changes
1. **renderCandidateList**: 
   - Adds checkbox input before candidate info
   - Applies `.router-candidate-disabled` class when disabled
   - Checkbox calls `toggleCandidate(index, checked)`
2. **toggleCandidate**: New function updates store and re-renders
3. **syncCandidatesToTextarea**: Includes `enabled=false` when serializing
4. **syncTextareaToCandidates**: Parses `enabled` field from textarea

### CSS Styles
```css
.router-candidate-item.router-candidate-disabled { 
  opacity: 0.5; 
  background: var(--surface-soft); 
}
.router-candidate-item.router-candidate-disabled .candidate-model { 
  text-decoration: line-through; 
  color: var(--muted); 
}
.router-candidate-item .candidate-toggle { 
  width: 18px; 
  height: 18px; 
  cursor: pointer; 
  margin: 0; 
  flex-shrink: 0; 
}
```

### Build Status
✓ TypeScript compilation successful
✓ No build errors

####
