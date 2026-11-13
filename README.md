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
| Players | Always 4. Empty seats are filled with **CPU players** when the host hits Start |
| Roll-off | Everyone rolls 1–10 to set turn order. A number can only be rolled once, so no ties |
| Boards | **Bandit Bay** (65 spaces + Start, 5 forks incl. a locked gate, default) and **Coin Cove**. Host picks in the lobby |
| Star | Sits on the **path between two spaces** (not on a space). Walk past it to buy for 20 coins, then it moves |
| Items | Bought at Item Shops, won from Lucky / Item spaces, used on your phone before rolling (one per turn, bag holds 3) |
| Minigames | 41 of them, after every round. **Free-for-all, 2v2 or 1v3** depending on the space colors everyone landed on. Flow: teams screen (green players get randomized on screen) → rules screen where everyone taps **Ready** → play → results, then **Player 1** taps **Next** |
| Turns | A big **TURN 3** splash starts each round. After moving, each player taps **End turn** to pass to the next player. During any decision, **🗺️ View board** shows the whole board on your phone (and the TV zooms out) |
| Player 1 | The first person to join (👑). They tap Next after minigames. If they drop, anyone can |
| Look | The board is drawn as an island: beaches, grass, sandy roads, palm trees, boats and drifting clouds. Spaces are glossy 3D discs, shops and the Bandit are wooden signposts, players are pawns, the camera zooms in to follow whoever is moving. Game fonts (Lilita One + Nunito), title screen with seats, prize-wheel roulette, podium results, confetti |
| Animations | Big dice roll on the TV and your phone, floating +/− coins, item and Star pop-ups, flashing token for whoever's turn it is, big announcements (robberies, Stars, item uses) |
| Turn counter | Big "TURN 3 / 10 · 7 turns left" on the TV; turn pill on phones; LAST TURN warning |
| No time limits | Nobody gets auto-skipped. After 1 minute of waiting, other players get a **👉 Nudge** button (once each per turn) that pops up on the slow player's phone and vibrates it |
| Last turn | Shops closed, Item spaces empty, Lucky spaces can't give items |
| Ending | Each bonus Star revealed one at a time (drumroll!), then standings revealed from 4th up to the winner, then a full **stats table** (rolls, spaces, coins earned/lost/spent/stolen, items, minigame wins); each phone shows your own stats |
| Reconnects | Phones rejoin automatically after locking/refreshing; a dropped player's decisions are auto-picked so the game never freezes |

## Spaces

Colors: **blue** = Blue, Lucky, VS, Chance · **red** = Red, Super Bad Luck · **green** = ?, Bank, Item · **purple** = Bandit. The icon tells same-colored spaces apart.

