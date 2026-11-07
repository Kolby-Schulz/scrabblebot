# Ruthless ScrabbleBot (HackUTD / SpacetimeDB)

## Run it
```bash
cd bot && npm install
BOT_NAME=<name> BOT_TOKEN=<token from scrabblebot.spacetimedb.com/team> npm start
# tournament:
BOT_NAME=<name> TOURNAMENT_ID=<id> npm start
# offline tuning: matches, variants, field ("sims"|"self"), field params
npm run sim -- 50 '{"a":{"bidMult":2.5},"b":{"bidMult":3}}' self '{"bidMult":2.5}'
```
Override live params without code changes: `BOT_PARAMS='{"bidMult":2.8}' npm start`.

## Where the edge comes from (read from the server source, `upstream/spacetimedb/src/game.ts`)
1. **Coins are not score.** Spending never lowers your score; leftover coins are worth 0.
   Most bots bid "face value" and hoard. We bid ~2.5x the tile's computed marginal value.
2. **7+ letters = 3x.** We hold tiles until a 7-letter word appears (relaxed when cash is low,
   rack is clogged, or the bag is nearly empty), instead of dumping 3-letter words.
3. **Exact endgame.** When the last auction opens (`bagTotal == 0`) we play the *optimal
   partition* of the rack into words. Tiles held at the end are worth 0.
4. **Last tile is worthless.** The match ends when the final auction closes, so we bid 0 on it.
5. **Real valuation.** Monte Carlo over the unseen-tile pool (bag minus every auctioned letter
   minus our start rack): E[score with tile] - E[score without], via an anagram trie (~ms).
6. **Sims are fully predictable:** they bid face value -1/+0/+2..4 with ±2 jitter and play the
   *longest* word >=3 immediately, which is exactly what this bot exploits.

## Sim results (bot/src/sim.ts mirrors the server rules)
| Field | Win % | Avg score |
|---|---|---|
| 5 server sim bots + starter bot | 100% | ~330 (live leaders score ~135-170) |
| 5 copies of itself at 2.5x | ~20% (fair share is 17%) | near-equilibrium |
| bidding 1.0x vs 1.4x field | 23% | under-bidding is the classic mistake |

## Next levers if rivals adapt
- Read rivals' `paid` prices live and shift `bidMult` toward the observed equilibrium.
- First-price matches: shading logic exists but is untuned.
- Denial bids on Q/Z/X/J against the current score leader (`denial` param, unused).
