#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════╗
# ║  splitter.sh — Split document files into logical sections          ║
# ║  Splits on H2 (## ) markdown headers to keep sections coherent  ║
# ╚══════════════════════════════════════════════════════════════════╝
set -euo pipefail

# Usage: split_document <input_file> <output_dir>
# Creates: output_dir/section_01.md, section_02.md, etc.
split_document() {
  local input="${1:?input file required}"
  local outdir="${2:?output directory required}"
  
  mkdir -p "${outdir}"
  
  local section_num=0
  local current_file=""
  local header_line=""
  local in_frontmatter=false
  
  while IFS= read -r line || [[ -n "${line}" ]]; do
    # Detect H2 headers as section boundaries
    if [[ "${line}" =~ ^##[[:space:]] && ! "${line}" =~ ^###[[:space:]] ]]; then
      section_num=$((section_num + 1))
      current_file="${outdir}/section_$(printf '%02d' ${section_num}).md"
      header_line="${line}"
      echo >&2 "[splitter] Section ${section_num}: ${header_line}"
    fi
    
    # If we haven't hit the first H2 yet, put content in preamble
    if [[ ${section_num} -eq 0 ]]; then
      current_file="${outdir}/section_00_preamble.md"
    fi
    
    echo "${line}" >> "${current_file}"
  done < "${input}"
  
  echo >&2 "[splitter] Split into ${section_num} sections + preamble → ${outdir}/"
  echo "${section_num}"
}

# Usage: merge_sections <sections_dir> <output_file>
# Merges all section_*.md files back in order
merge_sections() {
  local sections_dir="${1:?sections directory required}"
  local output="${2:?output file required}"
  
  > "${output}"  # truncate
  
  local count=0
  for section in "${sections_dir}"/section_*.md; do
    [[ -f "${section}" ]] || continue
    cat "${section}" >> "${output}"
    echo "" >> "${output}"  # ensure newline between sections
    count=$((count + 1))
  done
  
  echo >&2 "[merger] Merged ${count} sections → ${output}"
}
