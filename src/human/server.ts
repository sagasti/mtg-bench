/**
 * Pilot patch (mtg-rival): a web seat for a human player. The harness asks this server for each decision; the server
 * pushes it to the browser over SSE and resolves with the ids the player chose. One server per process (one human
 * seat per run). No dependencies: node:http, SSE for pushes (/poll, a long poll with the same events, for clients
 * behind a proxy that holds streams back), fetch POST for answers, Scryfall images proxied and cached on disk so the
 * page works offline after the first game.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CardDb, getCard } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";
import { info } from "../util/log.ts";

export interface HumanServerOpts { port: number; token?: string; cacheDir: string; db: CardDb; seatId: string; label?: string;
  /** Analysis mode: the player is also shown the other seat's hand, as that seat saw it at its latest decision. */
  peek?: boolean }

interface Pending { rid: string; req: DecisionRequest; resolve: (choice: string[] | null) => void; ctx: Record<string, unknown>; timer?: NodeJS.Timeout }

type CardInfo = Record<string, { manaCost: string; types: string; oracle: string; pt?: string }>;

/** Game events the engine reports (forge.ts calls these hooks when a human seat is in the match). */
export const humanHooks: { gameStart?: (info: Record<string, unknown>) => void; gameEnd?: (info: Record<string, unknown>) => void; matchEnd?: (info: Record<string, unknown>) => void;
  /** The state the other seat was just asked to decide on (its own view, so its hand is in it). Set in analysis mode only. */
  opponentView?: (info: { state: any }) => void } = {};

const UI_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui.html");

export class HumanWebServer {
  readonly token: string;
  private server?: http.Server;
  private clients = new Set<http.ServerResponse>();
  private pending: Pending | null = null;
  private lastEvent: { type: string; data: unknown } | null = null;
  private history: { type: string; data: unknown }[] = [];
  /** The last events, numbered, for /poll clients; and the polls waiting for the next one. */
  private seq = 0;
  private recent: { seq: number; type: string; data: unknown }[] = [];
  private waiters = new Set<() => void>();
  /** When a /poll request last came in, and the newest seq a /poll answer has carried (stop() lets the tail be collected). */
  private lastPollAt = 0;
  private polledSeq = 0;
  private imgQueue: Promise<void> = Promise.resolve();
  /** Analysis mode (opts.peek): the other seat's hand at its latest decision this game, and what it was built from (repeats are skipped). */
  private peekData: { hand: unknown[]; turn?: number; phase?: string; cards: CardInfo } | null = null;
  private peekKey = "";

  constructor(private opts: HumanServerOpts) {
    this.token = opts.token || crypto.randomBytes(12).toString("base64url");
    humanHooks.gameStart = (i) => { this.peekData = null; this.peekKey = ""; this.broadcast("game", { event: "start", ...i }); };
    humanHooks.gameEnd = (i) => this.broadcast("game", { event: "end", ...i });
    humanHooks.matchEnd = (i) => this.broadcast("over", i);
    // Off unless the run asked for it: without the hook the other seat's states never reach this server.
    humanHooks.opponentView = opts.peek ? (i) => this.peek(i.state) : undefined;
  }

  get url() { return `http://localhost:${this.opts.port}/?t=${this.token}`; }

