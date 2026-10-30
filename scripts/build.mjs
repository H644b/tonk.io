import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { build } from "esbuild";
import { zipSync } from "fflate";
const exampleFiles={};
for(const file of ["client.js","bonk.mod.json","tonk.mod.json","assets/orb.svg"])exampleFiles[file]=fs.readFileSync("public/help/examples/orb-kit/"+file);
const compiledExample=await build({entryPoints:["public/help/examples/orb-kit/client.js"],bundle:true,platform:"browser",format:"esm",target:"es2022",write:false,legalComments:"none"});
exampleFiles[".build/client.js"]=compiledExample.outputFiles[0].contents;
exampleFiles[".build/prepared.json"]=Buffer.from(JSON.stringify({api:2,compiler:"esbuild"}));
const exampleArchive=zipSync(exampleFiles);
for(const extension of ["tonkmod","bonkmod"])fs.writeFileSync("public/help/examples/orb-kit-1.0.0."+extension,exampleArchive);
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
