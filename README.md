# LexiconWarrior

A competitive bot for **[ScrabbleBot](https://scrabblebot.spacetimedb.com)**, the SpacetimeDB
challenge at HackUTD. Each round, a letter is sold in a 1-second sealed-bid auction. Bots
spell dictionary words from the letters they've bought, and the highest score when the bag
runs out wins.

**Live record (all-real-bot lobbies): 27 matches, 9 wins, 22 top-3 finishes.**

| | |
|---|---|
| How the bot thinks | [docs/STRATEGY.md](docs/STRATEGY.md) |
| Every experiment and live result | [docs/RESULTS.md](docs/RESULTS.md) |
| Tournament-day checklist | [docs/TOURNAMENT.md](docs/TOURNAMENT.md) |

## Quickstart

Requires Node 20+ (see `.nvmrc`).

```bash
cd bot
npm install
BOT_NAME=ruthless BOT_TOKEN=<token from scrabblebot.spacetimedb.com/team> npm start
```

The first run saves the token to `bot/.token-<BOT_NAME>` (gitignored). After that:

```bash
cd bot && BOT_NAME=ruthless npm start
```

> **Only one copy of the bot may run at a time.** Two processes using the same bot
> identity send conflicting bids and words. Agree on whose machine runs it.

## Commands

All of these run from `bot/`.

| Command | What it does |
|---|---|
| `npm start` | Play live: join the lobby, play every match, rejoin after each. |
| `npm run pause` | Finish the match in progress, then stay out of the lobby. |
| `TOURNAMENT_ID=<id> npm start` | Register for a tournament and play it. |
| `npm run sim -- <N> '<variants>' <field> '<fieldParams>'` | Offline simulator (see below). |
| `npm run typecheck` | Type-check everything. |

Environment variables:

| Variable | Meaning |
|---|---|
| `BOT_NAME` | Local name; picks which `.token-<name>` file to use. |
| `BOT_TOKEN` | Token from the team page (first run only). |
| `TOURNAMENT_ID` | Register for this tournament on connect. |
| `NO_REJOIN=1` | Don't join the lobby (what `npm run pause` sets). |
| `BOT_PARAMS` | JSON overrides for strategy params, e.g. `'{"bidMult":2.8}'`. |

### Simulator

`bot/src/sim.ts` copies the server's rules (`game.ts`) and pits strategy variants against
an opponent field:

```bash
# 150 matches each: current defaults vs a variant, in a mixed lobby
npm run sim -- 150 '{"base":{},"bid2.5":{"bidMult":2.5}}' mixed '{}'
```

| Field | Opponents |
|---|---|
| `sims` | The server's simulated bots plus the starter bot. |
| `self` | 5 copies of our bot (params from the last argument). |
| `mixed` | 2 copies of our bot, the starter bot, 2 sims. |

An even share is 17% wins in `self` and 33% in `mixed` (3 copies of our bot).

## Repository layout

```
bot/
  src/
    engine.ts          word engine: anagram trie, best word, optimal rack partition
    brain.ts           strategy: tile valuation, bidding, word timing, rival model
    index.ts           live client: subscriptions, bids, words, match logs
    sim.ts             offline match simulator
    module_bindings/   generated SpacetimeDB client bindings (do not edit)
  wordlist.txt         the server's dictionary (172k words)
  logs/                per-match JSONL logs from live play (gitignored)
docs/                  strategy, results, tournament checklist
```

`upstream/` (gitignored) is an optional local clone of
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot), the server source.
You only need it to regenerate bindings (`npm run generate`).

## Working on it

- Branch from `main`, open a PR, and include sim numbers for any strategy change (at least
  150 matches; anything under about ±5 win-% is noise).
- New strategy ideas go in as params in `brain.ts`, **off by default**, and get turned on
  only after they beat the current defaults in the simulator. Then check them live.
- Restart the live bot between matches, not during one. Use `npm run pause`, wait for
  `placed N/6`, then restart.

## Credits

The live client began as the starter kit from
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot). The bindings
and word list come from that repo too. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
