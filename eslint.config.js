// Flat ESLint config. The `import/named` rule guards against importing names a
// local module doesn't actually export — a cheap catch for a whole class of bug.
import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/",
      "data/",
      "website/node_modules/",
      "website/.astro/",
      "website/dist/",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    plugins: { import: importPlugin },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "import/named": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Disable stylistic rules that conflict with Prettier.
  prettier,
];
