// LexiconWarrior live client.
//
//   BOT_NAME=<name> BOT_TOKEN=<token> npm start   first run (saves .token-<name>)
//   BOT_NAME=<name> npm start                     later runs
//   BOT_NAME=<name> TOURNAMENT_ID=<id> npm start  register for a tournament
//   npm run pause                                 finish current match, then stay out
//
// Strategy lives in brain.ts; this file only wires it to SpacetimeDB: per-match
// subscriptions, bids, word plays and match logs (logs/matches.jsonl).
// Started from clockworklabs/scrabblebot bot-starter (MIT); see THIRD_PARTY_NOTICES.md.

import {
  DbConnection,
  tables,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { LETTER_VALUE, Lexicon, countsFromMap, idx } from "./engine.js";
import { Brain, DEFAULT_PARAMS, freshUnseen, type Rival, type View } from "./brain.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const BOT_TOKEN = process.env.BOT_TOKEN; // from the website, first run only
const BOT_NONCE = process.env.BOT_NONCE; // from the CLI, first run only
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TOKEN_PATH = path.join(process.cwd(), `.token-${BOT_NAME}`);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

const lex = new Lexicon(
  process.env.WORDLIST ?? path.join(path.dirname(new URL(import.meta.url).pathname), "..", "wordlist.txt"),
);
const brain = new Brain(lex, { ...DEFAULT_PARAMS, ...JSON.parse(process.env.BOT_PARAMS ?? "{}") });

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const wordBusy = new Set<string>(); // match ids with a word submission in flight

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.botCredential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.myRack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? 0) + h.count);
  }
  return rack;
}

function participantForMatch(conn: DbConnection, matchId: bigint) {
  if (myBotId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId)
      return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

// Build the brain's view. Unseen tiles = full bag - every auctioned letter
// - my own starting rack (= rack now + letters I played - letters I won).
function buildView(conn: DbConnection, matchId: bigint): View | null {
  const me = participantForMatch(conn, matchId);
  const m = conn.db.matchState.id.find(matchId);
  if (!me || !m) return null;
  const rack = countsFromMap(rackForMatch(conn, matchId));
  const unseen = freshUnseen();
  const start = Int8Array.from(rack);
  const lastPaid = new Map<string, number[]>();
  for (const a of conn.db.auction.iter()) if (a.matchId === matchId) unseen[idx(a.letter)]!--;
  const sold: { id: bigint; paid: number }[] = [];
  // Public history per rival: letters won at auction, letters played.
  const won = new Map<bigint, Int8Array>();
  const played = new Map<bigint, Int8Array>();
  const get = (m: Map<bigint, Int8Array>, b: bigint) => {
    let c = m.get(b);
    if (!c) m.set(b, (c = new Int8Array(26)));
    return c;
  };
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId !== matchId) continue;
    if (r.winnerBotId != null && r.winnerBotId !== myBotId) get(won, r.winnerBotId)[idx(r.letter)]!++;
    if (r.winnerBotId != null) sold.push({ id: r.auctionId, paid: Number(r.paid) });
    if (r.winnerBotId === myBotId) start[idx(r.letter)]!--;
    if (r.winnerBotId != null) {
      const l = lastPaid.get(r.letter) ?? [];
      l.push(Number(r.paid));
      lastPaid.set(r.letter, l);
    }
  }
  for (const w of conn.db.wordPlay.iter()) {
    if (w.matchId !== matchId) continue;
    if (w.botId === myBotId) for (const c of w.word) start[idx(c)]!++;
    else for (const c of w.word) get(played, w.botId)[idx(c)]!++;
  }
  const rivals: Rival[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId !== matchId || p.botId === myBotId) continue;
    const w = won.get(p.botId) ?? new Int8Array(26);
    const pl = played.get(p.botId) ?? new Int8Array(26);
    const known = new Int8Array(26);
    let revealed = 0;
    for (let i = 0; i < 26; i++) {
      const d = w[i]! - pl[i]!;
      if (d > 0) known[i] = d;
      else if (d < 0) {
        revealed -= d;
        unseen[i] = Math.max(0, unseen[i]! + d); // their starting tiles, now seen
      }
    }
    rivals.push({
      known, hidden: Math.max(0, m.startingRackSize - revealed),
      score: Number(p.score), balance: Number(p.balance),
    });
  }
  for (let i = 0; i < 26; i++) unseen[i] = Math.max(0, unseen[i]! - Math.max(0, start[i]!));
  let players = 0;
  for (const p of conn.db.matchParticipant.iter()) if (p.matchId === matchId) players++;
  return {
    rack, balance: me.balance, bagLeft: m.bagTotal, players, unseen,
    firstPrice: m.auctionType.tag === "FirstPrice",
    lastPaid: undefined,
    marketPaid: recentMean(sold),
    myScore: me.score,
    rivals,
    ...{ _paid: lastPaid },
  } as View;
}

