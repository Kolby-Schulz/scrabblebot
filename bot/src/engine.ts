// Word engine: an anagram trie over sorted-letter keys, so "every word I can
// spell from this rack" is a pruned DFS instead of a 172k-word scan.
import * as fs from "node:fs";

export const LETTER_VALUE = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]; // A..Z
export const BAG_COUNTS = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

export type Counts = Int8Array; // length 26

export const idx = (c: string) => c.charCodeAt(0) - 65;
export const chr = (i: number) => String.fromCharCode(65 + i);

export function wordScore(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += LETTER_VALUE[word.charCodeAt(i) - 65]!;
  const n = word.length;
  if (n <= 3) return base;
  if (n === 4) return Math.floor((base * 3) / 2);
  if (n === 5) return base * 2;
  if (n === 6) return Math.floor((base * 5) / 2);
  return base * 3;
}

export function countsOf(s: string): Counts {
  const c = new Int8Array(26);
  for (let i = 0; i < s.length; i++) c[s.charCodeAt(i) - 65]!++;
  return c;
}
export function countsFromMap(m: Map<string, number>): Counts {
  const c = new Int8Array(26);
  for (const [k, v] of m) if (/^[A-Z]$/.test(k)) c[idx(k)]! += v;
  return c;
}
export const total = (c: Counts) => c.reduce((a, b) => a + b, 0);
export const countsKey = (c: Counts) => c.join(",");
export function rackString(c: Counts) {
  let s = "";
  for (let i = 0; i < 26; i++) s += chr(i).repeat(c[i]!);
  return s;
}

export interface Cand {
  word: string;
  score: number;
  counts: Counts;
  len: number;
}

export class Lexicon {
  // first-child / next-sibling trie
  private letter: Int8Array;
  private child: Int32Array;
  private sib: Int32Array;
  private term: Int32Array; // index into words[], -1 if none
  private n = 1;
  readonly words: string[] = [];
  readonly scores: number[] = [];
  readonly set = new Set<string>();

  constructor(path: string, maxLen = 15) {
    const cap = 1_600_000;
    this.letter = new Int8Array(cap);
    this.child = new Int32Array(cap).fill(-1);
    this.sib = new Int32Array(cap).fill(-1);
    this.term = new Int32Array(cap).fill(-1);
    const lines = fs.readFileSync(path, "utf8").split("\n");
    for (const raw of lines) {
      const w = raw.trim().toUpperCase();
      if (w.length < 2 || w.length > maxLen || !/^[A-Z]+$/.test(w)) continue;
      this.set.add(w);
      const key = [...w].sort().join("");
      let node = 0;
      for (let i = 0; i < key.length; i++) {
        const L = key.charCodeAt(i) - 65;
        let c = this.child[node]!;
        let prev = -1;
        while (c !== -1 && this.letter[c]! < L) {
          prev = c;
          c = this.sib[c]!;
        }
        if (c === -1 || this.letter[c] !== L) {
          const nn = this.n++;
          this.letter[nn] = L;
          this.sib[nn] = c;
          if (prev === -1) this.child[node] = nn;
          else this.sib[prev] = nn;
          c = nn;
        }
        node = c;
      }
      if (this.term[node] === -1) {
        this.term[node] = this.words.length;
        this.words.push(w);
        this.scores.push(wordScore(w));
      }
    }
  }

  isWord(w: string) {
    return this.set.has(w);
  }

  /** Highest-scoring single word spellable from rack (score 0 if none). */
  best(rack: Counts, minLen = 2): { score: number; wi: number } {
    let bestS = 0;
    let bestW = -1;
    const { letter, child, sib, term, scores } = this;
    const dfs = (node: number, depth: number) => {
      for (let c = child[node]!; c !== -1; c = sib[c]!) {
        const L = letter[c]!;
        if (rack[L]! <= 0) continue;
        rack[L]!--;
        const t = term[c]!;
        if (t !== -1 && depth + 1 >= minLen && scores[t]! > bestS) {
          bestS = scores[t]!;
          bestW = t;
        }
        dfs(c, depth + 1);
        rack[L]!++;
      }
    };
    dfs(0, 0);
    return { score: bestS, wi: bestW };
  }

