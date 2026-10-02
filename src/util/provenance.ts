/**
 * What produced a run: harness commit, Forge commit or jar, bridge jar hash and the card-data and rankings hashes.
 * Recorded in config.json and the run_start event, and shown in report.md, so results can be tied to versions.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_DB_PATH } from "../cards/db.ts";
import { rankingsFile } from "../cards/cube.ts";
import type { BenchConfig } from "../config.ts";
import { resolveForge } from "../engine/forge/forge.ts";

export interface Provenance {
  harness: { commit?: string; dirty?: boolean };   // dirty: tracked files differ from the commit
  engine: string;
  forge?: { commit?: string; jar?: string; bridgeJarSha256?: string };
  cardsJsonSha256?: string;
  rankings?: { file: string; sha256?: string };
}

const sha256 = (f?: string) => (f && fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : undefined);

/** `git -C dir ...`, or undefined when git fails. */
function git(dir: string, ...args: string[]): string | undefined {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return undefined; }
}

/** HEAD of the repo whose top level is `dir` (not of some repo that merely contains it). */
function commitOf(dir: string): string | undefined {
  const top = git(dir, "rev-parse", "--show-toplevel");
  return top && fs.realpathSync(top) === fs.realpathSync(dir) ? git(dir, "rev-parse", "HEAD") : undefined;
}

export function collectProvenance(cfg: BenchConfig, engine: string): Provenance {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const commit = commitOf(root);
  const p: Provenance = {
    harness: { commit, dirty: commit ? git(root, "status", "--porcelain", "--untracked-files=no") !== "" : undefined },
    engine, cardsJsonSha256: sha256(DEFAULT_DB_PATH),
  };
  const rankings = rankingsFile(cfg.forgeRes);
  if (rankings) p.rankings = { file: rankings, sha256: sha256(rankings) };
  if (engine === "forge" && cfg.engine.forgeDir && fs.existsSync(cfg.engine.forgeDir)) {
    const { forgeDir, forgeJar, bridgeJar } = resolveForge(cfg.engine);
    p.forge = { commit: commitOf(forgeDir), jar: forgeJar && path.basename(forgeJar), bridgeJarSha256: sha256(bridgeJar) };
  }
  return p;
}

/** One line for report.md. */
export function describeProvenance(p: Provenance): string {
  const short = (h?: string) => (h ? h.slice(0, 12) : "unknown");
  const parts = [`harness ${short(p.harness.commit)}${p.harness.dirty ? " (uncommitted changes)" : ""}`, `engine ${p.engine}`];
  if (p.forge) parts.push(`Forge ${p.forge.commit ? short(p.forge.commit) : p.forge.jar ?? "unknown"}`, `bridge jar ${short(p.forge.bridgeJarSha256)}`);
  parts.push(`cards.json ${short(p.cardsJsonSha256)}`, `rankings ${p.rankings ? `${path.basename(p.rankings.file)} ${short(p.rankings.sha256)}` : "none"}`);
  return parts.join(" · ");
}
