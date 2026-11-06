# TypeSafe image and Box capabilities

## Current synopsis

TypeSafe's image support is composable: an image can appear in `state`, a question's
`instructions`, or a question's `criteria`. Images are declared once in the request's top-level
`assets` map and referenced by a collision-resistant string. The API accepts base64 assets or
multipart file parts. Every asset must be referenced, and each reference occurrence adds another
image copy to the expanded request.

The `box` primitive, available with Jev 1.14, returns one normalized bounding box:
`{top, bottom, left, right}`, with all edges in `[0, 1]` relative to the image dimensions. It has
no criteria. Because Box has no not-found answer, pair it with a Noul that checks presence and
apply the box only when the presence probability clears the application's review threshold.

Images and Box are behind the required header:

```text
TypeSafe-Danger-Zone-Images: true
```

They are dreamer-ready prototypes, not production-ready guarantees. Syntax, limits, accuracy, and
model behavior may change. Jev 1.13 and 1.14 accept images; Box requires Jev 1.14. Jev 1.14 also
adds the new Box type, longer-context opt-in, and small general improvements with the largest
expected gain in multilingual support. The longer-context and image flags are separate concerns;
do not enable either by default.

## Safe request pattern

```json
{
  "model": "jev-1.14.0",
  "state": {"photo": "asset-photo"},
  "assets": {
    "asset-photo": {
      "type": "image",
      "format": "jpg",
      "data_base64": "..."
    }
  },
  "questions": {
    "present": {
      "type": "noul",
      "instructions": "Is the target present in `photo`?",
      "criteria": {"true": "The target is visible.", "false": "The target is absent or unreadable."}
    },
    "target": {
      "type": "box",
      "instructions": "the target in `photo`"
    }
  }
}
```

Keep the image question observable and narrow. Crop large images before locating small objects,
use a fresh collision-resistant asset reference per request, and treat low confidence as a review
or retry signal rather than proof of correctness.

## Adoption map for this repository

- **ComfyUI orchestration:** use Box to locate a control or node in a screenshot before a human
  confirms a UI action; use a Noul first and never click based on Box alone.
- **Browser and screenshot workflows:** screen for a visible dialog, warning, or consent prompt;
  route uncertain results to human takeover rather than automating around them.
- **Scanned documents and project records:** locate signatures, stamps, or fields, then pass the
  crop to deterministic OCR or a human reviewer. Do not infer legal or identity facts from a Box.
- **Lyrics, visual assets, and generated media:** classify whether a composition contains the
  requested element, then use a Box to guide a crop or edit preview; preserve the original asset.
- **RAG/wiki evidence:** use image questions to triage diagrams or screenshots into a review queue,
  not to silently promote image-derived claims into durable memory.
- **8th Fire and cultural material:** keep image processing within the existing governance boundary,
  obtain human/community authority where required, and do not upload protected material merely to
  experiment.

The first practical learning path is a non-destructive screenshot triage prototype: Noul presence
check, Box localization, confidence logging, padded crop, and human confirmation. Measure false
presence, missed targets, and crop quality on representative images before considering any
production automation.

## Sources

- https://docs.typesafe.ai/images
- https://docs.typesafe.ai/primitives/box
- https://typesafe.ai/blog/jev-1-14
- https://github.com/typesafe-ai/skills (upstream MIT skill)
