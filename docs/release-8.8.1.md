# Build 8.8 — Faster Strata AI answers

Build 8.8.1 makes Strata AI answers shorter to generate and easier to diagnose. It follows the first live test of 8.8.0, where a community-merged local model looped on one phrase for 1,100 tokens (about 25 seconds), was retried once, and then showed "Strata AI's answer could not be read".

## Shorter answers

| Before | Build 8.8.1 |
| --- | --- |
| Each exercise was an object: `{"code":"CH1","sets":3,"reps":"8-12"}` | Each exercise is `["CH1",3,"8-12"]`, or an exact library name in place of the code. A four-day week of six exercises a day drops from 1,173 to 649 characters, 45% shorter. The object form is still accepted |
| Replies could run to 90 words | Replies are capped at 60 words |
| Each answer could use 1,100 tokens | Each answer is capped at 900 tokens, which still fits a six-day week, so a model that loops stops sooner |

STRATA's checks are unchanged: every exercise, set, and day is validated before a proposal appears, and calories still come from STRATA's calculator.

## Clearer waiting and diagnosis

- While Strata AI works, the page shows the seconds elapsed and the usual 10–30 second range, then a longer-wait message after 45 seconds.
- When a model's answer cannot be read, the server logs `ai.unreadable_answer` with the answer's length, whether it was cut off, and whether it started as JSON. Messages and answers are still never logged.

## Choosing a model

The [deployment guide](deployment.md#strata-ai) now recommends official instruction-tuned models that ship with their chat template. On a 12 GB GPU, Qwen2.5-14B-Instruct at Q4_K_M fits with a 16,384-token context; Qwen2.5-7B-Instruct answers about twice as fast. Community merges and upscaled models can loop without producing JSON, and thinking models can spend the answer budget on reasoning unless the server honors `enable_thinking: false`. After changing models, set `AI_MODEL` to the exact ID the server lists.

## Data and release behavior

No database migration, API change, or stored-data format change is required. The public build and asset versions are `8.8.1`, which refreshes the versioned service-worker cache.

## Validation

- `npm run release:check`, `npm run architecture:check`, `npm run typecheck`, and `npm run lint` pass.
- The Node suite passes 1,026 of 1,026 tests, and `npm run coverage` meets its floors at 95.47% lines, 84.35% branches, and 92.06% functions. New cases cover the compact exercise form, including exact names, unknown codes, malformed entries, and repeats, and the elapsed-time messages.
- `npm run qa:runtime` and `npm run performance` pass, and the Strata AI browser journey now drives the compact form end to end.
