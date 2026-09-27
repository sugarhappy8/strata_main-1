# Build 8.8.2 — Conversational Strata AI

Build 8.8.2 lets Strata AI answer ordinary training and nutrition questions without turning them into account-change proposals.

## Questions and requests stay distinct

- Questions about training concepts, exercises, recovery, calories, macros, or food receive a direct plain-text answer. Strata AI can use the member's saved context when it is relevant and can ask one concise follow-up question when a required detail is missing.
- A question such as “Should I train each muscle twice a week?” is not permission to build or replace a week. `week` remains empty unless the member clearly asks for a new or changed training plan.
- Informational food, calorie, and macro questions do not create nutrition settings. `nutrition` is populated only when the member asks to create or change targets or accepts an earlier offer.
- Suggestions and exercise swaps remain limited to an explicit plan-review or improvement request.
- Unrelated questions receive a short explanation of the training and nutrition topics Strata AI can help with.

Direct answers may use up to 90 words. Replies that accompany a proposal remain capped at 60 words, and the complete response keeps the 900-token limit from 8.8.1.

## Page changes

The Strata AI page now presents questions and planning together. Its empty state and composer invite either one, the starter list includes a progressive-overload question, and the waiting state says that Strata AI is preparing an answer rather than always planning.

## Safety and data behavior

All existing boundaries remain in place. The model still returns one JSON object, question replies are sanitized as plain text, and the server discards proposal fields from clear informational questions even if the model returns them. Plan and nutrition fields for explicit requests still pass through STRATA's validators, and nothing is saved until the member applies a validated proposal. The model receives the same account-private summary described in the privacy policy; this release adds no stored data and requires no database migration.

## Validation

Unit coverage verifies the question-specific prompt and reply-only result. The HTTP integration suite sends an ordinary question through the real queue and confirms that the result contains no week, nutrition change, or suggestions. A live check against Atomic Chat with Qwen2.5-14B-Instruct returned parsed reply-only JSON with every proposal field empty. Release, architecture, type, and lint checks pass; GitHub Actions runs the complete Linux release gate.
