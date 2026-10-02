import js from "@eslint/js";
import globals from "globals";

const correctnessRules = {
  "array-callback-return": "error",
  "default-case-last": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-constant-binary-expression": "error",
  // Control-character regexes are deliberate input sanitizers in this codebase.
  "no-control-regex": "off",
  "no-duplicate-imports": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
  // Shorthand timer executors return ignored timer IDs, which is safe here.
  "no-promise-executor-return": "off",
  "no-self-compare": "error",
  "no-template-curly-in-string": "error",
  "no-unmodified-loop-condition": "error",
  "no-unreachable-loop": "error",
  // ESLint 10 flags harmless sentinel initialization before guarded assignment.
  "no-useless-assignment": "off",
  "no-useless-call": "error",
  "no-useless-concat": "error",
  "no-useless-return": "error",
};

// Prettier wraps code at 100 columns; this ceiling keeps lines from growing back where Prettier cannot
// wrap. Strings, templates, regexes, URLs, and JSDoc type tags are exempt because breaking them would
// change their meaning or make them harder to read.
const layoutRules = {
  "max-len": [
    "error",
    {
      code: 140,
      ignoreUrls: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreRegExpLiterals: true,
      ignorePattern: String.raw`^\s*(?:/\*\*|\*)\s*@(?:param|returns?|type|typedef|template|property|callback)\b`,
    },
  ],
};

// Markup reaches the page only through public/scripts/html.js, which escapes what goes into it.
const htmlSinkRules = {
  "no-restricted-syntax": [
    "error",
    {
      selector:
        "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
      message:
        "Use StrataHtml.setHtml or StrataHtml.replaceHtml (public/scripts/html.js), or textContent.",
    },
    {
      selector: "CallExpression > MemberExpression.callee[property.name='insertAdjacentHTML']",
      message: "Use StrataHtml.insertHtml (public/scripts/html.js).",
    },
  ],
};

export default [
  {
    ignores: ["node_modules/**", "coverage/**", "data/**", "test-runtime/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: "latest" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: { ...correctnessRules, ...layoutRules },
  },
  {
    files: ["server.js", "src/**/*.js", "scripts/**/*.js", "test/**/*.js", "qa/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["qa/ui-audit.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["public/scripts/**/*.js"],
    languageOptions: {
      sourceType: "script",
      // html.js loads first on every page.
      globals: { ...globals.browser, StrataHtml: "readonly" },
    },
  },
  {
    files: ["public/**/*.js"],
    ignores: ["public/scripts/html.js"],
    rules: htmlSinkRules,
  },
  {
    files: [
      "public/scripts/discovery-core.js",
      "public/scripts/monthly-plan-core.js",
      "public/scripts/workout-core.js",
      "public/scripts/onboarding-core.js",
      "public/scripts/preview-core.js",
      "public/scripts/activation-core.js",
      "public/scripts/plan-insights-core.js",
    ],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ["public/service-worker.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.serviceworker },
    },
  },
];
