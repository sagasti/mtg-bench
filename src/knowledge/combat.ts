/**
 * Pilot patch (mtg-rival): combat outcomes rendered into in-game prompts when event.combatMath is on. For every
 * creature that could attack (or, on defence, every attacker to block) it lists each legal single block and what
 * happens in it — who dies, what tramples through — from the keywords Forge prints on the permanents (first strike,
 * double strike, deathtouch, trample, indestructible, lifelink, flying, reach, menace, "can't be blocked except by
 * creatures with flying") and totem armor on attached umbras. Then the race: unblocked damage both ways in turns.
 * Single blocks only; pump spells, tricks and activated abilities are not modelled. Same section for every seat.
 */
import { type CardDb, getCard } from "../cards/db.ts";
import type { DecisionRequest } from "../types.ts";
import { type GameState, type Perm, permText, power } from "./damage.ts";

const KINDS = new Set(["priority", "attackers", "blockers"]);
const KEYWORDS = ["Flying", "Reach", "First strike", "Double strike", "Trample", "Deathtouch", "Lifelink", "Indestructible", "Menace", "Defender", "Hexproof"];

interface Fighter { p: Perm; name: string; pow: number; tou: number; kw: Set<string>; totem: boolean; text: string }

const toughness = (pt?: string) => { const m = (pt ?? "").match(/\/(-?\d+|\*)$/); return m && m[1] !== "*" ? Number(m[1]) : 0; };

