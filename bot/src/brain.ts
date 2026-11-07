// Strategy: how much a tile is worth to us, and when to cash words in.
//
// Facts from the server source that drive everything here:
//  * Coins are NOT score. Spending never lowers your score, and coins left at
//    the end are worth nothing. Coins only matter as liquidity for bids.
//  * Tiles left in your rack at the end are worth nothing either.
//  * 7+ letters = 3x. That multiplier dominates: one 7-letter word with base
//    12 (36 pts) beats four 3-letter words.
//  * Vickrey: you pay the runner-up's bid, so bidding your true value is
//    safe. Bids are capped at your balance and can be replaced while open.
//  * Unsold tiles are discarded (not returned). The match ends when the last
//    auction closes, so the last tile auctioned can never be played.
import { BAG_COUNTS, Counts, LETTER_VALUE, Lexicon, idx, total } from "./engine.js";

export interface Params {
  mcSamples: number;
  futureShare: number; // fraction of remaining auctions we expect to win
  maxFuture: number;
  bidMult: number; // multiplier on marginal value
  capEarly: number; // max fraction of balance on one tile, start of match
  minPlayLen: number; // hold out for words at least this long
  liquidityFloor: number; // play a smaller word if balance dips below this
  liqMarket: number; // ...or below liqMarket * market price (0 = off)
  liqMinLen: number; // shortest word allowed when cash-starved
  clogSize: number; // rack size at which we cash in a word anyway
  // Budget pacing: mult *= clamp((affordable / marketPrice)^paceGamma).
  // affordable = balance / (tiles we still expect to buy). 0 disables.
  paceGamma: number;
  paceShare: number; // share of remaining auctions we aim to win
  paceLo: number;
  paceHi: number;
  // Endgame spend-down: in the last `endgameAt` auctions, bid at least
  // balance / (endShare * auctions left), even for tiles we can't use
  // (pure denial). Coins are worthless once the bag empties. 0 disables.
  endgameAt: number;
  endShare: number;
  // Denial / price-push: bid up to denial * min(rival balance, rivalMult *
  // tile's value to that rival). If they outbid us, they pay our bid; if not,
  // we've blocked their word. Only vs rivals within threatMargin of us or ahead.
  denial: number;
  rivalMult: number;
  threatMargin: number;
  rivalSamples: number;
  choiceAware: number; // >0: value = best word using rack + any k of (k*choiceAware) upcoming tiles
  budgetAware: number; // 1 = re-value with only the tiles we could afford after this bid
  denyAt: number; // only block when bagLeft <= denyAt (coins nearly worthless); 99 = always
}

export const DEFAULT_PARAMS: Params = {
  mcSamples: 24,
  futureShare: 0.3,
  maxFuture: 5,
  bidMult: 3, // with pacing on; fixed-mult Nash was ~2.5
  capEarly: 0.5,
  minPlayLen: 7,
  liquidityFloor: 6,
  liqMarket: 0,
  liqMinLen: 5,
  clogSize: 12,
  paceGamma: 0.5, // adaptive budget pacing (big win vs every field tested)
  paceShare: 0.25,
  paceLo: 0.6,
  paceHi: 1.8,
  endgameAt: 6, // +4pts win% in self-play (end6/10/15 all 18-19% vs 14%)
  endShare: 0.5,
  denial: 0,
  rivalMult: 2.0,
  threatMargin: 25,
  rivalSamples: 6,
  denyAt: 99,
  budgetAware: 0,
  choiceAware: 0,
};

export interface View {
  rack: Counts;
  balance: number;
  bagLeft: number; // tiles still in the bag AFTER the current auction's tile
  players: number;
  unseen: Counts; // tiles we haven't seen leave the bag (incl. opp start racks)
  firstPrice: boolean;
  lastPaid?: number[]; // recent prices paid for this letter (market)
  marketPaid?: number; // mean price paid over recent sold auctions (any letter)
  myScore?: number;
  rivals?: Rival[];
}

/**
 * What we can see of an opponent. Every auction winner and every played word
 * is public, so a rival's rack = letters they won - letters they played, plus
 * `hidden` starting tiles we haven't seen yet (5 minus those revealed in words).
 */
