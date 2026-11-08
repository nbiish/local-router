/**
 * Live cache verification: with a prefix large enough to be cacheable, does a
 * repeat request bill cached tokens?
 *
 * Separate from verify-live-policy.mjs because it needs a deliberately LARGE
 * stable prefix: every provider publishes a minimum cacheable length (256 tokens
 * for Moonshot/Qwen, 1024 for Anthropic/OpenAI), so a short prompt always reports
 * cached=0 and proves nothing either way.
 *
 *   node scripts/verify-live-cache.mjs [model]
 */
const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';
const MODEL = process.argv[2] || process.env.LOCAL_ROUTER_TEST_MODEL || 'zenmux-deepseek-v4.1-flash';

// A long, byte-identical prefix well over every published minimum. The variable
// part is a single trailing question, so the cacheable region is stable.
const SYSTEM = [
  'You are a careful engineering assistant working on a TypeScript codebase.',
  'Follow these rules at all times:',
  ...Array.from({ length: 60 }, (_, i) =>
    `Rule ${i + 1}: Always verify a claim against the file itself before repeating it, and state the evidence.`
  )
].join('\n');

async function chat(question) {
  const res = await fetch(`${ROUTER}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: question }
      ]
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return {
    prompt: json.usage?.prompt_tokens ?? 0,
    cached: json.usage?.prompt_tokens_details?.cached_tokens ?? 0
  };
}

console.log(`router=${ROUTER}\nmodel=${MODEL}\nsystem chars=${SYSTEM.length}\n`);

const first = await chat('Question one: name the first rule.');
console.log(`call 1  prompt=${first.prompt}  cached=${first.cached}`);
const second = await chat('Question two: name the last rule.');
console.log(`call 2  prompt=${second.prompt}  cached=${second.cached}`);

if (second.cached > 0) {
  const pct = ((second.cached / Math.max(1, second.prompt)) * 100).toFixed(1);
  console.log(`\nPASS: ${second.cached} of ${second.prompt} prompt tokens (${pct}%) were served from cache.`);
} else {
  console.log(
    '\nNOTE: no cached_tokens on the repeat call. Either this upstream does not report them,\n' +
    'or the prefix stayed under its minimum. Try a model on a provider whose caching is\n' +
    'documented as observable (opencode-zen, moonshot, zai, zenmux).'
  );
}
