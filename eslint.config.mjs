import js from "@eslint/js";
import globals from "globals";

const correctnessRules={
  "array-callback-return":"error",
  "default-case-last":"error",
  eqeqeq:["error","always",{null:"ignore"}],
  "no-constant-binary-expression":"error",
  // Control-character regexes are deliberate input sanitizers in this codebase.
  "no-control-regex":"off",
  "no-duplicate-imports":"error",
  "no-empty":["error",{allowEmptyCatch:true}],
  // Shorthand timer executors return ignored timer IDs, which is safe here.
  "no-promise-executor-return":"off",
  "no-self-compare":"error",
  "no-template-curly-in-string":"error",
  "no-unmodified-loop-condition":"error",
  "no-unreachable-loop":"error",
  // ESLint 10 flags harmless sentinel initialization before guarded assignment.
  "no-useless-assignment":"off",
  "no-useless-call":"error",
  "no-useless-concat":"error",
  "no-useless-return":"error"
};

export default [
  {
    ignores:["node_modules/**","coverage/**","data/**","test-runtime/**"]
  },
  js.configs.recommended,
  {
    files:["**/*.js","**/*.mjs"],
    languageOptions:{ecmaVersion:"latest"},
    linterOptions:{reportUnusedDisableDirectives:"error"},
    rules:correctnessRules
  },
  {
    files:["server.js","src/**/*.js","scripts/**/*.js","test/**/*.js","qa/**/*.js"],
    languageOptions:{
      sourceType:"commonjs",
      globals:{...globals.node}
    }
  },
  {
    files:["qa/ui-audit.js"],
    languageOptions:{globals:{...globals.node,...globals.browser}}
  },
  {
    files:["public/scripts/**/*.js"],
    languageOptions:{
      sourceType:"script",
      globals:{...globals.browser}
    }
  },
  {
    files:["public/scripts/discovery-core.js","public/scripts/monthly-plan-core.js","public/scripts/workout-core.js","public/scripts/onboarding-core.js","public/scripts/preview-core.js","public/scripts/activation-core.js","public/scripts/plan-insights-core.js"],
    languageOptions:{globals:{...globals.browser,...globals.node}}
  },
  {
    files:["public/service-worker.js"],
    languageOptions:{
      sourceType:"script",
      globals:{...globals.serviceworker}
    }
  }
];