function recentMean(sold: { id: bigint; paid: number }[]): number | undefined {
  if (!sold.length) return undefined;
  sold.sort((a, b) => (a.id < b.id ? -1 : 1));
  const last = sold.slice(-12);
  return last.reduce((a, b) => a + b.paid, 0) / last.length;
}

function logFailure(what: string) {
  return (err: unknown) =>
    console.warn(`[${BOT_NAME}] ${what} failed: ${err instanceof Error ? err.message : err}`);
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;
  bidsByAuction.add(key);
  const t0 = Date.now();
  const v = buildView(conn, matchId);
  if (!v) return;
  // Instant safety bid (face value), replaced below by the computed bid.
  // Bids are replaceable while the auction is open.
  const quick = v.bagLeft === 0 ? 0 : Math.min(v.balance, LETTER_VALUE[idx(letter)]! + 1);
  if (quick > 0) conn.reducers.submitBid({ auctionId, amount: BigInt(quick) }).catch(() => {});
  const paid = (v as any)._paid.get(letter) as number[] | undefined;
  v.lastPaid = paid?.slice(-4);
  const amount = brain.decideBid(v, letter, Number(auctionId % 100000n));
  if (amount > 0 || quick > 0) {
    conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }).catch(logFailure(`bid on ${auctionId}`));
  }
  logBid(matchId, { l: letter, bid: amount, x: +brain.paceMult(v).toFixed(2), mkt: v.marketPaid ?? null,
    bal: v.balance, bag: v.bagLeft, rack: [...rackForMatch(conn, matchId)].map(([c, n]) => c.repeat(n)).join("") });
  console.log(`[${BOT_NAME}] '${letter}' bid ${amount} (x${brain.paceMult(v).toFixed(2)}, mkt ${v.marketPaid?.toFixed(1) ?? '-'}, bal ${v.balance}, bag ${v.bagLeft}, ${Date.now() - t0}ms)`);
  tryPlayWord(conn);
}

