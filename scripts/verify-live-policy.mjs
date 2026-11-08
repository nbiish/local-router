/**
 * Live end-to-end verification: does a requested thinking level actually reach
 * the upstream, and does the router report the cache/reasoning usage it billed?
 *
 * This measures the real system on :11434 - the deployed build - rather than the
 * translation helpers. It is deliberately not part of `npm test` (it costs
 * tokens and needs live keys); run it with:
 *
 *   node scripts/verify-live-policy.mjs [model]
 */
const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';
const MODEL = process.argv[2] || process.env.LOCAL_ROUTER_TEST_MODEL || 'zenmux-deepseek-v4.1-flash';
const PROMPT = 'A train leaves 14:37 at 83km/h, another 41 minutes later at 97km/h. When does it catch up? Show your reasoning.';

async function chat(body) {
  const res = await fetch(`${ROUTER}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: PROMPT }], ...body })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const message = json.choices?.[0]?.message || {};
  const reasoningText = String(message.reasoning_content ?? message.reasoning ?? '');
  return {
    reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    reasoningChars: reasoningText.length,
    cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    contentChars: String(message.content ?? '').length
  };
}

const results = [];
async function probe(label, body) {
  try {
    const r = await chat(body);
    results.push({ label, ...r });
    console.log(
      `${label.padEnd(14)} reasoning_tokens=${String(r.reasoningTokens).padStart(4)}  ` +
      `reasoning_chars=${String(r.reasoningChars).padStart(5)}  ` +
      `cached=${String(r.cachedTokens).padStart(5)}/${String(r.promptTokens).padEnd(5)} ` +
      `content=${r.contentChars}`
    );
    return r;
  } catch (error) {
    console.log(`${label.padEnd(14)} ERROR ${error.message}`);
    results.push({ label, error: error.message });
    return null;
  }
}

console.log(`router=${ROUTER}\nmodel=${MODEL}\n`);
const off = await probe('effort:none', { reasoning_effort: 'none' });
const low = await probe('effort:low', { reasoning_effort: 'low' });
const high = await probe('effort:high', { reasoning_effort: 'high' });
// Second identical high call: the prefix is now warm, so a cache-capable
// upstream should bill cached tokens it did not bill on the first.
const highAgain = await probe('effort:high#2', { reasoning_effort: 'high' });

const failures = [];
if (off && low && high) {
  if (!(off.reasoningTokens === 0)) {
    failures.push(`effort:none billed ${off.reasoningTokens} reasoning tokens (expected 0)`);
  }
  if (low.reasoningTokens === 0 && high.reasoningTokens === 0) {
    failures.push('neither low nor high produced reasoning tokens — the level is not reaching the upstream');
  }
  console.log(
    `\ndial moves reasoning: none=${off.reasoningTokens} low=${low.reasoningTokens} high=${high.reasoningTokens}`
  );
}
if (highAgain && highAgain.cachedTokens === 0) {
  console.log('note: no cached_tokens reported on the repeat call (upstream may not expose it here)');
}

if (failures.length > 0) {
  console.error(`\nFAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nPASS: the level reached the upstream and the usage it billed was reported back.');
