# Calibration and live testing

Jev is inexpensive and fast, which makes probing the live API the cheapest way to validate a
question. This is the protocol the engine's thresholds were set with; repeat it whenever you change
a question, criterion, or weight.

## Rules

1. **Ask before sending data.** Point out any personal, private, or proprietary text in the state,
   disclose that `TYPESAFE_API_KEY`/the OpenRouter key will be used, and agree on a small budget.
2. Keep the exact request payload for every case; results are only reproducible with the payload.
3. Cover representative cases, hard cases, and negative cases ("nothing fits", "no", empty lists).
4. Read individual answers, not only aggregates.
5. Check every change against cases you did **not** tune on.

## Probing with the bundled script

```bash
# One typed batch; prints the raw answers, never the key.
python .agents/skills/typesafe-jev/scripts/jev_probe.py \
  --state "file src/rag/src/provider.rs resolves embedding credentials from env or the PQC store" \
  --questions '{
    "is_answerable": {"type":"noul","instructions":"Does the state name where credentials are resolved?",
      "criteria":{"true":"it names the resolver or file","false":"it does not"}},
    "component": {"type":"choice","instructions":"Which component is described?",
      "options":["provider_resolver","http_server"],
      "criteria":{"provider_resolver":"resolves keys","http_server":"serves HTTP"}},
    "utility": {"type":"score","instructions":"How directly does the state answer the question?",
      "levels":[1,2,3,4,5],
      "criteria":["none","tangential","partial","names the resolver","complete answer"]}
  }'
```

The script resolves the key exactly like the engine (env → PQC store, consumer-prefixed names
included), posts to `https://openrouter.ai/api/alpha/decisions`, and prints
`model`, `answers`, and `usage`. Exit code is non-zero when the request fails — a failed call is an
error, not an answer.

## Thresholds

- Noul: **≥ 0.70 = yes, ≤ 0.30 = no, between = unsettled**. The unsettled row is a real row in the
  truth table; decide it with code (usually the vector score or a narrower question).
- Score: read `probabilities` before trusting `score`. A two-peaked distribution is not a confident
  middle.
- Rerank keep: `combined >= min_relevance` (default 0.35 for `query`), where
  `combined = (0.45*direct + 0.25*symbols + 0.30*utility/4 - role_penalty)*0.70 + vector*0.30`.
- Faithfulness: `0.6*noul + 0.4*score/4`; faithful when `noul >= 0.5` and `score/4 >= 0.4`.

Adjust a threshold only with evidence from cases outside the tuning set, and record the change in
the catalog (`references/rag-decision-catalog.md`).

## Yellow flags

- Criteria that name specific test items or grow a clause per failing case.
- Caveats that explain away a model quirk.
- Thresholds fitted to a handful of examples.
- Tests that assert an exact probability (assert bands or ordering instead).
- Code that quietly overrides an answer instead of fixing the state or the question.

## When an answer looks wrong

Check in this order:

1. the payload actually sent (criteria present? shapes right?);
2. the state against the human test (would a person answer at a glance?);
3. the options and candidates (is the right answer among them?);
4. the scope of the question (split it further);
5. the wording.

If a clear question with complete state still gets a confidently wrong answer, check the TypeSafe
jaggedness page for known weak spots and work around them; do not paper over it with threshold
tweaks.

## Regression coverage in this repo

- `src/rag/src/decision.rs` unit tests: typed-answer parsing (current and legacy), mandatory
  criteria on all three question kinds, calibrated bands, UTF-8-safe truncation.
- `src/rag/tests/test_jev_decisions.py`: builder criteria, parsing, bands, route mapping, rerank
  weighting/role penalty, faithfulness mix, consumer-prefixed key resolution.
- Live smoke: `ainish-rag route`, `ainish-rag decide --questions`, `ainish-rag eval` must report
  `source: openrouter:typesafe/jev-1.14-…` when a key is resolvable.