function tryPlayWord(conn: DbConnection) {
  if (myBotId === null) return;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId !== myBotId) continue;
    const matchId = p.matchId;
    const m = conn.db.matchState.id.find(matchId);
    if (m?.status.tag !== "Running") continue;
    const key = String(matchId);
    if (wordBusy.has(key)) continue;
    const v = buildView(conn, matchId);
    if (!v) continue;
    const final = m.bagTotal === 0; // last auction is open: dump everything
    const words = brain.decideWords(v, final);
    if (!words.length) continue;
    wordBusy.add(key);
    console.log(`[${BOT_NAME}] match ${matchId}: playing ${words.join(", ")}${final ? " (final dump)" : ""}`);
    Promise.allSettled(
      words.map((word) => conn.reducers.submitWord({ matchId, word }).catch(logFailure(`playing '${word}'`))),
    ).then(() => {
      // The rack update can land just after the reducer resolves; wait a beat
      // so we don't resubmit the same word from a stale rack.
      setTimeout(() => {
        wordBusy.delete(key);
        tryPlayWord(conn);
      }, 250);
    });
  }
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  console.log(`[${BOT_NAME}] connected as ${identity.toHexString()}`);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] subscription applied`);

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          console.log(`[${BOT_NAME}] claiming credential with nonce…`);
          conn.reducers
            .claimCredential({ code: BOT_NONCE })
            .catch(logFailure("claiming the credential"));
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
              console.error(
                `[${BOT_NAME}] couldn't claim credential. Bad / expired nonce?`,
              );
              process.exit(1);
            }
            const bot = conn.db.bot.id.find(myBotId);
            console.log(
              `[${BOT_NAME}] claimed credential for bot '${bot?.name ?? "?"}' (id ${myBotId})`,
            );
            subscribeMine(conn);
          }, 1000);
          return;
        } else {
          console.error(
            `[${BOT_NAME}] no BotCredential for this token. Set BOT_TOKEN or BOT_NONCE and re-run.`,
          );
          process.exit(1);
        }
      }

      const bot = conn.db.bot.id.find(myBotId);
      console.log(
        `[${BOT_NAME}] acting as bot '${bot?.name ?? "?"}' (id ${myBotId})`,
      );
      subscribeMine(conn);
    })
    // NOT subscribeToAllTables: `auction`, `word_play` etc. hold every match
    // ever played (millions of rows) and blow the heap. Start small, then
    // subscribe per match (see watchMatch).
    .subscribe([
      tables.bot,
      tables.botCredential,
      tables.openLobbies,
      tables.openLobbyMembers,
      tables.myRack,
    ]);

  conn.db.matchParticipant.onInsert((_c, p) => {
    // Only matches newer than any we've seen: skip our finished history.
    if (myBotId !== null && p.botId === myBotId && p.matchId >= newestMatch) {
      newestMatch = p.matchId;
      watchMatch(conn, p.matchId);
    }
  });
  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  });
  conn.db.myRack.onInsert(() => tryPlayWord(conn));
  conn.db.myRack.onUpdate(() => tryPlayWord(conn));
  conn.db.matchState.onUpdate((_c, _o, n) => {
    if (n.status.tag === "Running" && n.bagTotal === 0) tryPlayWord(conn);
  });
  conn.db.botCredential.onInsert(() => {
    if (myBotId === null) myBotId = resolveMyBotId(conn);
  });
  conn.db.auctionResult.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    console.log(
      `[${BOT_NAME}] match ${r.matchId} auction ${r.auctionId} '${r.letter}' → bot ${winner} paid ${r.paid}`,
    );
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.matchState.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.matchParticipant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        const me = participantForMatch(conn, neu.id);
        console.log(`[${BOT_NAME}] match ${neu.id} ended (score ${me?.score ?? "?"}); rejoining lobby`);
        writeMatchLog(conn, neu.id);
        joinLobby(conn);
        // Free that match's rows a bit later.
        setTimeout(() => unwatchMatch(neu.id), 5000);
      }
    }
  });
}

// NO_REJOIN=1: finish any running match, then stay out of the lobby (pause).
const NO_REJOIN = process.env.NO_REJOIN === "1";

function joinLobby(conn: DbConnection) {
  if (myBotId === null) return;
  if (NO_REJOIN) {
    console.log(`[${BOT_NAME}] NO_REJOIN set: not joining the lobby`);
    return;
  }
  const inRunning = Array.from(conn.db.matchParticipant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.matchState.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) return;
  const alreadyIn = Array.from(conn.db.openLobbyMembers.iter()).some(
    (lm) => lm.botId === myBotId,
  );
  if (alreadyIn) return;
  console.log(`[${BOT_NAME}] joining lobby`);
  conn.reducers.joinLobby({}).catch(logFailure("joining the lobby"));
}

// Our own participant rows (small), then the latest match in detail.
function subscribeMine(conn: DbConnection) {
  const botId = myBotId!;
  conn
    .subscriptionBuilder()
    .onApplied(() => {
      let latest: bigint | null = null;
      for (const p of conn.db.matchParticipant.iter())
        if (p.botId === botId && (latest === null || p.matchId > latest)) latest = p.matchId;
      if (latest !== null && latest > newestMatch) newestMatch = latest;
      if (latest !== null) watchMatch(conn, latest, () => bootstrapActivity(conn));
      else bootstrapActivity(conn);
    })
    .onError((ctx) => console.error(`[${BOT_NAME}] subscription error`, ctx.event))
    .subscribe([tables.matchParticipant.where((r) => r.botId.eq(botId))]);
}

let newestMatch = 0n;

