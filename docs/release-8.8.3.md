# Build 8.8.3 — Reliable Strata AI plan edits

Build 8.8.3 makes follow-up changes act on the week the member is viewing and verifies that the accepted proposal actually matches the request.

## Structured edit context

The AI page sends the latest unapplied proposal as a bounded structured plan. The server validates every exercise, set, day, and rest-day field before using that draft, then describes the complete editable week with the exercise codes for the current request. Large five- and six-day proposals no longer depend on a 1,200-character prose recap that can cut off later days or the rest-day list.

The saved plan remains the fallback when there is no unapplied proposal. Draft context is used only to prepare an answer; it is not stored in the database and never changes the account by itself.

## Verifiable natural-language changes

STRATA now converts common schedule wording into a server-owned edit contract:

- “I only want two rest days” requires exactly five nonempty training days and two rest days.
- Explicit training-day counts and add/remove/fewer/more day requests are checked against the current week.
- An explicit session duration is checked on every training day using STRATA's set-based time estimate.
- “Make sessions longer” and “make sessions shorter” use the next or previous 15-minute tier while keeping the same training days.

The model still handles the member's broader wording and programming choices. STRATA checks the measurable parts it can derive. If the first answer contradicts them, the server sends one correction naming the exact mismatch. A second mismatch fails clearly instead of presenting a confident reply beside the wrong plan.

## Conversation and plan safety

Questions such as “Should I make sessions longer?” and “How can I add another training day?” stay informational; proposal fields are discarded even if the model includes them. A valid proposal with a missing model-written reply receives a short server fallback instead of failing after the expensive generation completed.

The working-set ceiling now permits the documented 90-minute target. Applying a proposal also uses the plan revision captured when the answer was generated, so a stale AI card cannot overwrite changes made in another tab or device.

## Compatibility and validation

The change is model-independent and requires no database migration or new environment variable. Existing OpenAI-compatible Atomic Chat, llama.cpp, and Ollama deployments continue to use the same endpoint and JSON response mode.

Focused tests cover structured draft validation, exact rest and training counts, relative day changes, explicit and relative session lengths, per-day duration checks, semantic correction, failure after two incorrect answers, question-only behavior, and stale-revision comparison. The complete release gate, architecture policy, type checking, lint, browser journeys, and 100-account load checks run in GitHub Actions.
