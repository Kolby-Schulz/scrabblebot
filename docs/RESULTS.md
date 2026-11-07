# Results

Simulator numbers are win % for the tested variant. Even share is **17%** in `self`
(5 copies of our bot) and **33%** in `mixed` (3 copies of our bot). At 80–200 matches,
anything within about ±5 points is noise.

## Live (LexiconWarrior, bot id 181)

All lobbies were real bots: GodOfThudner, Bron, StickBot, Odysseus's Voyage, Tow57-Auctioneer
and others.

| Build | Matches | Placements |
|---|---|---|
| Pacing, before the spend-down fix | 3 | 1, 1, 3 |
| + spend-down, cash fixes | 14 | 2, 3, 3, 5, 2, 1, 3, 1, 5, 1, 2, 1, 4, 4 |
| + budget-aware valuation (current) | 10 | 2, 2, 3, 1, 1, 1, 2, 3, 5, 3 |

**Total: 27 matches, 9 wins, 22 top-3 finishes.** The best match scored 158 (won by 51).

What we learned live:
- All-real-bot lobbies pay 10–17 coins per tile (sims pay about 5). Pacing drops to ~1.8x there.
- The worst result (39 points) came from a 53-coin Z that never became a word. That led to
  budget-aware valuation.
- GodOfThudner wins by buying high-value letters (Y, K, H, P, Z) and making WHEYFACE-type
  words. Bron often ends with 60 coins unspent and still scores high, because it buys cheap.

## Simulator history

### 1. Bid multiplier (fixed)
| vs. field | 1.0x | 1.4x | 2x | 2.5x | 3x | 4x |
|---|---|---|---|---|---|---|
| copies at 1.0x | 23% | **97%** | | | | |
| copies at 1.4x | | 18% | **92%** | | 68% | |
| copies at 2.5x | | | | ~20% | 12% | 2% |

The equilibrium was about 2.5x. Under-bidding is the classic mistake.

### 2. Word timing and caps (vs. copies)
- `minPlayLen` 6 → 0%, **7 → base**, 8 → 10%.
- `capEarly` 0.5 slightly better than 0.35. More MC samples: no gain, up to 15x slower.

### 3. Budget pacing (now on)
| Opponents | Fixed 2.5x | Pacing @2.5x | **Pacing @3x** |
|---|---|---|---|
| fixed 1.5x | 59% | 93% | 83% |
| fixed 2.5x | 16% | 30% | 39% |
| fixed 3.5x | 70% | 89% | 84% |
| pacing @3x | — | 13% | 26% |
| sims (avg score) | 330 | 350 | — |

### 4. Spend-down over the last 6 auctions (now on)
18–19% vs 14% base (copies, 120 matches).

### 5. Budget-aware valuation (now on)
| Field | Base | **Budget-aware** |
|---|---|---|
| mixed (200 matches) | 32% | **44%** (avg 133 vs 126) |
| self (200 matches) | 16% | 18% |

### 6. Rival blocking (off)
| Variant | mixed | self |
|---|---|---|
| always, full strength | 20% (base 34%) | 13% (base 18%) |
| last 6 auctions | 27–34% (base 32–33%) | 19–25% (base 13–16%) |
| leaders only, last 6 | 31% (base 34%) | 19% (base 18%) |
| **leaders only, half strength** | **39%** (base 34%), margin −12 vs −21 | not tested |

### 7. Other ideas tested (all off)
| Idea | mixed result (base 33–34%) |
|---|---|
| Market-relative cash floor | 33% (neutral) |
| + allow 4-letter words when broke | 31% |
| High-value letter tilt 0.5 / 1.0 | 29% / 29% |
| Choice-aware valuation | 16% (11% at 3x pool) |
| Choice-aware at 5x bids | 23% |
