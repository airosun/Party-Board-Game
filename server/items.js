// Item catalog. Sold at Item Shops, handed out by Lucky spaces and Item spaces.
// Items are used on your phone before you roll (one per turn).
// The effects themselves live in Game.useItem() / Game.takeTurn() in game.js.
//
// rare: true    → not sold or given out until halfway through the game
// passive: true → can't be "used" from the phone; it works on its own (e.g. opening gates)

const ITEMS = {
  badDice:    { name: 'Bad Dice',    icon: '🐌', price: 3,  desc: 'Pick a player (even you): their next roll is 1–3' },
  boost:      { name: 'Boost',       icon: '🚀', price: 3,  desc: '+5 to your roll' },
  secretKey:  { name: 'Secret Key',  icon: '🗝️', price: 7,  desc: 'Opens locked gates (like the Bandit\'s Hideout)', passive: true },
  doubleDice: { name: 'Double Dice', icon: '🎲', price: 8,  desc: 'Roll two dice and add them' },
  warpBlock:  { name: 'Warp Block',  icon: '🌀', price: 10, desc: 'Swap places with a random player' },
  twister:    { name: 'Twister',     icon: '🌪️', price: 10, desc: 'Blow the Star to a new spot' },
  customDice: { name: 'Custom Dice', icon: '🎯', price: 12, desc: 'Pick your roll (1–10)' },
  tripleDice: { name: 'Triple Dice', icon: '🎰', price: 15, desc: 'Roll three dice and add them' },
  banditCall: { name: 'Bandit Call', icon: '🦹', price: 25, desc: 'Call the Bandit to steal coins or a Star', rare: true },
  goldenPipe: { name: 'Golden Pipe', icon: '🟡', price: 25, desc: 'Warp straight to the Star', rare: true },
};

// Dice items cancel a Bad Dice curse on the player who uses them
const DICE_ITEMS = new Set(['doubleDice', 'customDice', 'tripleDice']);

const MAX_ITEMS = 3;

// Odds for random item drops (Item spaces, Lucky spaces): cheaper = more likely.
// Weight is 1/price, so a 3-coin item is ~8x as likely as a 25-coin one.
const dropWeight = id => 1 / ITEMS[id].price;

module.exports = { ITEMS, DICE_ITEMS, MAX_ITEMS, dropWeight };
