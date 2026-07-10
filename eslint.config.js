// Flat config (ESLint 9). Lint backend Node code; browser JS has its own globals.
const js = require("@eslint/js");

// Node runtime globals shared by CommonJS (.js) and ESM (.mjs) backend code.
const nodeGlobals = {
  process: "readonly", console: "readonly", Buffer: "readonly",
  setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly", clearInterval: "readonly",
  URL: "readonly", URLSearchParams: "readonly", fetch: "readonly",
  AbortController: "readonly", crypto: "readonly", structuredClone: "readonly"
};

// Cosmetic issues warn (matching no-unused-vars/no-empty); correctness (no-undef) errors.
const rules = {
  "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^next$", varsIgnorePattern: "^_" }],
  "no-empty": ["warn", { allowEmptyCatch: true }],
  "no-useless-escape": "warn",
  "no-undef": "error"
};

module.exports = [
  { ignores: ["node_modules/**", "public/**", "data/**", "backups/**", "docs/**", ".worktrees/**", "vault/**", "*.html"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", __dirname: "readonly", __filename: "readonly", ...nodeGlobals }
    },
    rules
  },
  {
    // ESM scripts (smoke.mjs, backfill-*.mjs): module scope, no CJS require/module/__dirname.
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: nodeGlobals
    },
    rules
  }
];
