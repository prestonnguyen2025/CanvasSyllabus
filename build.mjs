import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

const options = {
  // Both pages share the Anthropic SDK and chat code through a split-out chunk.
  entryPoints: ["src/sidepanel.js", "src/app.js"],
  bundle: true,
  splitting: true,
  format: "esm",
  target: "chrome120",
  outdir: "dist",
  chunkNames: "chunks/[name]-[hash]",
  minify: true,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
