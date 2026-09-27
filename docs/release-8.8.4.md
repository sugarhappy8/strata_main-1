# Build 8.8.4 — Strata AI responses that apply correctly

Build 8.8.4 fixes the case where Atomic Chat understood a plan edit but placed the proposed workout inside `reply`, leaving STRATA unable to read or apply it. It also makes measurable follow-up edits reliable when a local model returns incomplete, malformed, or semantically wrong plan data.

## Atomic-compatible structured output

STRATA now sends Atomic Chat the llama.cpp schema dialect it enforces: `response_format.type` remains `json_object`, with the bounded schema in `response_format.schema`. The grammar requires the named response fields, structured exercise objects, valid shortlist codes, bounded sets and reps, and the exact target day count for recognized schedule edits. Providers that reject the schema fall back once to ordinary JSON mode and then to a plain request.

Correction instructions are sent as the final user turn, where Qwen follows them more reliably. Contracted edits omit stale conversation prose because the complete validated draft is already included as the editable base.

## Verified plan changes

Requests such as “I only want two rest days” produce exactly five training days on a balanced schedule. “Make sessions longer” keeps the same days and moves every session to the next 15-minute tier. Explicit targets and deltas such as “increase sessions to 75 minutes,” “increase by 30 minutes,” and “add 15 minutes to each session” are interpreted separately.

If the model still misses a pure day-count or duration requirement, STRATA builds the change from the validated draft and exercise shortlist, then runs it through the same catalog, plan, and contract checks as a model proposal. This fallback never runs for unsupported qualitative clauses. Equipment-only requests are checked against the exercise catalog, so an incompatible pinned exercise cannot leak into an “only dumbbells” proposal.

## Conversation behavior and safety

Ordinary questions remain reply-only, including questions about the unapplied week shown on screen. A question followed by an explicit instruction can still change the plan, while phrases such as “Can you explain how to make sessions longer?” remain informational.

Pain, injury, pregnancy, medication, eating-disorder, diagnosis, and medical-condition language is forced onto the reply-only safety path. Even if a weak model emits a workout for such a request, STRATA discards the proposal fields.

## Model and compatibility

The existing `AtomicChat/Qwen2_5-14B-Instruct-Q4_K_M` model remains suitable for an RTX 4070 Ti with 12 GB VRAM and 32 GB system memory. The failure was the response dialect and semantic enforcement rather than the model name or model size, so this release does not require a model change, database migration, or new environment variable.

Focused coverage includes the exact reply-only screenshot failure, malformed correction JSON, five-day/two-rest-day edits, longer sessions, explicit duration targets and deltas, equipment-only requests, compound day wording, question/request routing, medical reply-only enforcement, provider fallbacks, and deterministic fallback refusal for unvalidated requirements. The standard GitHub release gate runs the full suite, architecture checks, strict JavaScript type checking, lint, runtime QA, performance checks, and browser journeys.
