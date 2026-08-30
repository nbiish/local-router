#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  fuse_knowledge.sh — Fuse knowledge bases into documents          ║
# ║                                                                 ║
# ║  Pipeline:                                                      ║
# ║    1. Condense video knowledge base via Orchestrator             ║
# ║    2. Split document into semantic sections                        ║
# ║    3. Sub-agent integrates relevant knowledge per section        ║
# ║    4. Reviewer validates via Validation Gate            ║
# ║    5. Merge approved sections back into working scroll           ║
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${LAB_DIR}/lib"

# shellcheck source=lib/provider.sh
source "${LIB_DIR}/provider.sh"

# ── Configuration ────────────────────────────────────────────────
TARGET_FILE="${1:-target_document.md}"
OMNI_DIR="${2:-omni_output}"
PROMPTS_DIR="${LAB_DIR}/prompts"

if [[ ! -f "${TARGET_FILE}" ]]; then
  echo "✗ Target document not found: ${TARGET_FILE}"
  exit 1
fi

# Create run directory
RUN_ID="omni_$(date +%Y%m%d_%H%M%S)"
RUN_DIR="${PWD}/logs/${RUN_ID}"
mkdir -p "${RUN_DIR}/sections" "${RUN_DIR}/enhanced" "${RUN_DIR}/reviews"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  KNOWLEDGE FUSION PIPELINE                                 ║"
echo "║  Fusing external knowledge into target documents           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Run ID: ${RUN_ID}"
echo "Document: ${TARGET_FILE}"
echo ""

