// Item catalog. Sold at Item Shop spaces, also handed out by Lucky spaces.
// Items are used on your phone before you roll (one per turn).
// The effects themselves live in Game.useItem() in game.js.

const ITEMS = {
  customDice: { name: 'Custom Dice', icon: '🎯', price: 5,  desc: 'Pick your roll (1–10)' },
  doubleDice: { name: 'Double Dice', icon: '🎲', price: 10, desc: 'Roll two dice and add them' },
  warpBlock:  { name: 'Warp Block',  icon: '🌀', price: 10, desc: 'Swap places with a random player' },
  goldenPipe: { name: 'Golden Pipe', icon: '🟡', price: 25, desc: 'Warp straight to the Star' },
};

const MAX_ITEMS = 3;
const CHEAPEST = Math.min(...Object.values(ITEMS).map(i => i.price));

module.exports = { ITEMS, MAX_ITEMS, CHEAPEST };
