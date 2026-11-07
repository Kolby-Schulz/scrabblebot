# Tournament checklist

Format (from `spacetimedb/src/tournament.ts`): Swiss rounds at tables of about 6, scored by
**finishing place**. The top bots by Swiss points then play elimination matches: each one
knocks out last place until two remain, and three final games decide the champion by total
score. Ties go to the higher total tournament score.

The last tournament (id 1, Oct 25) used **Vickrey** auctions, 4 Swiss rounds and a top cut of 6.

## Before it opens

- [ ] Exactly **one** machine will run the bot. Decide whose.
- [ ] That machine has `bot/.token-ruthless`, or a fresh token from the team page.
- [ ] `git pull` on `main`, then `cd bot && npm install && npm run typecheck`.
- [ ] Laptop is plugged in, sleep is disabled, and the Wi-Fi is stable.

## When registration opens

1. Find the tournament id on https://scrabblebot.spacetimedb.com/tournament.
2. **Check its auction type.** If it is **first-price** (winner pays their own bid), tell the
   team. Our first-price shading is untuned (see `decideBid` in `brain.ts`).
3. If the bot is already running in the lobby, pause it first: `npm run pause`, then wait
   for `placed N/6`. The admin can't start while a registered bot is mid-match.
4. Start it registered:

   ```bash
   cd bot && BOT_NAME=ruthless TOURNAMENT_ID=<id> npm start
   ```

   Look for `registered for tournament <id>` in the log.

## During

- **Stay connected.** A registered bot that's offline still gets seated and loses every
  auction it doesn't bid in.
- Don't restart mid-match. If you must, restart immediately: the bot picks a running match
  back up on reconnect.
- `join_lobby` is refused for entrants until they're knocked out. That's expected.
- Every match is appended to `bot/logs/matches.jsonl`.

## If something breaks

| Symptom | Fix |
|---|---|
| `No bot for this token` | Generate a new token on /team; run once with `BOT_TOKEN=<token>`. |
| JavaScript heap out of memory | Someone re-enabled `subscribeToAllTables`. Don't. |
| `npm` / `node` errors about `libllhttp` | Use `/usr/local/bin` Node: `PATH=/usr/local/bin:$PATH npm start`. |
| Bids logged as "Auction window expired" | Check CPU load (stop simulators) and the network. |
