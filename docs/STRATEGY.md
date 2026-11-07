# Strategy

Everything here comes from reading the server source (`spacetimedb/src/game.ts` in
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot)) and then testing.
All code is in `bot/src/brain.ts` unless noted.

## The rules that matter

| Rule (from `game.ts`) | Consequence |
|---|---|
| Coins and score are separate; playing a word adds to both, spending only lowers coins. | **Coins aren't points.** Leftover coins are worth 0 at the end. Spend them. |
| 1x for ≤3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, 3x at 7+ letters. | **Long words dominate.** One 7-letter word beats several short ones. |
| The match ends when the last auction closes. | The last tile can never be played: **bid 0**. |
| Tiles left in a rack at the end score nothing. | **Dump everything** when the last auction opens. |
| Vickrey (default): the winner pays the runner-up's bid. Bids are capped at balance and replaceable until close. | Bidding true value is safe, and late re-bids are free. |
| Every auction winner, paid price and played word is public. | We can **track every rival's letters** and the going price. |
| Sim bots bid face value −1 / +0 / +2..4 (±2 jitter) and play their longest word right away. | They're easy to beat and predictable. |

## Tile valuation

`Brain.marginal()`: a Monte Carlo estimate of how much a letter raises our score.

1. Pool = full bag − every auctioned letter − our starting rack − rival starting tiles
   already revealed in their words.
2. Sample `m` future tiles we expect to win (`futureShare` × tiles left, capped at `maxFuture`).
3. Value = average over 24 samples of `best2(rack + future + letter) − best2(rack + future)`,
   where `best2` is the best word plus the best word from what's left.

**Budget-aware** (`budgetAware`, on): after a tentative bid, how many more tiles could we still
afford at market price? If fewer than `m`, re-value with that many. This stops 50-coin bids on
a Z that we can't afford to build a word around.

The word search is a pruned DFS over an anagram trie of sorted letter keys
(`engine.ts`), so each bid takes about 1–10 ms.

## Bidding

```
bid = value × bidMult × pace
pace = clamp( (affordable / marketPrice) ^ paceGamma, paceLo, paceHi )
affordable = balance / (paceShare × tiles left)
marketPrice = mean price paid over the last 12 sold auctions
```

- **Pacing** adapts to the lobby. In cheap lobbies (sims) it bids harder; in expensive
  all-real-bot lobbies (12–16 coins/tile) it drops to about 1.8x. It steers toward spending
  the whole budget.
- **Cap:** at most `capEarly` (50%) of the balance on one tile at the start of the match,
  loosening to 100% by the end.
- **Spend-down:** in the last `endgameAt` (6) auctions, bid at least
  `balance / (0.5 × tiles left)`, even on tiles we can't use. Coins are worthless soon, and
  winning a tile at least denies it to a rival.
- **Need tiles:** if the rack is too short for a 7-letter word and we have more than 2x
  the market price in coins, bid at least `needFloor` (0.8) x market on any useful tile.
- **First-price** (if a tournament uses it): bid `min(fpShade x bid, letter market + fpOver)`
  = `min(0.7 x bid, market + 5)`.
- **Final auction:** bid 0.
- **Fallback bid:** the live client sends a face-value bid instantly, then replaces it with
  the computed bid, so the 1-second window is never missed.

## Word timing

`Brain.decideWords()`:

- Hold tiles until a word of `minPlayLen` (7) letters exists. Among candidates, pick
  `score + 0.35 × best word left over`.
- Allow 5-letter words when coins drop below `liquidityFloor` (6) or the rack reaches
  `clogSize` (12). Allow 6-letter words when fewer than 8 tiles are left in the bag.
- **Final dump:** when the last auction opens (`bagTotal == 0`), play the **optimal
  partition** of the rack into words (`Lexicon.partition`, a memoised exact search).

## Rival model (built, off by default)

`View.rivals` (live: `buildView` in `index.ts`):

- Each rival's **known letters** = letters won at auction − letters played.
- Their **hidden** count = 5 starting tiles − starting tiles revealed in their words.

`Brain.denialBid()` estimates a letter's value to each rival who is level with or ahead of us,
and bids up to what they would pay. In this auction format, **blocking and price-pushing are
the same bid**: either we win the tile (blocked) or they pay at least our bid (taxed).

Testing so far: blocking all match long costs us liquidity and loses. Half-strength blocking
of leaders may help (39% vs 34% in mixed lobbies), but that's within noise. See RESULTS.md.

## Parameters

Defaults live in `DEFAULT_PARAMS` (`brain.ts`). Override them live with `BOT_PARAMS`.

| Param | Default | Notes |
|---|---|---|
| `bidMult` | 3 | Base multiplier on tile value. |
| `paceGamma` / `paceShare` / `paceLo` / `paceHi` | 0.5 / 0.25 / 0.6 / 1.8 | Budget pacing. |
| `capEarly` | 0.5 | Max share of balance on one tile, early in the match. |
| `budgetAware` | 1 | Re-value with the tiles we could still afford. |
| `endgameAt` / `endShare` | 6 / 0.5 | Spend-down. |
| `minPlayLen` | 7 | Hold out for this length. |
| `mcSamples` / `futureShare` / `maxFuture` | 24 / 0.3 / 5 | Valuation sampling. |
| `denial` / `denyAt` / `threatMargin` / `rivalMult` | 0 / 99 / 25 / 2 | Rival blocking (off). |
| `liqMarket` / `liqMinLen` | 0 / 5 | Market-relative cash floor (off, neutral in testing). |
| `needFloor` | 0.8 | Bid at least this x market when the rack is too short. |
| `fpShade` / `fpOver` | 0.7 / 5 | First-price shading. |
| `hvTilt` | 0 | Bonus for high-value letters (off, slightly negative). |
| `choiceAware` | 0 | "Pick k of n upcoming tiles" valuation (off, negative). |