function fighter(p: Perm, db: CardDb): Fighter {
  const text = permText(p, db);
  const kw = new Set<string>();
  const kwText = text.replace(/can't be blocked[^.\n]*\.?/gi, "").replace(/creatures with [a-z ]+/gi, "");   // "except by creatures with flying" is not Flying
  for (const k of KEYWORDS) if (new RegExp(`\\b${k}\\b`, "i").test(kwText)) kw.add(k.toLowerCase());
  let totem = false;   // an attached umbra (Hyena Umbra, Spider Umbra…) saves the creature from destruction once
  for (const m of text.matchAll(/=Attached: ([^=]+)=/g)) for (const part of m[1].split(",")) {
    const n = part.replace(/\s*\(\d+\)\s*$/, "").trim();
    if (/totem armor/i.test(getCard(db, n)?.oracle ?? "")) totem = true;
  }
  return { p, name: p.name, pow: power(p.pt), tou: toughness(p.pt), kw, totem, text };
}

const label = (f: Fighter) => `${f.name} ${f.p.pt}${f.kw.size ? ` (${[...f.kw].join(", ")})` : ""}`;

/** Can b legally block a alone? Menace / "two or more" needs two blockers: never alone. */
function canBlock(a: Fighter, b: Fighter): boolean {
  if (/can't be blocked\b(?! except| by)/i.test(a.text) || /can't be blocked\.$/im.test(a.text)) return false;
  if (a.kw.has("menace") || /can't be blocked except by two or more/i.test(a.text)) return false;
  if (/can't be blocked except by creatures with flying/i.test(a.text)) return b.kw.has("flying");
  if (/can't be blocked by creatures with power (\d+) or (less|greater)/i.test(a.text)) {
    const m = a.text.match(/can't be blocked by creatures with power (\d+) or (less|greater)/i)!;
    if (m[2] === "less" ? b.pow <= Number(m[1]) : b.pow >= Number(m[1])) return false;
  }
  if (a.kw.has("flying") && !(b.kw.has("flying") || b.kw.has("reach"))) return false;
  if (/can't block\b/i.test(b.text) && !/can't block creatures with/i.test(b.text)) return false;
  return true;
}

/** One block, both damage steps. */
function fight(a: Fighter, b: Fighter): { aDies: boolean; bDies: boolean; through: number; umbra: boolean } {
  let aDmg = 0, bDmg = 0, through = 0, aDead = false, bDead = false;
  const aFirst = a.kw.has("first strike") || a.kw.has("double strike");
  const bFirst = b.kw.has("first strike") || b.kw.has("double strike");
  const hit = (dmg: number) => {   // attacker's damage to the blocker, excess tramples through
    const need = a.kw.has("deathtouch") ? 1 : Math.max(0, b.tou - bDmg);
    if (a.kw.has("trample") && dmg > need) { through += dmg - need; bDmg += need; } else bDmg += dmg;
  };
  const step = (aHits: boolean, bHits: boolean) => {
    if (aHits && !aDead) hit(a.pow);
    if (bHits && !bDead) aDmg += b.pow;
    if (!bDead && bDmg > 0 && (bDmg >= b.tou || a.kw.has("deathtouch")) && !b.kw.has("indestructible")) bDead = true;
    if (!aDead && aDmg > 0 && (aDmg >= a.tou || b.kw.has("deathtouch")) && !a.kw.has("indestructible")) aDead = true;
  };
  if (aFirst || bFirst) step(aFirst, bFirst);
  step(!aFirst || a.kw.has("double strike"), !bFirst || b.kw.has("double strike"));
  let umbra = false;
  if (aDead && a.totem) { aDead = false; umbra = true; }
  return { aDies: aDead, bDies: bDead, through, umbra };
}

const canAttackNow = (p: Perm, text: string) => !!p.pt && !p.tapped && !(p.summoningSick && !/\bHaste\b/i.test(text)) && !/\bDefender\b/i.test(text);

export function combatMath(req: DecisionRequest, db: CardDb): string | undefined {
  if (req.phase !== "game" || !KINDS.has(req.kind)) return undefined;
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent) return undefined;
  const myTurn = st.activePlayer === "you";
  const phase = String(st.phase ?? "");
  const mine = (st.you.battlefield ?? []).filter((p) => p.pt);
  const theirs = (st.opponent.battlefield ?? []).filter((p) => p.pt);
  const lines: string[] = [];

  if (req.kind === "blockers" || (!myTurn && (st.combat ?? []).some((c) => c.attacking === "you"))) {
    // --- defence: their attackers vs our possible blockers ---------------------------------------------------------
    const attackers = (st.combat ?? []).filter((c) => c.attacking === "you").map((p) => fighter(p, db));
    if (!attackers.length) return undefined;
    const blockers = mine.filter((p) => !p.tapped).map((p) => fighter(p, db));
    const incoming = attackers.reduce((s, a) => s + a.pow, 0);
    const life = st.you.life ?? 0;
    lines.push(`Attacking you: ${attackers.map(label).join(", ")}. Unblocked they deal ${incoming} (your life ${life} → ${life - incoming}).${incoming >= life ? " ⚠ LETHAL if unblocked: you must block enough of it." : ""}`);
    for (const a of attackers) {
      const opts = blockers.filter((b) => canBlock(a, b)).map((b) => {
        const r = fight(a, b);   // a attacks, b blocks
        const what = [r.aDies ? `${a.name} dies` : `${a.name} survives`, r.bDies ? `${b.name} dies` : r.umbra ? "" : `${b.name} survives`].filter(Boolean).join(", ");
        const tag = r.aDies && !r.bDies ? " (good block)" : r.aDies && r.bDies ? " (trade)" : !r.aDies && r.bDies ? " (chump)" : "";
        return `${b.name} ${b.p.pt} blocks → ${what}${r.through ? `, ${r.through} tramples through` : ""}${tag}`;
      });
      lines.push(`- ${label(a)}: ${opts.length ? opts.join("; ") : "no legal single block"}.`);
    }
    if (!blockers.length) lines.push("You have no untapped creature to block with.");
    const theirPower = theirs.filter((p) => !/\bDefender\b/i.test(permText(p, db))).reduce((s, p) => s + power(p.pt), 0);
    const myPower = mine.filter((p) => !/\bDefender\b/i.test(permText(p, db))).reduce((s, p) => s + power(p.pt), 0);
    const t = (l: number, d: number) => (d > 0 ? Math.ceil(l / d) : Infinity);
    const die = t(life - incoming, theirPower), kill = t(st.opponent.life ?? 0, myPower);
    if (incoming < life && theirPower && die <= kill) lines.push(`⚠ Behind in the race: after this attack their ${theirPower} power kills you in ${die} more attack${die === 1 ? "" : "s"}, your ${myPower} power needs ${kill === Infinity ? "∞" : kill}. Blocks that trade or chump their biggest attacker buy a turn.`);
    return `## Combat\nComputed by the harness from the visible board: single blocks, no pump or tricks.\n${lines.map((l) => (l.startsWith("- ") ? l : `- ${l}`)).join("\n")}`;
  }

  if (!myTurn || !(req.kind === "attackers" || phase === "MAIN1" || phase === "BEGIN_COMBAT" || phase === "DECLARE_ATTACKERS")) return undefined;
  const attackers = mine.filter((p) => canAttackNow(p, permText(p, db))).map((p) => fighter(p, db));
  if (!attackers.length) return undefined;
  const blockers = theirs.filter((p) => !p.tapped).map((p) => fighter(p, db));
  let total = 0, sure = 0;
  for (const a of attackers) {
    total += a.pow;
    const legal = blockers.filter((b) => canBlock(a, b));
    if (!legal.length) { sure += a.pow; lines.push(`- ${label(a)}: no untapped creature of theirs can block it.`); continue; }
    const worst: string[] = [];
    const opts = legal.map((b) => {
      const r = fight(a, b);
      if (r.aDies) worst.push(b.name);
      const what = [r.aDies ? `${a.name} DIES` : r.umbra ? `${a.name} survives (umbra destroyed instead)` : `${a.name} survives`, r.bDies ? `${b.name} dies` : `${b.name} survives`].join(", ");
      return `${b.name} ${b.p.pt}${b.kw.has("deathtouch") ? " deathtouch" : ""}${b.kw.has("first strike") ? " first strike" : ""} → ${what}${r.through ? `, ${r.through} tramples through` : ""}`;
    });
    const verdict = worst.length ? ` ⚠ dies if ${worst.join(" or ")} blocks${a.kw.has("first strike") ? "" : (legal.some((b) => b.kw.has("deathtouch")) ? " (first strike would kill the deathtouch blocker first)" : "")}.` : " Survives any single block.";
    lines.push(`- ${label(a)}: ${opts.join("; ")}.${verdict}`);
  }
  const oppLife = st.opponent.life ?? 0;
  lines.push(`If nothing is blocked: ${total} damage (their life ${oppLife} → ${oppLife - total}); ${sure} of it cannot be blocked. They have ${blockers.length} untapped creature${blockers.length === 1 ? "" : "s"} to block with.`);
  // --- race ---------------------------------------------------------------------------------------------------------
  const theirPower = theirs.filter((p) => !/\bDefender\b/i.test(permText(p, db))).reduce((s, p) => s + power(p.pt), 0);
  const myLife = st.you.life ?? 0;
  const turns = (life: number, dmg: number) => (dmg > 0 ? Math.ceil(life / dmg) : Infinity);
  const mineIn = turns(oppLife, total);
  lines.push(`Race if nobody blocks: your ${total} power kills them in ${mineIn} attack${mineIn === 1 ? "" : "s"}; ${theirPower ? `their ${theirPower} power on board kills you (life ${myLife}) in ${turns(myLife, theirPower)}` : "they have no creature that can attack you"}.`);
  return `## Combat\nComputed by the harness from the visible board: single blocks, no pump or tricks, keywords as Forge prints them.\n${lines.join("\n")}`;
}

/**
 * Pilot patch (combatPolicy strict): attackers that wear an aura, have no first strike / double strike / indestructible /
 * totem armor, and can be blocked by an untapped deathtouch creature: the block kills the creature and every aura on
 * it for one blocker. Returned so the agent can drop those options when the attack is not lethal anyway.
 */
export function suicidalAttackers(req: DecisionRequest, db: CardDb): { id: string; name: string; blocker: string; auras: number }[] {
  if (req.phase !== "game" || req.kind !== "attackers") return [];
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent || st.activePlayer !== "you") return [];
  const mine = (st.you.battlefield ?? []).filter((p) => p.pt);
  const blockers = (st.opponent.battlefield ?? []).filter((p) => p.pt && !p.tapped).map((p) => fighter(p, db)).filter((b) => b.kw.has("deathtouch"));
  if (!blockers.length) return [];
  const attackers = mine.filter((p) => canAttackNow(p, permText(p, db))).map((p) => fighter(p, db));
  const total = attackers.reduce((s, a) => s + a.pow, 0);
  if (total >= (st.opponent.life ?? 0)) return [];   // lethal if unblocked: let the model weigh it
  const out: { id: string; name: string; blocker: string; auras: number }[] = [];
  for (const a of attackers) {
    const auras = [...a.text.matchAll(/=Attached: ([^=]+)=/g)].flatMap((m) => m[1].split(",")).length;
    if (!auras || a.kw.has("first strike") || a.kw.has("double strike") || a.kw.has("indestructible") || a.totem) continue;
    const killer = blockers.find((b) => canBlock(a, b) && fight(a, b).aDies);
    if (!killer) continue;
    const opt = req.options.find((o) => o.id === a.p.id || (a.p.id && o.id.startsWith(a.p.id)));
    if (opt) out.push({ id: opt.id, name: a.name, blocker: killer.name, auras });
  }
  return out;
}


/**
 * Pilot patch (combatPolicy strict): when the attack is lethal if unblocked and single blocks can bring it under our
 * life, the blocks to declare: biggest attackers first, for each the best available blocker (kills and survives >
 * trade > chump with the cheapest creature), until the remaining damage is survivable. Undefined when not lethal or
 * when no assignment saves us (then the model decides).
 */
export function lethalBlocks(req: DecisionRequest, db: CardDb): { ids: string[]; why: string } | undefined {
  if (req.phase !== "game" || req.kind !== "blockers") return undefined;
  const st = req.state as GameState | undefined;
  if (!st?.you || !st.opponent) return undefined;
  const attackers = (st.combat ?? []).filter((c) => c.attacking === "you").map((p) => fighter(p, db));
  const life = st.you.life ?? 0;
  const incoming = attackers.reduce((s, a) => s + a.pow, 0);
  if (!attackers.length || incoming < life) return undefined;
  const blockers = (st.you.battlefield ?? []).filter((p) => p.pt && !p.tapped).map((p) => fighter(p, db));
  const pair = new Map<string, string>();   // "blockerId->attackerId" -> option id
  for (const o of req.options) { const m = o.id.match(/^(c\d+)->(c\d+)$/); if (m) pair.set(`${m[1]}->${m[2]}`, o.id); }
  const used = new Set<string>(); const ids: string[] = []; const why: string[] = [];
  let remaining = incoming;
  const auras = (f: Fighter) => [...f.text.matchAll(/=Attached: ([^=]+)=/g)].flatMap((m) => m[1].split(",")).length;
  for (const a of [...attackers].sort((x, y) => y.pow - x.pow)) {
    if (remaining < life) break;
    let best: { b: Fighter; score: number; through: number } | undefined;
    for (const b of blockers) {
      if (used.has(b.p.id ?? "") || !pair.has(`${b.p.id}->${a.p.id}`) || !canBlock(a, b)) continue;
      const r = fight(a, b);
      const score = (r.aDies && !r.bDies ? 300 : r.aDies && r.bDies ? 200 : 100) - auras(b) * 10 - b.pow - (r.umbra ? 5 : 0);
      if (!best || score > best.score) best = { b, score, through: r.through };
    }
    if (!best) continue;
    used.add(best.b.p.id ?? ""); ids.push(pair.get(`${best.b.p.id}->${a.p.id}`)!);
    remaining -= a.pow - best.through;
    why.push(`${best.b.name} blocks ${a.name}`);
  }
  if (!ids.length || remaining >= life) return undefined;
  return { ids, why: `${incoming} incoming vs ${life} life: ${why.join(", ")} (${remaining} gets through)` };
}
