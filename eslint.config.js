// Flat config (ESLint 9). Lint backend Node code; browser JS has its own globals.
const js = require("@eslint/js");

module.exports = [
  { ignores: ["node_modules/**", "public/**", "data/**", "backups/**", "docs/**", ".worktrees/**", "vault/**", "*.html"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", process: "readonly", __dirname: "readonly", console: "readonly", Buffer: "readonly", setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly", clearInterval: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly", AbortController: "readonly", crypto: "readonly", structuredClone: "readonly" }
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_|^next$", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-undef": "error"
    }
  }
];
