# Build 9.5.0 — Structure and maintainability

Build 9.5.0 adds no features. It changes how the code is organized so that a class of mistakes cannot recur: one
place applies the API's security checks, one place escapes HTML, one formatter decides layout, and the largest page
loads through one entry.

## What changed

### One route table, one security dispatcher
- Every API route is declared in a table and registered with `src/router.js`:
  `{ method: "POST", path: "/api/workouts", feature: "plus.train", handler }`. `handleApi` no longer passes each
  request through 15 modules; the request is matched once and dispatched.
- The dispatcher applies the checks the same way for every route, in this order: a trusted STRATA origin on every
  write; the session, the Strata+ feature, or the bound owner (`auth: "admin"`); the session's CSRF token on every
  signed-in write; and a JSON body (`form: true` also accepts the contact form posted without JavaScript).
- Every write gets all of them unless its route opts out by name: `public: true` (sign-up, sign-in, the emailed reset
  and deletion links, logout, and the contact form), `auth: "optional"` (product counts, which visitors and members
  both send; a member's still needs CSRF), or `webhook: true` (Paddle and Apple, which prove themselves by signature).
  `test/router.test.js` lists the 14 writes that run without a session, so adding one is a reviewed change, and it
  fails if a service checks CSRF or origin itself again.
- Handlers receive `{ req, res, url, params, session }` and keep only their own rules (rate limits, input checks).
  Unit tests serve a service's table through the real dispatcher with `test/support/route-harness.js`.

### One HTML escaper
- `public/scripts/html.js` (`StrataHtml`) holds the only `escape` function and an `html` tagged template that escapes
  every value put into it: `` html`<li>${name}</li>` ``. Markup that is already safe goes in through `raw()`.
- Every page loads it first, before `app-shell.js`. The 15 local `escapeHtml` copies are gone; modules receive
  `StrataHtml` the way they receive their other dependencies.
- `StrataHtml.setHtml`, `insertHtml`, and `replaceHtml` are the only writes to `innerHTML`, `insertAdjacentHTML`, and
  `outerHTML`; ESLint's `no-restricted-syntax` rejects any other write in `public/`. The 18 writes that only cleared an
  element use `textContent`, and 67 templates whose every value was already escaped use `html`.

### Formatting and size limits
- The code is formatted with Prettier (`printWidth` 100) in a commit with no other change. HTML pages, Markdown, and
  data files keep their bytes because tests and the release check match their text. `npm run check`, and so CI,
  starts with `prettier --check .`, and Prettier never reformats the inside of a template literal.
- ESLint `max-len` (140) keeps lines from growing back where Prettier cannot wrap; strings, templates, regexes, URLs,
  and JSDoc type tags are exempt. The reviewed `maxLines` budgets rose to fit the reformatted code.
- SQL that did not fit on one line is written one clause per line, with long lists and conditions wrapped and long
  subqueries nested; the 1,900-character admin queries in `src/schema.js` now read as a list of named counts. Only
  whitespace changed.

### Strata+ loads through one module entry
- `discover.html` had 38 script tags. It now has four: `html.js`, `app-shell.js`, and `motion.js` in `<head>`, which
  must run before the first paint, and `<script type="module" src="/discover-page.js">`. The entry's imports name the
  same 36 files in the same order, so each still finds the globals of the ones before it. There is no build step, and
  the Content-Security-Policy (`script-src 'self'`) already allowed it.
- The architecture check follows an entry's imports to verify the real load order and rejects an entry that holds
  anything but its imports. `discover-program.js` was missing from the offline cache and is added, because one missing
  import would stop the whole page offline. The other pages can move the same way.

## Upgrade notes

1. **Installed apps and returning browsers.** Every asset URL and the offline cache name advance to 9.5.0.
2. **Error codes.** API refusals use one code each: `403 ORIGIN_REQUIRED`, `403 INVALID_CSRF`, `415 JSON_REQUIRED`, and
   `405 METHOD_NOT_ALLOWED`. The module codes such as `WORKOUT_ORIGIN_REQUIRED` and `ADMIN_ORIGIN_REQUIRED` are
   retired; the admin, contact, and account pages handle the new ones. Anything outside STRATA that matched the old
   codes must match the new ones.
3. **Requests without an Origin.** Every write must carry a STRATA `Origin`, as browsers send for every non-GET request.
   A script that posted without one (for example to `/api/plan` or `/api/logout`) is now refused.
4. **No database or configuration changes.**
5. **After deploying:**
   `STRATA_SMOKE_BASE_URL=https://your-host STRATA_EXPECTED_BUILD=9.5.0 npm run smoke:deploy`.

## Validation

The format check, the Node suite with coverage floors, release markers, both architecture policies, strict types, lint,
runtime smokes, the performance budgets, the 100-account load checks (separate and shared addresses), and the browser
journeys pass. New tests cover the dispatcher's checks for every kind of route and the reviewed list of writes without
a session, `html.js` and the one-escaper rule, Prettier's settings, and Discover's module entry and its precache.
