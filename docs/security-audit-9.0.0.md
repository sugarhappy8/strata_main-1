# Security audit — Build 9.0.0

Scope: everything Build 9 touched (navigation routes, the data layer, Polar, Strata AI on Groq,
the admin AI view) plus the standing controls those features rely on. Method: reading the
code paths below, the tests that pin them, a pattern scan of every tracked file, and `npm audit`.

## Result

No open findings block the release. One gap was fixed during the audit (HSTS). Three items are
deployment steps, because the build environment could not reach Groq or Polar.

| Area | Status |
|---|---|
| Secrets in the repository | None found |
| Third-party tokens at rest | Encrypted (AES-256-GCM), rotatable key |
| Webhook signatures | Paddle verified; Polar has no webhooks |
| Rate limits | On every write and every expensive read |
| Transport and headers | HSTS added for production |
| Dependencies | `npm audit`: 0 vulnerabilities (production and development) |
| Strata AI | Server-side only, consent first, no identifiers sent |

## Secrets

- A scan of every tracked text file for provider key formats (Groq `gsk_`, Paddle `pdl_`,
  Stripe-style `sk_live_`, AWS `AKIA`, GitHub `ghp_`, Slack tokens, PEM private keys) found
  nothing.
- `.env` and `.env.*` are ignored; only `.env.example` is tracked, and it holds empty
  placeholders.
- `render.yaml` marks every secret `sync: false`: `GROQ_API_KEY`, `PADDLE_API_KEY`,
  `PADDLE_WEBHOOK_SECRET`, `POLAR_CLIENT_SECRET`, `DEVICE_TOKEN_KEY`,
  `DEVICE_TOKEN_KEY_PREVIOUS`, and the database token.
- The Groq key is read only by `src/ai-provider.js`. No browser file references it, and the
  browser never calls Groq: chat and Daily Briefs run on the server.

## Tokens and passwords at rest

- **Polar credentials** are sealed in `src/devices-crypto.js` with AES-256-GCM: a 32-byte
  `DEVICE_TOKEN_KEY`, a random 12-byte IV per envelope, and a 16-byte authentication tag. Each
  envelope names the key that sealed it, so the key rotates by moving the old one to
  `DEVICE_TOKEN_KEY_PREVIOUS`. A rotated refresh token is sealed and saved before any data read.
  Disconnecting or deleting the account deletes the envelope and the imported rows.
- **Passwords** use scrypt (N = 16384, r = 8, p = 1, 64-byte key, per-account salt) and are
  compared with `timingSafeEqual`.
- **Sessions** are random tokens stored hashed; the cookie is `HttpOnly`, `SameSite=Strict`, and
  `Secure` in production.

## Requests

- Every mutation checks a trusted `Origin`, a per-session CSRF token, and a JSON content type,
  including the new `PUT /api/ai/settings` and `DELETE /api/ai/notes`.
- The new section routes (`/rankings`, `/my-week`, `/recovery`) only redirect to fixed,
  same-origin paths chosen on the server; nothing from the request is echoed into `Location`.
- Data routes check entitlements on the server: the Training Log, Daily Snapshots, and Strata AI
  need Strata+ (`requireFeature`); the owner's usage view needs the admin session.

## Webhook signatures

- **Paddle** (`src/paddle-webhooks.js`): the `Paddle-Signature` header's `ts` and `h1` values are
  checked with HMAC-SHA256 over `ts:rawBody`, compared in constant time, with a 5-second clock
  tolerance and several `h1` values accepted during secret rotation. Raw bodies are capped at
  256 KB.
- **Polar**: no webhook endpoint exists; sync is polling only. `POLAR_INTEGRATION.md` records
  that a future handler must verify Polar's signature and only mark the connection due.

## Rate limits

| Path | Limit |
|---|---|
| Sign-up and sign-in | Per network (400 per 15 min) and per email (hashed) |
| Email codes, password reset, account deletion | 5–30 per 15 min per account or network |
| Account export | 5 per 15 min per account |
| Weekly plan, workouts, training, coaching | 60–240 per minute per account |
| Polar connect / callback / reads / sync now | 10 / 30 per 15 min, 240 reads per minute, 5-minute sync cooldown |
| Strata AI | 12 writes and 240 reads per minute per member; 30 chats per member per day; 25 per minute and 900 per day for the organization |
| Strata AI settings | 30 changes per minute per member |
| Billing portal, admin actions, support | 10–30 per 15 min |
| Product signals | 60 per network and 5,000 overall per window |

## Transport and headers

Every response carries a Content-Security-Policy (self plus Paddle), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, a strict referrer policy, and a permissions policy that turns
off camera, microphone, and location.

**Fixed in this audit:** production responses now send `Strict-Transport-Security:
max-age=31536000` (PROPOSALS item 5). It leaves out `includeSubDomains`, so other hosts under the
domain are not forced onto HTTPS.

## Strata AI

- Nothing is sent to the provider until the member allows Strata AI; withdrawing stops it at once.
- The prompt carries compact training, sleep, and nutrition summaries, never the member's name,
  email, account id, payment details, or Polar tokens.
- Logs record the request kind, outcome code, duration, and token counts. An unexpected
  programming error logs its stack, which never contains the member's message.
- Model answers are validated by STRATA (schemas, catalog codes, calorie models) before anything
  is shown or saved.

## Deployment steps carried forward

1. Turn on Zero Data Retention in the Groq console before launch; the privacy policy says it
   is on.
2. Confirm both Groq models are listed (`GET https://api.groq.com/openai/v1/models`); the
   server logs `ai.models` at startup.
3. Validate Polar field units with a redacted fixture from a real, authorized account
   (`POLAR_INTEGRATION.md`, Known limits).
