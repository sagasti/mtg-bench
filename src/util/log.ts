import fs from "node:fs";
import path from "node:path";

/** Append-only JSONL writer. One per stream (decisions, usage, games, ...). */
export class Jsonl {
  private fd: number;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, "a");
  }
  write(obj: unknown) { fs.writeSync(this.fd, JSON.stringify(obj) + "\n"); }
  close() { try { fs.closeSync(this.fd); } catch { /* already closed */ } }
}

export function readJsonl<T = any>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let verbose = process.env.BENCH_VERBOSE === "1";
export function setVerbose(v: boolean) { verbose = v; }
export function info(...a: unknown[]) { console.log(new Date().toISOString().slice(11, 19), ...a); }
export function debug(...a: unknown[]) { if (verbose) console.log(new Date().toISOString().slice(11, 19), "[debug]", ...a); }

/** Minimal .env loader (KEY=value lines); does not override existing env vars. */
export function loadDotEnv(file = ".env") {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