  async start(): Promise<void> {
    if (this.server) return;
    fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }));
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.opts.port, resolve); });
    info(`human seat "${this.opts.seatId}": open ${this.url}`);
    if (this.opts.peek) info(`human seat "${this.opts.seatId}": analysis mode, this player is shown the other seat's hand`);
  }

  async stop(): Promise<void> {
    // The result of the match is the last thing said, and a polling client is between two requests most of the time
    // (a stream client already has it): give it a few seconds to come back for the tail before the server goes away.
    const giveUp = Date.now() + 8000;
    while (this.polledSeq < this.seq && this.lastPollAt > Date.now() - 40000 && Date.now() < giveUp) await new Promise((r) => setTimeout(r, 100));
    for (const c of this.clients) c.end();
    this.clients.clear();
    for (const w of [...this.waiters]) w();
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

  /** Oracle data of every card named in these values (a state, option cards, a hand), for the page's tooltips and text boxes. */
  private cardInfo(...roots: unknown[]): CardInfo {
    const cards: CardInfo = {};
    const visit = (v: unknown) => {
      if (typeof v === "string") { const c = getCard(this.opts.db, v); if (c && !cards[c.name]) cards[c.name] = { manaCost: c.manaCost, types: c.types, oracle: c.oracle, pt: (c as any).pt }; return; }
      if (Array.isArray(v)) { for (const x of v) visit(x); return; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "name" || k === "card" || k === "source" || k === "graveyard" || k === "exile" || k === "hand" || k === "cards") visit(x); else if (typeof x === "object") visit(x); }
    };
    for (const r of roots) visit(r);
    return cards;
  }

  private decisionPayload(p: Pending) {
    const { req } = p;
    const cards = this.cardInfo(req.state, req.options.map((o) => o.card));
    return { rid: p.rid, kind: req.kind, prompt: req.prompt, state: req.state, options: req.options.map((o) => ({ id: o.id, label: o.label, card: o.card, type: o.meta?.type, doubt: o.meta?.doubtful })),
      min: req.min, max: req.max, cards, ...p.ctx };
  }

  /**
   * Analysis mode: the other seat was just asked to decide, and this is the hand it is looking at. Only the hand goes to
   * the page (the rest of that state is on the table already), as a copy: nothing here touches what that seat is given.
   */
  private peek(state: any) {
    try {
      if (!Array.isArray(state?.you?.hand)) return;
      const hand = JSON.stringify(state.you.hand), key = `${state.turn}|${state.phase}|${hand}`;
      if (key === this.peekKey) return; // several decisions in a row on the same hand
      this.peekKey = key;
      this.peekData = { hand: JSON.parse(hand), turn: state.turn, phase: state.phase, cards: this.cardInfo(state.you.hand) };
      this.broadcast("peek", this.peekData);
    } catch (e: any) {
      info(`human seat "${this.opts.seatId}": analysis view skipped (${e?.message ?? e})`); // a side view never breaks a decision
    }
  }

  private broadcast(type: string, data: unknown) {
    if (type !== "peek") this.lastEvent = { type, data }; // a peek is a side note: it never says where the table stands
    if (type === "game" || type === "over") this.history.push({ type, data });
    this.recent.push({ seq: ++this.seq, type, data });
    if (this.recent.length > 100) this.recent.shift();
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) c.write(msg);
    for (const w of [...this.waiters]) w();
  }

  /** Where things stand for a client that just connected: who it is, the games so far, and the open decision if any. */
  private snapshot(): { type: string; data: unknown }[] {
    const out: { type: string; data: unknown }[] = [{ type: "hello", data: { seatId: this.opts.seatId, label: this.opts.label ?? "Humano", ...(this.opts.peek ? { peek: true } : {}) } }, ...this.history];
    if (this.peekData) out.push({ type: "peek", data: this.peekData }); // after the history: a game start clears the page's peek
    if (this.pending) out.push({ type: "decision", data: this.decisionPayload(this.pending) });
    else if (this.lastEvent?.type !== "over") out.push({ type: "waiting", data: {} }); // "over" is already in the history
    return out;
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
      for (const e of this.snapshot()) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      this.clients.add(res);
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 20000);
      req.on("close", () => { clearInterval(ping); this.clients.delete(res); });
      return;
    }
    if (url.pathname === "/poll") {
      // The events of /events as a long poll, for clients behind a proxy that holds a stream back until it ends (a
      // Cloudflare quick tunnel does): ?since=<seq of the last answer> → { seq, events } as soon as there is one, or
      // an empty list after 25 s. Without since (or too far behind to catch up): where things stand now.
      const since = Number(url.searchParams.get("since") ?? "-1");
      this.lastPollAt = Date.now();
      const send = (events: { type: string; data: unknown }[]) => { this.polledSeq = this.seq; res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ seq: this.seq, events })); };
      const oldest = this.recent.length ? this.recent[0].seq : this.seq + 1;
      if (!(since >= 0) || since > this.seq || since < oldest - 1) { send(this.snapshot()); return; }
      const fresh = () => this.recent.filter((e) => e.seq > since).map(({ type, data }) => ({ type, data }));
      if (since < this.seq) { send(fresh()); return; }
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); if (!res.writableEnded) send(fresh()); };
      const timer = setTimeout(wake, 25000);
      this.waiters.add(wake);
      req.on("close", () => { clearTimeout(timer); this.waiters.delete(wake); });
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