| Space | Pass | Land |
|---|---|---|
| 🔵 Blue | n/a | +3 coins (**+6 in the last 5 turns**) |
| 🔴 Red | n/a | −3 coins (**−6 in the last 5 turns**) |
| 🛒 Item Shop | Buy one item if you can afford the cheapest. Not a real space: costs no step, can't stop on it | n/a |
| 🍀 Lucky | n/a | Good roulette: +10, +20, free item, leader pays you 10 |
| 💀 Super Bad Luck | n/a | Bad roulette: −10, lose half your coins, pay everyone 5, give last place 10, Star moves, lose a Star |
| ⚔️ VS | n/a | Roulette picks a wager (5–20), everyone pays into a pot, free-for-all minigame. Pot split **90% / 9% / 1% / 0%** by place. **Space turns Blue afterwards** |
| 🏦 Bank | Pay 5 coins into the Bank | Take everything in the Bank (all Banks share one pot) |
| 🎁 Item Space | n/a | Random item (odds = 1/price, so cheap items are common; rare items only after halfway) |
| 🔃 Chance | n/a | Three wheels: player 1, player 2, then what happens (swap coins / Stars / spaces, or one pays the other 10) |
| ❓ ? Space | n/a | Launches you 1–5 spaces forward along the main road. Nothing triggers on the way or where you land |
| 🦹 Bandit | Must pick one: steal 8–20 coins (free) **or** steal a Star (50 coins, greyed out if you can't afford it or nobody has one). Then pick a victim or 🎲 Random. Not a real space: costs no step | n/a |
| ⭐ Star | Sits on the path between two spaces. Buy for 20 coins as you walk past | n/a |

## Items

One item per turn, used before rolling. Bag holds 3: getting a 4th (shop, Lucky, Item space) asks you which one to throw away, including the new one. **Rare** items aren't sold (or given by Lucky) until halfway through the game (turn 6 of 10).

| Item | Price | Effect |
|---|---|---|
| 🐌 Bad Dice | 3 | Pick any player (even you): their next roll is 1–3. Canceled if they use Double / Triple / Custom Dice |
| 🚀 Boost | 3 | +5 to your roll |
| 🗝️ Secret Key | 7 | Passive: lets you open a locked gate (Bandit's Hideout). Used up when you go through |
| 🎲 Double Dice | 8 | Roll two dice and add them |
| 🌀 Warp Block | 10 | Swap places with a random player |
| 🌪️ Twister | 10 | Blow the Star to a new spot |
| 🎯 Custom Dice | 12 | Pick your roll (1–10) |
| 🎰 Triple Dice | 15 | Roll three dice and add them |
| 🦹 Bandit Call *(rare)* | 25 | Meet the Bandit right now |
| 🟡 Golden Pipe *(rare)* | 25 | Warp to the space just before the Star (you still have to roll past it) |

## Minigames

Teams come from the color of the space each player landed on that round (**blue** = Blue/Lucky/VS/Chance, **red** = Red/Super Bad Luck; **green** spaces get randomly counted as red or blue). 4 of one color → free-for-all; 3–1 → 1v3; 2–2 → 2v2. Team score = average of the team members' scores (some team games score teams directly). Rewards: free-for-all 10/5/3/0 coins; team games 10 coins to each winner (5 each on a tie). The scoreboard shows the color each player landed on this turn.

| Type | Minigames |
|---|---|
| Turn-taking (free-for-all only) | **Key & Door** (pick a key + a door; watch everyone's tries; each escape changes the lock and throws out a wrong key; ends when all but one escape), **Wire Cutter**, **Number Bomb**, **Treasure Chests**, **Memory Match** |
| 1v3 only | **Hide & Seek**, **Bandit Ambush** |
| 2v2 only | **Twin Sync** (tap together), **Math Relay** |
| Teams only (2v2 or 1v3) | Tug of War |
| Free-for-all only | **Balloon Pump** |
| Tap | Mash Mania, Sprint Steps (alternate L/R) |
| Timing | Quick Draw, Perfect Stop, Hold Your Breath, Golden Hold, Blind Timer, Stopwatch, Beat Keeper, Rhythm Rush |
| Phone arcade | Mole Smash, Speed Mole, Bomb Squad, Memory Lane |
| Quick-fire questions | Math Dash, Color Clash, Count Up, Odd One Out, Higher or Lower, Simon Says, Bigger Bet, Pattern Panic, Coin Counter, Door Dash, Even or Odd, Arrow Flip, Bigger Group, Word Scramble, Make Ten, Color Count |

CPU players play every minigame too (decent, not perfect). For testing, `MINIGAME=keyDoor,balloonPump npm start` forces specific minigames whenever the mode allows.

## How it's built

```
server/
  index.js          Express + Socket.IO, rooms, routes events to the game
  game.js           ★ the state machine: turn flow, movement, roulette, minigame payouts
  spaces.js         every space type: onPass / onLand rules + colours/icons
  cpu.js            CPU decisions (which path, what to buy, who to rob, which item to use)
  items.js          item catalog (prices, names); effects are in Game.useItem()
  boards/classic.json
  minigames/        engines.js (game types) + list.js / list2.js (the 41 minigames) + index.js (picking)
public/
  host.html  js/host.js  js/board-scene.js   (Phaser board + DOM sidebar/overlays)
  play.html  js/play.js  js/controls.js      (phone controller + minigame controls)
test/simulate.js    bot game for smoke testing
```

**The server is the only source of truth.** Phones send *intents* (`roll`, `choose`, `minigame` input); `game.js` checks them against the current phase, updates state, and broadcasts one `state` object to every screen. Screens just render it.

Phases: `LOBBY → ROLL → MOVING (↔ JUNCTION / STAR_PROMPT) → … → MINIGAME_INTRO → MINIGAME → MINIGAME_RESULTS → … → GAME_OVER`

## Adding stuff

**A space type**: add an entry to `server/spaces.js` with `name`, `color`, `icon`, `desc` and an `onLand` and/or `onPass` hook (`passOnly: true` for shop-style spaces). The board and legend pick it up automatically. Then use the type in the board JSON. Odds for roulette spaces are the `weight` values.

**An item**: add it to `server/items.js`, then its effect in `useItem()` in `game.js`.

**A board**: each node is `{ id, type, x, y, next: [...] }`. Multiple `next` ids = a junction; `labels` names the choices shown on the phone; `gates: { nextId: 'secretKey' }` locks a path behind an item; `noStar: true` keeps the Star off a space. Hand-write the JSON (see `classic.json`) or generate it like `tools/build-bandit-bay.js` does (`node tools/build-bandit-bay.js`), then list it in `server/boards/index.js`.

**A minigame**: add an entry to `server/minigames/list.js` or `list2.js` using one of the engines in `engines.js` (`quiz` for question streams, `counter` for tapping, `reaction`, `selfReport` for games the phone runs and scores itself, `turnGame` for take-turns games, `guessRounds` for 1v3 hide/guess games, `syncTap`, `balloon`). Set `modes` to choose free-for-all / team play and give it a `cpu` behaviour if the engine needs one. New phone controls go in `public/js/controls.js`.

Tip: favour minigames where lag doesn't matter (totals, one-shot choices, locally timed reactions) over real-time movement/physics.

## Suggested next steps

1. **Sounds**: dice, coins, Star fanfare, minigame countdown.
2. **Character sprites** instead of colored circles.
3. **CPU difficulty** setting in the lobby.
4. **Effects for ? spaces** and more boards.
