import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";
await build({
  entryPoints: ["client/modding/runtime.ts", "client/modding/workbench.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  format: "iife",
  outdir: "public/modding",
  sourcemap: true,
});
execFileSync(process.execPath, ["scripts/prepare.mjs"], { stdio: "inherit" });
for (const file of fs
  .readdirSync("public/enhancements")
  .filter((x) => x.endsWith(".js")))
  execFileSync(process.execPath, ["--check", "public/enhancements/" + file], {
    stdio: "inherit",
  });
await build({
  entryPoints: { server: "server/index.ts", mods: "scripts/mods.mjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "external",
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  sourcemap: true,
});
console.log(
  "Built dist/server.mjs. Run from the project root with node dist/server.mjs.",
);
