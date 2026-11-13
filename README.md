# 🎲 Party Board

A Mario Party-style online board game. The **host screen** (TV or laptop) shows the board and minigames; everyone plays on their **phone** as a controller.

## Run it

```bash
npm install
npm start          # http://localhost:3000
```

- Open `http://localhost:3000/host.html` on the TV/laptop. It shows a 4-letter room code.
- On each phone, open `http://<your-computer's-LAN-IP>:3000/play.html` and enter the code. Or once deployed, just the Render URL.
- Pick the number of turns and hit **Start game**.

`npm run dev` restarts on file changes. `npm run simulate` plays a full game with 3 bots at 20× speed, which makes a handy smoke test after changes.

## Deploy to Render

New Web Service → this repo → Build `npm install`, Start `npm start`. WebSockets work out of the box. (Free tier sleeps when idle, so the first load takes a moment.)

## What's in the box

| | |
|---|---|
| Lobby | Room codes, up to 4 players, auto-reconnect when a phone locks/refreshes, host survives a page refresh |
| Board | JSON graph with a branching path (junction choice on phone) and 9 space types (see below) |
| Items | Bought at Item Shops, used on your phone before rolling (one per turn, bag holds 3) |
| Star | Buy it for 20 coins as you **pass** it, then it moves somewhere new |
| Turn loop | Roll 1–10 → hop space by space → land effect → next player |
| Minigames | Run after every round. **Mash Mania** (tap race) and **Quick Draw** (reaction). Rewards 10/5/3/0 coins |
| Ending | 3 bonus stars (Minigame, Coin, Unlucky), final standings, **Play again** |
| AFK safety | Disconnected players get auto-rolled; prompts auto-answer after 30s |

## Spaces

| Space | Pass | Land |
|---|---|---|
| 🔵 Blue | n/a | +3 coins (**+6 in the last 5 turns**) |
| 🔴 Red | n/a | −3 coins (**−6 in the last 5 turns**) |
| 🛒 Item Shop | Buy one item if you can afford the cheapest. Not a real space: costs no step, can't stop on it | n/a |
| 🍀 Lucky | n/a | Good roulette: +10, +20, free item, leader pays you 10 |
| 💀 Super Bad Luck | n/a | Bad roulette: −10, lose half your coins, pay everyone 5, give last place 10, Star moves, lose a Star |
| ⚔️ VS | n/a | Roulette picks a wager (5–20), everyone pays into a pot, minigame, winner takes the pot. **Space turns Blue afterwards** |
| 🏦 Bank | Pay 5 coins into the Bank | Take everything in the Bank |
| ❗ Chance | n/a | Two random players: swap coins / Stars / spaces, or one pays the other 10 |
| ⭐ Star | Buy for 20 coins as you pass (sits on a Blue space) | same |

## Items

| Item | Price | Effect |
|---|---|---|
| 🎯 Custom Dice | 5 | Pick your roll (1–10) |
| 🎲 Double Dice | 10 | Roll two dice and add them |
| 🌀 Warp Block | 10 | Swap places with a random player |
| 🟡 Golden Pipe | 25 | Warp straight to the Star (then roll as normal) |

## How it's built

```
server/
  index.js          Express + Socket.IO, rooms, routes events to the game
  game.js           ★ the state machine: turn flow, movement, roulette, minigame payouts
  spaces.js         every space type: onPass / onLand rules + colours/icons
  items.js          item catalog (prices, names); effects are in Game.useItem()
  boards/classic.json
  minigames/        one file per minigame + index.js registry
public/
  host.html  js/host.js  js/board-scene.js   (Phaser board + DOM sidebar/overlays)
  play.html  js/play.js                      (phone controller)
test/simulate.js    bot game for smoke testing
```

**The server is the only source of truth.** Phones send *intents* (`roll`, `choose`, `minigame` input); `game.js` checks them against the current phase, updates state, and broadcasts one `state` object to every screen. Screens just render it.

Phases: `LOBBY → ROLL → MOVING (↔ JUNCTION / STAR_PROMPT) → … → MINIGAME_INTRO → MINIGAME → MINIGAME_RESULTS → … → GAME_OVER`

## Adding stuff

**A space type**: add an entry to `server/spaces.js` with `name`, `color`, `icon`, `desc` and an `onLand` and/or `onPass` hook (`passOnly: true` for shop-style spaces). The board and legend pick it up automatically. Then use the type in the board JSON. Odds for roulette spaces are the `weight` values.

**An item**: add it to `server/items.js`, then its effect in `useItem()` in `game.js`.

**A board**: copy `classic.json`. Each node is `{ id, type, x, y, next: [...] }` on a 1280×720 canvas. Multiple `next` ids = a junction; `labels` names the choices shown on the phone.

**A minigame**:
1. Copy `server/minigames/mash.js`. Fill in `setup`, `start`, `onInput`, `publicState`, `getResults`, and set `better: 'higher' | 'lower'`.
2. Register it in `server/minigames/index.js`.
3. Phone controls: reuse `controls: 'mash'` or `'reaction'`, or add a new branch in `buildActions()` in `play.js`.
4. Host live view: add a case in `renderLive()` in `host.js`.

Tip: favour minigames where lag doesn't matter (totals, one-shot choices, locally timed reactions) over real-time movement/physics.

## Suggested next steps

1. **1v3 / 2v2 minigames**: record the colour of the space each player landed on, then pick teams from that.
2. **More minigames**: hidden-door pick (great for 1v3), timing bar, memory sequence, trivia.
3. **Polish**: character sprites instead of circles, sounds, camera pan to the active player, dice-roll animation.
4. **CPU players** to fill empty seats.
