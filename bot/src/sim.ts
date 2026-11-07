// Offline match simulator mirroring spacetimedb/src/game.ts rules.
// Usage: npx tsx src/sim.ts [matches]
import * as path from "node:path";
import { BAG_COUNTS, Counts, LETTER_VALUE, Lexicon, chr, countsOf, idx, total } from "./engine.js";
import { Brain, DEFAULT_PARAMS, Params, freshUnseen } from "./brain.js";

const lex = new Lexicon(path.join(import.meta.dirname, "..", "wordlist.txt"));
const longestFirst = [...lex.set].sort((a, b) => b.length - a.length);

type Kind =
  | { t: "Cheapskate" | "ValueBidder" | "Aggressive" }
  | { t: "Starter" }
  | { t: "Brain"; brain: Brain; name: string };

interface Seat {
  kind: Kind;
  rack: Counts;
  bal: number;
  score: number;
  unseen: Counts;
}

function longestPlayable(rack: Counts, minLen: number): string | undefined {
  const n = total(rack);
  for (const w of longestFirst) {
    if (w.length < minLen) return;
    if (w.length > n) continue;
    const c = countsOf(w);
    if (c.every((x, i) => x <= rack[i]!)) return w;
  }
}

function play(s: Seat, w: string) {
  const c = countsOf(w);
  for (let i = 0; i < 26; i++) {
    if (c[i]! > s.rack[i]!) return;
  }
  if (!lex.isWord(w)) return;
  for (let i = 0; i < 26; i++) s.rack[i]! -= c[i]!;
  const sc = scoreOf(w);
  s.bal += sc;
  s.score += sc;
}
import { wordScore as scoreOf } from "./engine.js";

function rnd(n: number) {
  return Math.floor(Math.random() * n);
}

export function runMatch(kinds: Kind[], firstPrice = false): number[] {
  const bag = Array.from(BAG_COUNTS);
  let bagTotal = 98;
  const draw = () => {
    let i = rnd(bagTotal);
    for (let L = 0; L < 26; L++) {
      if (i < bag[L]!) {
        bag[L]!--;
        bagTotal--;
        return L;
      }
      i -= bag[L]!;
    }
    return -1;
  };
  const seats: Seat[] = kinds.map((kind) => ({
    kind, rack: new Int8Array(26), bal: 100, score: 0, unseen: freshUnseen(),
  }));
  for (const s of seats)
    for (let k = 0; k < 5; k++) {
      const L = draw();
      s.rack[L]!++;
      s.unseen[L]!--;
    }
  let seed = 1;
  const paids: number[] = [];
  const market = () => (paids.length ? paids.slice(-12).reduce((a, b) => a + b, 0) / Math.min(12, paids.length) : undefined);
  while (bagTotal > 0) {
    const L = draw();
    const letter = chr(L);
    const bagLeft = bagTotal;
    // word phase at auction open (smart bots)
    for (const s of seats) {
      s.unseen[L]!--;
      if (s.kind.t === "Brain") {
        const v = view(s, bagLeft, seats.length, firstPrice, market());
        for (const w of s.kind.brain.decideWords(v, bagLeft === 0)) play(s, w);
      }
    }
    // bids
    const bids: { i: number; amt: number }[] = [];
    seats.forEach((s, i) => {
      let amt = 0;
      const val = LETTER_VALUE[L]!;
      const jit = rnd(5) - 2;
      switch (s.kind.t) {
        case "Cheapskate": amt = Math.max(val - 1 + jit, 1); break;
        case "ValueBidder": amt = Math.max(val + jit, 1); break;
        case "Aggressive": amt = Math.max(val + ("AEIOU".includes(letter) ? 4 : 2) + jit, 1); break;
        case "Starter": amt = s.rack[L]! === 0 ? val + 2 : Math.max(1, val); break;
        case "Brain": amt = s.kind.brain.decideBid(view(s, bagLeft, seats.length, firstPrice, market()), letter, seed++); break;
      }
      amt = Math.min(amt, s.bal);
      if (amt > 0) bids.push({ i, amt });
    });
    bids.sort(() => Math.random() - 0.5).sort((a, b) => b.amt - a.amt);
    if (bids.length) {
      const w = seats[bids[0]!.i]!;
      const paid = firstPrice ? bids[0]!.amt : bids[1] ? bids[1].amt : 1;
      if (w.bal >= paid) {
        w.bal -= paid;
        paids.push(paid);
        w.rack[L]!++;
        const t = w.kind.t;
        if (t === "Cheapskate" || t === "ValueBidder" || t === "Aggressive") {
          const word = longestPlayable(w.rack, 3);
          if (word) play(w, word);
        }
      }
    }
    // starter plays greedily whenever its rack changes
    for (const s of seats)
      if (s.kind.t === "Starter") {
        const word = longestPlayable(s.rack, 2);
        if (word) play(s, word);
      }
  }
  return seats.map((s) => s.score);
}

function view(s: Seat, bagLeft: number, players: number, firstPrice: boolean, marketPaid?: number) {
  return { rack: s.rack, balance: s.bal, bagLeft, players, unseen: s.unseen, firstPrice, marketPaid };
}

// ---- CLI: our brain vs a field ----
if (process.argv[1]?.endsWith("sim.ts")) {
  const N = Number(process.argv[2] ?? 40);
  const variants: Record<string, Partial<Params>> = JSON.parse(process.argv[3] ?? '{"base":{}}');
  const field = (process.argv[4] ?? "sims") as "sims" | "self" | "mixed";
  const fieldBrain = new Brain(lex, { ...DEFAULT_PARAMS, ...JSON.parse(process.argv[5] ?? "{}") });
  for (const [name, over] of Object.entries(variants)) {
    const brain = new Brain(lex, { ...DEFAULT_PARAMS, ...over });
    let wins = 0, sum = 0, margin = 0;
    const t0 = Date.now();
    for (let m = 0; m < N; m++) {
      const opp: Kind[] =
        field === "self"
          ? Array.from({ length: 5 }, () => ({ t: "Brain", brain: fieldBrain, name: "def" }) as Kind)
          : field === "mixed"
          ? [{ t: "Brain", brain: fieldBrain, name: "a" }, { t: "Brain", brain: fieldBrain, name: "b" }, { t: "Starter" }, { t: "Aggressive" }, { t: "ValueBidder" }]
          : [{ t: "Aggressive" }, { t: "ValueBidder" }, { t: "Cheapskate" }, { t: "Starter" }, { t: "Aggressive" }];
      const sc = runMatch([{ t: "Brain", brain, name }, ...opp]);
      const best = Math.max(...sc.slice(1));
      if (sc[0]! > best) wins++;
      sum += sc[0]!;
      margin += sc[0]! - best;
    }
    console.log(
      `${name.padEnd(14)} win ${((100 * wins) / N).toFixed(0)}%  avg ${(sum / N).toFixed(1)}  margin ${(margin / N).toFixed(1)}  (${((Date.now() - t0) / N).toFixed(0)}ms/match)`,
    );
  }
}