  /**
   * Best word from `rack` plus at most `k` letters chosen from `pool`: the
   * value of a plan when we get to pick which upcoming tiles to buy.
   * Rack letters are used first (they're free); pool letters cost a pick.
   */
  bestWithPool(rack: Counts, pool: Counts, k: number): number {
    let bestS = 0;
    const { letter, child, sib, term, scores } = this;
    const dfs = (node: number, picks: number) => {
      for (let c = child[node]!; c !== -1; c = sib[c]!) {
        const L = letter[c]!;
        let fromPool = false;
        if (rack[L]! > 0) rack[L]!--;
        else if (picks < k && pool[L]! > 0) {
          pool[L]!--;
          fromPool = true;
        } else continue;
        const t = term[c]!;
        if (t !== -1 && scores[t]! > bestS) bestS = scores[t]!;
        dfs(c, picks + (fromPool ? 1 : 0));
        if (fromPool) pool[L]!++;
        else rack[L]!++;
      }
    };
    dfs(0, 0);
    return bestS;
  }

  /** All spellable words (one per anagram class). */
  all(rack: Counts, minLen = 2): Cand[] {
    const out: Cand[] = [];
    const { letter, child, sib, term } = this;
    const used = new Int8Array(26);
    const dfs = (node: number, depth: number) => {
      for (let c = child[node]!; c !== -1; c = sib[c]!) {
        const L = letter[c]!;
        if (rack[L]! - used[L]! <= 0) continue;
        used[L]!++;
        const t = term[c]!;
        if (t !== -1 && depth + 1 >= minLen) {
          out.push({
            word: this.words[t]!,
            score: this.scores[t]!,
            counts: Int8Array.from(used),
            len: depth + 1,
          });
        }
        dfs(c, depth + 1);
        used[L]!--;
      }
    };
    dfs(0, 0);
    return out;
  }

  /** Greedy: best word, then best word from what's left. Fast valuation proxy. */
  greedy2(rack: Counts): number {
    const a = this.best(rack);
    if (a.wi < 0) return 0;
    const w = this.words[a.wi]!;
    for (let i = 0; i < w.length; i++) rack[w.charCodeAt(i) - 65]!--;
    const b = this.best(rack);
    for (let i = 0; i < w.length; i++) rack[w.charCodeAt(i) - 65]!++;
    return a.score + b.score;
  }

  /**
   * Exact max total score from splitting the rack into disjoint words
   * (leftovers allowed). Branch on the lowest letter present: either it is
   * discarded or it's in some word. Memoised; with a deadline fallback.
   */
  partition(rack: Counts, deadlineMs = 400): { score: number; words: string[] } {
    const cands = this.all(Int8Array.from(rack));
    const byFirst: Cand[][] = Array.from({ length: 26 }, () => []);
    for (const c of cands) {
      let f = 0;
      while (c.counts[f] === 0) f++;
      byFirst[f]!.push(c);
    }
    for (const l of byFirst) l.sort((a, b) => b.score - a.score);
    const memo = new Map<string, { score: number; words: string[] }>();
    const stop = Date.now() + deadlineMs;
    const r = Int8Array.from(rack);
    const go = (): { score: number; words: string[] } => {
      let f = 0;
      while (f < 26 && r[f] === 0) f++;
      if (f === 26) return { score: 0, words: [] };
      const key = countsKey(r);
      const hit = memo.get(key);
      if (hit) return hit;
      // option 1: discard one of letter f
      r[f]!--;
      let best = go();
      r[f]!++;
      if (Date.now() < stop) {
        outer: for (const c of byFirst[f]!) {
          for (let i = f; i < 26; i++) if (c.counts[i]! > r[i]!) continue outer;
          for (let i = f; i < 26; i++) r[i]! -= c.counts[i]!;
          const sub = go();
          for (let i = f; i < 26; i++) r[i]! += c.counts[i]!;
          if (sub.score + c.score > best.score)
            best = { score: sub.score + c.score, words: [c.word, ...sub.words] };
        }
      }
      memo.set(key, best);
      return best;
    };
    return go();
  }
}
