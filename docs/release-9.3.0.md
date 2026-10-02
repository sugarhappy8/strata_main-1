# Build 9.3.0 — Sign in with Google

Build 9.3.0 adds Google as a way to create an account and sign in, next to email and password. Nothing changes for
existing members until the Google settings are present.

## What changed

### Sign in with Google
- Profile shows **Continue with Google** in both the Create account and Sign in panels once
  `GOOGLE_SIGN_IN_CLIENT_ID` and `GOOGLE_SIGN_IN_CLIENT_SECRET` are set.
- STRATA uses Google's OpenID Connect authorization-code flow with PKCE and a nonce. The sign-in is bound to the browser
  that started it, finishes once, and accepts Google's ID token only after checking its signature against Google's
  published keys, its issuer, audience, expiry, and nonce.
- A Google account signs in to the STRATA account it is linked to. Otherwise it links to an existing account only when
  both Google and STRATA have verified the same email, or it creates a new, already verified account.
- Accounts made with Google have no STRATA password. Password sign-in does not open them; Profile offers
  *Email a link to set a password*.

### iOS app
- Google refuses sign-in inside embedded web views, so the app keeps email sign-in only. Its sign-in panel tells members
  who signed up with Google on the website to use *Forgot password?* to set a password. Because the app offers no
  third-party sign-in, Sign in with Apple is not required (App Review Guideline 4.8).
- In the app, an account without a password deletes with DELETE alone within 15 minutes of signing in.

### Privacy and data
- STRATA stores Google's account identifier for the member, the email Google shared, and when it was linked and last
  used. The account export lists the linked sign-in without the identifier; deleting the account removes it.
- The privacy policy describes what Google shares. The Content-Security-Policy's `form-action` allows
  `https://accounts.google.com`.

### Fixes
- The Google logo carries its own size, so a stale cached stylesheet can no longer stretch it across the button.
- A Strata AI server test no longer races a slow signup against its 400 ms busy-queue window.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.3.0.
2. **Google settings (optional).** Create a *Web application* OAuth client in Google Cloud with the redirect URI
   `https://stratafitness.online/auth/social/google/callback`, publish the consent screen, and set
   `GOOGLE_SIGN_IN_CLIENT_ID` and `GOOGLE_SIGN_IN_CLIENT_SECRET`. See
   [Sign in with Google](deployment.md#sign-in-with-google). The new tables are created when the server starts.
3. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.3.0 npm run smoke:deploy`, then confirm
   `/api/status` lists `google` in `signInProviders` and create an account with Google.

## Validation

The Node suite with coverage floors, release markers, architecture policy, strict types, lint, runtime smokes, the
performance budgets, the 100-account load checks, and the browser journeys pass, including an end-to-end sign-in test
against a local Google stand-in and a real-browser check that the button reaches Google's sign-in page.
