import fs from "node:fs";
import type { EngineError } from "../types.ts";

/**
 * Forge catches exceptions from game actions, prints "== Report a crash ==" with the stack, and carries on. Such a game
 * may be in a corrupt state (a mana pool paid twice, a trigger dropped), so every one is recorded against its match.
 */
export function scanEngineErrors(logPath: string, gameEnds: number[]): EngineError[] {
  let text: string;
  try { text = fs.readFileSync(logPath, "utf8"); } catch { return []; }
  const out: EngineError[] = [];
  const re = /^== Report a crash ==\n(.*)\n((?:\s+at .*\n)*)/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const kind = m[1].trim().split(":")[0];
    const at = (m[2].split("\n").map((l) => l.trim()).find((l) => l.startsWith("at forge.")) ?? "").replace(/^at /, "");
    const game = gameEnds.findIndex((end) => m.index < end);
    out.push({ game: game < 0 ? gameEnds.length + 1 : game + 1, kind, at });
  }
  return out;
}