export interface Rival {
  known: Counts;
  hidden: number;
  score: number;
  balance: number;
}

// Small deterministic RNG so valuations are stable between re-bids.
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export class Brain {
  constructor(
    readonly lex: Lexicon,
    readonly p: Params = DEFAULT_PARAMS,
  ) {}

  /** Expected-score gain from adding `letter` to the rack. */
  marginal(v: View, letter: string, seed = 1, futureCap = 99): number {
    const L = idx(letter);
    const rand = rng(seed * 2654435761 + total(v.rack));
    const m = Math.min(this.p.maxFuture, Math.round(v.bagLeft * this.p.futureShare), futureCap);
    const pool: number[] = [];
    for (let i = 0; i < 26; i++) for (let k = 0; k < v.unseen[i]!; k++) pool.push(i);
    const r = Int8Array.from(v.rack);
    let sum = 0;
    const n = m === 0 ? 1 : this.p.mcSamples;
    for (let s = 0; s < n; s++) {
      // sample m future tiles (common random numbers for with/without)
      const picked: number[] = [];
      const draw = this.p.choiceAware > 0 ? Math.min(v.bagLeft, Math.round(m * this.p.choiceAware)) : m;
      for (let k = 0; k < draw && pool.length > 0; k++) {
        const j = Math.floor(rand() * pool.length);
        picked.push(pool[j]!);
        [pool[j], pool[pool.length - 1]] = [pool[pool.length - 1]!, pool[j]!];
        pool.pop();
      }
      let without: number, withT: number;
      if (this.p.choiceAware > 0 && m > 0) {
        // `picked` = tiles that will come up; we may buy any m of them.
        const pc = new Int8Array(26);
        for (const t of picked) pc[t]!++;
        without = this.lex.bestWithPool(r, pc, m);
        r[L]!++;
        withT = this.lex.bestWithPool(r, pc, m);
        r[L]!--;
      } else {
        for (const t of picked) r[t]!++;
        without = this.lex.greedy2(r);
        r[L]!++;
        withT = this.lex.greedy2(r);
        r[L]!--;
        for (const t of picked) r[t]!--;
      }
      pool.push(...picked);
      sum += withT - without;
    }
    return sum / n;
  }

  /** Bid multiplier after budget pacing against the observed market. */
  paceMult(v: View): number {
    const base = this.p.bidMult;
    if (!this.p.paceGamma || v.marketPaid === undefined) return base;
    const expectBuys = Math.max(1, v.bagLeft * this.p.paceShare);
    const affordable = v.balance / expectBuys;
    const ratio = affordable / Math.max(1, v.marketPaid);
    const f = Math.pow(ratio, this.p.paceGamma);
    return base * Math.max(this.p.paceLo, Math.min(this.p.paceHi, f));
  }

  /** Expected gain to a rival from `letter`, sampling their hidden tiles. */
  rivalValue(v: View, r: Rival, letter: string, seed: number): number {
    const L = idx(letter);
    const rand = rng(seed * 40503 + r.score * 7 + total(r.known));
    const pool: number[] = [];
    for (let i = 0; i < 26; i++) for (let k = 0; k < v.unseen[i]!; k++) pool.push(i);
    const rack = Int8Array.from(r.known);
    const n = r.hidden > 0 ? this.p.rivalSamples : 1;
    let sum = 0;
    for (let s = 0; s < n; s++) {
      const picked: number[] = [];
      for (let k = 0; k < r.hidden && pool.length; k++) {
        const j = Math.floor(rand() * pool.length);
        picked.push(pool[j]!);
        [pool[j], pool[pool.length - 1]] = [pool[pool.length - 1]!, pool[j]!];
        pool.pop();
      }
      for (const t of picked) rack[t]!++;
      const without = this.lex.best(rack).score;
      rack[L]!++;
      sum += this.lex.best(rack).score - without;
      rack[L]!--;
      for (const t of picked) rack[t]!--;
      pool.push(...picked);
    }
    return sum / n;
  }

  /** Bid that blocks (or taxes) the most dangerous rival for this tile. */
  denialBid(v: View, letter: string, seed: number): number {
    let best = 0;
    const mine = v.myScore ?? 0;
    for (const r of v.rivals ?? []) {
      if (r.score + this.p.threatMargin < mine) continue; // not a threat
      if (r.balance <= 0) continue;
      const val = this.rivalValue(v, r, letter, seed);
      if (val <= 0) continue;
      const theirBid = Math.min(r.balance, val * this.p.rivalMult);
      best = Math.max(best, theirBid * this.p.denial);
    }
    return best;
  }

  decideBid(v: View, letter: string, seed = 1): number {
    // The last auctioned tile closes the match: nobody can ever play it.
    if (v.bagLeft === 0) return 0;
    let val = this.marginal(v, letter, seed);
    if (this.p.budgetAware && v.marketPaid && v.bagLeft > 0) {
      // After paying ~this much, how many more tiles could we still buy?
      const spend = Math.min(v.balance, val * this.paceMult(v));
      const affordable = Math.max(0, Math.floor((v.balance - spend) / v.marketPaid) + 1);
      const m = Math.min(this.p.maxFuture, Math.round(v.bagLeft * this.p.futureShare));
      if (affordable < m) val = Math.min(val, this.marginal(v, letter, seed, affordable));
    }
    const floor =
      this.p.endgameAt > 0 && v.bagLeft <= this.p.endgameAt
        ? Math.floor(v.balance / Math.max(1, (v.bagLeft + 1) * this.p.endShare))
        : 0;
    if (val <= 0.25) return Math.min(v.balance, Math.max(floor, v.balance > 30 ? 1 : 0));
    // Coins have no end value, so the cap loosens to 100% as the bag drains.
    const progress = 1 - v.bagLeft / 68;
    const cap = this.p.capEarly + (1 - this.p.capEarly) * Math.max(0, Math.min(1, progress));
    let bid = val * this.paceMult(v);
    if (v.firstPrice) {
      // shade toward the market price for this letter
      const mk = v.lastPaid?.length
        ? v.lastPaid.reduce((a, b) => a + b, 0) / v.lastPaid.length
        : LETTER_VALUE[idx(letter)]! + 2;
      bid = Math.min(bid * 0.75, mk + 1.5);
    }
    let b = Math.floor(Math.min(bid, v.balance * cap + 1));
    if (this.p.denial > 0 && v.rivals?.length && v.bagLeft <= this.p.denyAt) {
      const d = this.denialBid(v, letter, seed);
      b = Math.max(b, Math.floor(Math.min(d, v.balance * cap + 1)));
    }
    return Math.max(0, Math.min(v.balance, Math.max(b, floor)));
  }

  /**
   * Words to submit right now (possibly several). `final` = no more tiles will
   * ever reach us, so dump the optimal partition.
   */
  decideWords(v: View, final: boolean): string[] {
    const rack = Int8Array.from(v.rack);
    if (final) return this.lex.partition(rack, 300).words;
    const out: string[] = [];
    for (;;) {
      const cands = this.lex.all(rack, 2);
      if (!cands.length) break;
      const size = total(rack);
      let minLen = this.p.minPlayLen;
      const floorCoins = Math.max(this.p.liquidityFloor, this.p.liqMarket * (v.marketPaid ?? 0));
      if (v.balance < floorCoins && v.bagLeft > 0) minLen = Math.min(minLen, this.p.liqMinLen);
      if (size >= this.p.clogSize) minLen = Math.min(minLen, 5);
      // Late game: fewer tiles coming, so holding out for 7s pays less.
      if (v.bagLeft < 8) minLen = Math.min(minLen, 6);
      let best: { w: string; s: number; c: Counts } | null = null;
      for (const c of cands) {
        if (c.len < minLen) continue;
        // score now + a little credit for the leave
        const leave = Int8Array.from(rack);
        for (let i = 0; i < 26; i++) leave[i]! -= c.counts[i]!;
        const s = c.score + 0.35 * this.lex.best(leave).score;
        if (!best || s > best.s) best = { w: c.word, s, c: c.counts };
      }
      if (!best) break;
      out.push(best.w);
      for (let i = 0; i < 26; i++) rack[i]! -= best.c[i]!;
      v = { ...v, balance: v.balance + best.s };
    }
    return out;
  }
}

export const freshUnseen = () => Int8Array.from(BAG_COUNTS);
