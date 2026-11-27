// Bundles the action into a single ESM file at dist/index.js.
// GitHub runs that file directly, so dist/ is committed to the repository.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "external",
  logLevel: "info",
  // Some transitive dependencies are CommonJS and call require() on Node
  // built-ins; give the ESM bundle a real require so those calls work.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
});
