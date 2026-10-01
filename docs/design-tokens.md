# Design tokens

`public/styles/tokens.css` is STRATA's one design system: palette, type, radius, spacing, and
motion. Every page loads it right after `fonts.css`, before any page stylesheet.
`test/design-tokens.test.js` keeps it that way.

## How pages use them

Page stylesheets keep their short local names (`--ink`, `--paper`, `--muted`) and point them at
the tokens, for example `--paper:var(--strata-paper)`. No other stylesheet defines a `--strata-*`
value, so changing a color, radius, or font happens in one place.

- **Paper (light pages):** home, planner, pricing and the policy pages, Profile and the account
  pages, install, admin. They render the shared light palette in `experience.css`, which reads
  the paper tokens.
- **Night (dark pages):** the Strata+ studio and `/ai` (`discover.css`, plus the studio palette on
  `body.plus-studio`), Train (`workout.css`), the offline workout, and setup (`onboarding.css`).
  A night palette that must win over the shared light palette sits on the page's `body`, not
  `:root`, because `experience.css` loads later.

## Tokens

| Group | Tokens |
|---|---|
| Brand | `--strata-ink` #10110f, `--strata-accent` #d4f578, `--strata-green-text` #4a6a10, `--strata-danger` #b3261e, `--strata-focus` #6f8e27 |
| Paper | `--strata-paper` #f3f4ef, `--strata-surface` #ffffff, `--strata-muted` #62675e, `--strata-line` #d2d6cc |
| Night | `--strata-night` #10110f, `--strata-night-panel` #191b17, `--strata-night-text` #f2f3eb |
| Type | `--strata-font` Manrope, `--strata-mono` DM Mono |
| Radius | control 8px, surface 14px, site 16px, card 22px, pill 999px |
| Spacing | 4, 8, 12, 16, 24, 32, 48, 64 px (`--strata-space-1` … `-8`) |
| Motion | `--strata-ease-out` cubic-bezier(.22,1,.36,1) |

## Build 9 changes

- Six page stylesheets carried their own copy of the light palette, and none of those copies
  applied: `experience.css` loads later on every one of their pages and replaced them. The dead
  copies are gone, and `experience.css` reads the tokens. Computed styles on 24 page states,
  signed out and as a Strata+ member, are identical before and after.
- Setup's night palette had the same problem: secondary text rendered in the light palette's
  grey (#62675e) on a near-black background, about 3.3:1 contrast. It now renders in its own
  #b2b9aa, about 10:1, with matching dark borders.

## Still to do

About 870 raw color values remain inside individual rules, most of them in the studio
(`discover.css`). Moving them onto tokens is parked as proposal 11 in `PROPOSALS.md`. The
computed-style fingerprint used for Build 9 (every element's colors, borders, fonts, radius,
and shadows, compared before and after) is the guard for that work.
