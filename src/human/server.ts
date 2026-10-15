/**
 * Pilot patch (mtg-rival): a web seat for a human player. The harness asks this server for each decision; the server
 * pushes it to the browser over SSE and resolves with the ids the player chose. One server per process (one human
 * seat per run). No dependencies: node:http, SSE for pushes, fetch POST for answers, Scryfall images proxied and cached
 * on disk so the page works offline after the first game.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CardDb, getCard } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";
import { info } from "../util/log.ts";

export interface HumanServerOpts { port: number; token?: string; cacheDir: string; db: CardDb; seatId: string; label?: string }

interface Pending { rid: string; req: DecisionRequest; resolve: (choice: string[] | null) => void; ctx: Record<string, unknown>; timer?: NodeJS.Timeout }

/** Game events the engine reports (forge.ts calls these hooks when a human seat is in the match). */
export const humanHooks: { gameStart?: (info: Record<string, unknown>) => void; gameEnd?: (info: Record<string, unknown>) => void; matchEnd?: (info: Record<string, unknown>) => void } = {};

const UI_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

export class HumanWebServer {
  readonly token: string;
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private pending: Pending | null = null;
  private lastEvent: { type: string; data: unknown } | null = null;
  private history: { type: string; data: unknown }[] = [];
  private imgQueue: Promise<void> = Promise.resolve();

  constructor(private opts: HumanServerOpts) {
    this.token = opts.token || crypto.randomBytes(12).toString("base64url");
    humanHooks.gameStart = (i) => this.broadcast("game", { event: "start", ...i });
    humanHooks.gameEnd = (i) => this.broadcast("game", { event: "end", ...i });
    humanHooks.matchEnd = (i) => this.broadcast("over", i);
  }

  get url() { return `http://localhost:${this.opts.port}/?t=${this.token}`; }

  async start(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.opts.port, resolve); });
    info(`human seat "${this.opts.seatId}": open ${this.url}`);
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.end();
    this.clients.clear();
    await new Promise<void>((r) => this.server ? this.server.close(() => r()) : r());
    this.server = undefined;
  }

  /** Ask the player; resolves with the chosen option ids (validated against min/max and ids before resolving). */
  /** Resolves null when timeoutMs passes without a valid answer (the seat then forfeits with the null action). */
  ask(req: DecisionRequest, ctx: Record<string, unknown>, timeoutMs?: number): Promise<string[] | null> {
    return new Promise<string[] | null>((resolve) => {
      const p: Pending = { rid: req.requestId, req, resolve, ctx: { ...ctx, ...(timeoutMs ? { timeoutMs, deadline: Date.now() + timeoutMs } : {}) } };
      this.pending = p;
      if (timeoutMs) p.timer = setTimeout(() => {
        if (this.pending !== p) return;
        this.pending = null;
        this.broadcast("waiting", { answered: p.rid, timedOut: true });
        resolve(null);
      }, timeoutMs);
      this.broadcast("decision", this.decisionPayload(p));
    });
  }

  private decisionPayload(p: Pending) {
    const { req } = p;
    const cards: Record<string, { manaCost: string; types: string; oracle: string; pt?: string }> = {};
    const visit = (v: unknown) => {
      if (typeof v === "string") { const c = getCard(this.opts.db, v); if (c && !cards[c.name]) cards[c.name] = { manaCost: c.manaCost, types: c.types, oracle: c.oracle, pt: (c as any).pt }; return; }
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "name" || k === "card" || k === "source" || k === "graveyard" || k === "exile" || k === "hand" || k === "cards") visit(x); else if (typeof x === "object") visit(x); }
    };
    visit(req.state);
    for (const o of req.options) if (o.card) visit(o.card);
    return { rid: p.rid, kind: req.kind, prompt: req.prompt, state: req.state, options: req.options.map((o) => ({ id: o.id, label: o.label, card: o.card, type: o.meta?.type })),
      min: req.min, max: req.max, cards, ...p.ctx };
  }

  private broadcast(type: string, data: unknown) {
    this.lastEvent = { type, data };
    if (type === "game" || type === "over") this.history.push({ type, data });
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const authed = url.searchParams.get("t") === this.token;
    if (url.pathname === "/img") return this.image(url.searchParams.get("name") ?? "", res);
    if (!authed) { res.statusCode = 403; res.end("forbidden"); return; }
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(fs.readFileSync(UI_FILE, "utf8"));
      return;
    }
    if (url.pathname === "/pending") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(this.pending ? this.decisionPayload(this.pending) : null));
      return;
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write(`event: hello\ndata: ${JSON.stringify({ seatId: this.opts.seatId, label: this.opts.label ?? "Humano" })}\n\n`);
      for (const h of this.history) res.write(`event: ${h.type}\ndata: ${JSON.stringify(h.data)}\n\n`);
      if (this.pending) res.write(`event: decision\ndata: ${JSON.stringify(this.decisionPayload(this.pending))}\n\n`);
      else if (this.lastEvent?.type === "over") { /* already sent via history */ }
      else res.write(`event: waiting\ndata: {}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 20000);
      req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }
    if (url.pathname === "/answer" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as { rid?: string; choice?: string[] };
      const p = this.pending;
      const fail = (msg: string) => { res.statusCode = 400; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: msg })); };
      if (!p || body.rid !== p.rid) return fail("esa decisión ya no está abierta");
      const err = validate(p.req, body.choice);
      if (err) return fail(err);
      this.pending = null;
      if (p.timer) clearTimeout(p.timer);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      this.broadcast("waiting", { answered: p.rid });
      p.resolve(body.choice!);
      return;
    }
    res.statusCode = 404; res.end("not found");
  }

  /** Scryfall image by exact name, cached on disk; requests are serialised with a pause to respect Scryfall's rate guidance. */
  private async image(name: string, res: http.ServerResponse) {
    const clean = name.replace(/\s*\(\d+\)$/, "").trim();
    if (!clean) { res.statusCode = 400; res.end(); return; }
    const file = path.join(this.opts.cacheDir, `${clean.replace(/[^A-Za-z0-9À-ÿ' ,.-]/g, "_")}.jpg`);
    if (!fs.existsSync(file)) {
      this.imgQueue = this.imgQueue.then(async () => {
        if (fs.existsSync(file)) return;
        try {
          const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(clean)}&format=image&version=normal`, { headers: { "user-agent": "mtg-rival-pilot/0.1", accept: "image/*" } });
          if (r.ok) fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
        } catch { /* offline: the page shows the text box */ }
        await new Promise((r) => setTimeout(r, 120));
      });
      await this.imgQueue;
    }
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=604800" });
    fs.createReadStream(file).pipe(res);
  }
}

function validate(req: DecisionRequest, choice: unknown): string | null {
  if (!Array.isArray(choice) || !choice.every((c) => typeof c === "string")) return "respuesta inválida";
  const ids = new Set(req.options.map((o) => o.id));
  const seen = new Set<string>();
  for (const c of choice as string[]) {
    if (!ids.has(c)) return `opción desconocida: ${c}`;
    if (seen.has(c)) return `opción repetida: ${c}`;
    seen.add(c);
  }
  if (choice.length < req.min || choice.length > req.max) return `elegí entre ${req.min} y ${req.max} opciones (elegiste ${choice.length})`;
  if (req.kind === "blockers") {
    const b = new Set<string>();
    for (const c of choice as string[]) { const k = c.split("->")[0]; if (b.has(k)) return "una criatura no puede bloquear a dos atacantes"; b.add(k); }
  }
  return null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e6) req.destroy(); }); req.on("end", () => resolve(s)); req.on("error", reject); });
}