# ── Step 0: Locate Knowledge Bases ──────────────────────────────
KB_FILES=()
shopt -s nullglob
for f in "${OMNI_DIR}"/*_analysis.md "${OMNI_DIR}"/*.vtt; do
  [[ -f "${f}" ]] && KB_FILES+=("${f}")
done
shopt -u nullglob

if [[ ${#KB_FILES[@]} -eq 0 ]]; then
  echo "✗ No knowledge base files found in ${OMNI_DIR}"
  echo "  Run video-knowledge-extractor skill first to generate the knowledge base."
  exit 1
fi

echo "── Knowledge Base Files ──────────────────────────────────────"
for kb in "${KB_FILES[@]}"; do
  echo "  • $(basename "${kb}") ($(wc -c < "${kb}" | tr -d ' ') bytes)"
done
echo ""

# ── Step 1: Orchestrator condenses the knowledge base ───────────
echo "── Step 1: Condensing Knowledge Base ─────────────────────────"

# Combine all KB files into one condensed reference
COMBINED_KB="${RUN_DIR}/combined_kb.md"
cat > "${COMBINED_KB}" <<'EOF'
# Combined Video Analysis Knowledge Base
# Use these findings to enhance the Target Document.
---
EOF

for kb in "${KB_FILES[@]}"; do
  echo "" >> "${COMBINED_KB}"
  echo "---" >> "${COMBINED_KB}"
  echo "## Source: $(basename "${kb}")" >> "${COMBINED_KB}"
  # Truncate each KB to 40K chars max to keep within context window
  head -c 40000 "${kb}" >> "${COMBINED_KB}"
done

KB_SIZE=$(wc -c < "${COMBINED_KB}" | tr -d ' ')
echo "  Combined KB size: ${KB_SIZE} bytes"

# Write condensation prompt
CONDENSE_USER="${RUN_DIR}/condense_user.md"
cat > "${CONDENSE_USER}" <<EOF
Analyze this video knowledge base and extract ONLY the critical, actionable findings relevant to:
1. Core concepts and actionable findings.
2. Critical data points, statistics, and references.
3. Methodologies, techniques, or strategies discussed.
4. Any direct connections to the target document's objectives.
5. Extract all knowledge needed to directly support the primary objectives of the target document. Strip all filler and focus exclusively on high-signal intelligence.

Output a condensed reference document (under 8000 tokens) organized by theme. Include specific CVEs, tool names, dollar costs, and technical details. Strip all filler.

---
KNOWLEDGE BASE:
$(cat "${COMBINED_KB}")
EOF

CONDENSED_KB="${RUN_DIR}/condensed_kb.md"
echo "  Sending to orchestrator for condensation..."
if orchestrator_call "${PROMPTS_DIR}/orchestrator_system.md" "${CONDENSE_USER}" "${CONDENSED_KB}"; then
  echo "  ✓ Condensed KB saved ($(wc -c < "${CONDENSED_KB}" | tr -d ' ') bytes)"
else
  echo "  ✗ Orchestrator condensation failed. Using raw KB instead."
  cp "${COMBINED_KB}" "${CONDENSED_KB}"
fi

echo ""

# ── Step 2: Split document into semantic sections ─────────────────
echo "── Step 2: Splitting document into sections ────────────────────"

# Split on H2 (##) headers for semantic chunking
python3 - "${TARGET_FILE}" "${RUN_DIR}/sections" <<'PYEOF'
import sys, re, os
scroll_path = sys.argv[1]
sections_dir = sys.argv[2]
os.makedirs(sections_dir, exist_ok=True)

with open(scroll_path, "r", encoding="utf-8", errors="replace") as f:
    content = f.read()

# Split on H2 or H3 headers
parts = re.split(r'^(#{2,3}\s+.+)$', content, flags=re.MULTILINE)

sections = []
current_header = "## Preamble"
current_content = ""

for part in parts:
    if re.match(r'^#{2,3}\s+', part):
        if current_content.strip():
            sections.append((current_header, current_content))
        current_header = part.strip()
        current_content = ""
    else:
        current_content += part

if current_content.strip():
    sections.append((current_header, current_content))

# Write each section to a file
for i, (header, body) in enumerate(sections):
    section_path = os.path.join(sections_dir, f"section_{i:02d}.md")
    with open(section_path, "w") as f:
        f.write(header + "\n" + body)
    # Clean up header for display
    clean_header = header.replace("#", "").strip()[:60]
    print(f"  {i:02d}: {clean_header}")

print(f"\nTotal sections: {len(sections)}")
PYEOF

SECTION_COUNT=$(ls -1 "${RUN_DIR}/sections/" | wc -l | tr -d ' ')
echo ""
echo "  Split into ${SECTION_COUNT} sections."
echo ""

# ── Step 3: Orchestrator identifies integration targets ─────────
echo "── Step 3: Identifying integration targets ───────────────────"

PLAN_USER="${RUN_DIR}/plan_user.md"
cat > "${PLAN_USER}" <<EOF
Given this condensed knowledge from video analysis:

$(cat "${CONDENSED_KB}")

---

And these document sections:
$(for f in "${RUN_DIR}"/sections/section_*.md; do
  echo "- $(basename "${f}"): $(head -1 "${f}" | sed 's/#//g' | head -c 80)"
done)

---

Identify which sections should receive knowledge integration. Output a JSON array:
\`\`\`json
[
  {
    "section_file": "section_XX.md",
    "section_title": "Title",
    "priority": 1-10,
    "knowledge_themes": ["theme1", "theme2"],
    "integration_notes": "Specific guidance on what knowledge to weave in and where"
  }
]
\`\`\`

Only include sections where integration would be meaningful. Maximum 8 sections.
Order by priority (highest first).
EOF

PLAN_FILE="${RUN_DIR}/integration_plan.json"
echo "  Sending to orchestrator..."
if orchestrator_call "${PROMPTS_DIR}/orchestrator_system.md" "${PLAN_USER}" "${PLAN_FILE}"; then
  echo "  ✓ Integration plan saved"
else
  echo "  ✗ Failed to generate plan. Exiting."
  exit 1
fi

# ── Step 4: Extract plan and integrate per section ──────────────
echo ""
echo "── Step 4: Integrating knowledge per section ─────────────────"

# Extract section filenames from the plan JSON
TARGETS=$(python3 -c '
import json, sys, re
raw = open(sys.argv[1]).read()
# Extract JSON from potential markdown wrapping
match = re.search(r"\[.*\]", raw, re.DOTALL)
if match:
    data = json.loads(match.group())
    for item in data:
        sf = item.get("section_file", "")
        notes = item.get("integration_notes", "")
        # Escape notes for shell
        notes = notes.replace("\"", "\\\"").replace("\n", " ")
        print(f"{sf}|{notes}")
' "${PLAN_FILE}" 2>/dev/null || echo "")

if [[ -z "${TARGETS}" ]]; then
  echo "  ✗ Could not parse integration plan. Check ${PLAN_FILE}"
  exit 1
fi

INTEGRATE_COUNT=0
while IFS='|' read -r section_file notes; do
  [[ -z "${section_file}" ]] && continue
  
  section_path="${RUN_DIR}/sections/${section_file}"
  if [[ ! -f "${section_path}" ]]; then
    echo "  ⚠ Section not found: ${section_file}, skipping"
    continue
  fi

  INTEGRATE_COUNT=$((INTEGRATE_COUNT + 1))
  section_title=$(head -1 "${section_path}" | sed 's/#//g' | head -c 60)
  echo ""
  echo "  ┌─ [${INTEGRATE_COUNT}] ${section_title}"
  echo "  │  File: ${section_file}"
  echo "  │  Notes: ${notes:0:80}..."

  # Build user prompt for subagent
  INTEGRATE_USER="${RUN_DIR}/integrate_user_${section_file}"
  cat > "${INTEGRATE_USER}" <<SUBEOF
## Integration Task

**Target Section:**
$(cat "${section_path}")

---

**Condensed Video Knowledge Base:**
$(cat "${CONDENSED_KB}")

---

**Integration Notes from Orchestrator:**
${notes}

---

Weave the relevant knowledge into this section. Follow the integrator system prompt exactly.
SUBEOF

  # Call subagent
  ENHANCED_PATH="${RUN_DIR}/enhanced/${section_file}"
  if subagent_call "${PROMPTS_DIR}/integrator_system.md" "${INTEGRATE_USER}" "${ENHANCED_PATH}"; then
    echo "  │  ✓ Enhanced ($(wc -c < "${ENHANCED_PATH}" | tr -d ' ') bytes)"
  else
    echo "  │  ✗ Sub-agent failed. Keeping original."
    cp "${section_path}" "${ENHANCED_PATH}"
    echo "  └─ SKIPPED"
    continue
  fi

  # ── Review the enhanced section ─────────────────────────────
  REVIEW_USER="${RUN_DIR}/review_user_${section_file}"
  cat > "${REVIEW_USER}" <<REVEOF
## Review Task

**ORIGINAL Section:**
$(cat "${section_path}")

---

**ENHANCED Section:**
$(cat "${ENHANCED_PATH}")

---

Review the enhanced section against the Validation Gate.
Also verify that new knowledge has been woven in naturally, not just appended.
REVEOF

  REVIEW_PATH="${RUN_DIR}/reviews/${section_file}.json"
  if reviewer_call "${PROMPTS_DIR}/reviewer_system.md" "${REVIEW_USER}" "${REVIEW_PATH}"; then
    # Extract verdict
    VERDICT=$(python3 -c '
import json, sys, re
raw = open(sys.argv[1]).read()
match = re.search(r"\{.*\}", raw, re.DOTALL)
if match:
    data = json.loads(match.group())
    print(data.get("verdict", "UNKNOWN"))
    print(data.get("score", 0))
else:
    print("UNKNOWN")
    print("0")
' "${REVIEW_PATH}" 2>/dev/null || echo -e "UNKNOWN\n0")

    VERDICT_LINE=$(echo "${VERDICT}" | head -1)
    SCORE_LINE=$(echo "${VERDICT}" | tail -1)

    if [[ "${VERDICT_LINE}" == "APPROVE" ]]; then
      echo "  │  ✓ APPROVED (score: ${SCORE_LINE})"
    else
      echo "  │  ⚠ REVISE requested (score: ${SCORE_LINE})"
      echo "  │    Keeping enhanced version for manual review"
    fi
  else
    echo "  │  ⚠ Reviewer failed. Keeping enhanced version."
  fi

  echo "  └─ DONE"

done <<< "${TARGETS}"

echo ""

# ── Step 5: Reassemble the document ──────────────────────────────
echo "── Step 5: Reassembling document ───────────────────────────────"

OUTPUT_DOC="${TARGET_FILE}"
BACKUP_DOC="${RUN_DIR}/$(basename "${TARGET_FILE}").backup"

# Backup current scroll
cp "${OUTPUT_DOC}" "${BACKUP_DOC}"
echo "  Backed up to: ${BACKUP_DOC}"

# Reassemble: for each section, use enhanced version if available, else original
ASSEMBLED="${RUN_DIR}/assembled.md"
> "${ASSEMBLED}"

for section_path in "${RUN_DIR}"/sections/section_*.md; do
  section_name="$(basename "${section_path}")"
  enhanced_path="${RUN_DIR}/enhanced/${section_name}"
  
  if [[ -f "${enhanced_path}" ]]; then
    cat "${enhanced_path}" >> "${ASSEMBLED}"
  else
    cat "${section_path}" >> "${ASSEMBLED}"
  fi
  echo "" >> "${ASSEMBLED}"
done

# Write assembled output
cp "${ASSEMBLED}" "${OUTPUT_DOC}"
echo "  ✓ Scroll reassembled → ${OUTPUT_DOC}"

# Generate diff
DIFF_FILE="${RUN_DIR}/integration_diff.patch"
diff -u "${BACKUP_DOC}" "${OUTPUT_DOC}" > "${DIFF_FILE}" 2>/dev/null || true
DIFF_LINES=$(wc -l < "${DIFF_FILE}" | tr -d ' ')
echo "  Diff: ${DIFF_LINES} lines changed → ${DIFF_FILE}"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  INTEGRATION COMPLETE                                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Sections processed: ${INTEGRATE_COUNT}                     ║"
echo "║  Output: ${OUTPUT_DOC}                                   ║"
echo "║  Backup: ${BACKUP_DOC}                                   ║"
echo "║  Diff:   ${DIFF_FILE}                                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