// ---- Match log: one JSON line per finished match, for post-mortems ----
const LOG_DIR = path.join(process.cwd(), "logs");
const bidLog = new Map<string, unknown[]>();
function logBid(matchId: bigint, entry: unknown) {
  const k = String(matchId);
  if (!bidLog.has(k)) bidLog.set(k, []);
  bidLog.get(k)!.push(entry);
}
function writeMatchLog(conn: DbConnection, matchId: bigint) {
  try {
    const k = String(matchId);
    const scores = [...conn.db.matchParticipant.iter()]
      .filter((p) => p.matchId === matchId)
      .map((p) => ({ bot: Number(p.botId), score: Number(p.score), balance: Number(p.balance) }))
      .sort((a, b) => b.score - a.score);
    const words = [...conn.db.wordPlay.iter()]
      .filter((w) => w.matchId === matchId)
      .map((w) => ({ bot: Number(w.botId), word: w.word, pts: Number(w.totalReward) }));
    const auctions = [...conn.db.auctionResult.iter()]
      .filter((r) => r.matchId === matchId)
      .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1))
      .map((r) => ({ l: r.letter, w: r.winnerBotId == null ? null : Number(r.winnerBotId), paid: Number(r.paid) }));
    const place = scores.findIndex((x) => x.bot === Number(myBotId)) + 1;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(LOG_DIR, "matches.jsonl"),
      JSON.stringify({ match: k, at: new Date().toISOString(), me: Number(myBotId), place,
        params: brain.p, scores, words, auctions, bids: bidLog.get(k) ?? [] }) + "\n",
    );
    bidLog.delete(k);
    console.log(`[${BOT_NAME}] match ${k}: placed ${place}/${scores.length} (logged)`);
  } catch (e) {
    console.warn(`[${BOT_NAME}] match log failed`, e);
  }
}
const watched = new Map<string, { unsubscribe(): void }>();
function watchMatch(conn: DbConnection, matchId: bigint, then?: () => void) {
  const key = String(matchId);
  if (watched.has(key)) return then?.();
  const handle = conn
    .subscriptionBuilder()
    .onApplied(() => {
      console.log(`[${BOT_NAME}] watching match ${matchId}`);
      if (then) then();
      else {
        for (const a of conn.db.auction.iter())
          if (a.matchId === matchId && a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
        tryPlayWord(conn);
      }
    })
    .onError((ctx) => console.error(`[${BOT_NAME}] match ${matchId} subscription error`, ctx.event))
    .subscribe([
      tables.matchState.where((r) => r.id.eq(matchId)),
      tables.matchParticipant.where((r) => r.matchId.eq(matchId)),
      tables.auction.where((r) => r.matchId.eq(matchId)),
      tables.auctionResult.where((r) => r.matchId.eq(matchId)),
      tables.wordPlay.where((r) => r.matchId.eq(matchId)),
    ]);
  watched.set(key, handle);
}
function unwatchMatch(matchId: bigint) {
  const key = String(matchId);
  try {
    watched.get(key)?.unsubscribe();
  } catch {}
  watched.delete(key);
}

function bootstrapActivity(conn: DbConnection) {
  if (TOURNAMENT_ID) {
    conn.reducers
      .registerForTournament({ tournamentId: BigInt(TOURNAMENT_ID) })
      .then(() =>
        console.log(`[${BOT_NAME}] registered for tournament ${TOURNAMENT_ID}`),
      )
      .catch(logFailure(`registering for tournament ${TOURNAMENT_ID}`));
  }
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") tryBid(conn, a.id, a.matchId, a.letter);
  }
  tryPlayWord(conn);
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(BOT_TOKEN ?? loadToken())
    .onConnect(onConnect)
    // Never sit idle while seated: a dropped bot loses every auction. Exit and
    // let scripts/live.sh restart us; on reconnect we resume the running match
    // and re-register for the tournament.
    .onConnectError((_ctx: ErrorContext, err: Error) => {
      console.error("connect error:", err.message);
      setTimeout(() => process.exit(1), 1000);
    })
    .onDisconnect(() => {
      console.log("disconnected; exiting so the wrapper reconnects");
      setTimeout(() => process.exit(1), 500);
    })
    .build();
}

main();
