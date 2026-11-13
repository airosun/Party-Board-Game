// Item catalog. Sold at Item Shop spaces, also handed out by Lucky spaces.
// Items are used on your phone before you roll (one per turn).
// The effects themselves live in Game.useItem() / Game.takeTurn() in game.js.
//
// rare: true → not sold (or given by Lucky spaces) until halfway through the game.

const ITEMS = {
  badDice:    { name: 'Bad Dice',    icon: '🐌', price: 3,  desc: 'Pick a player (even you): their next roll is 1–3' },
  boost:      { name: 'Boost',       icon: '🚀', price: 3,  desc: '+5 to your roll' },
  doubleDice: { name: 'Double Dice', icon: '🎲', price: 8,  desc: 'Roll two dice and add them' },
  warpBlock:  { name: 'Warp Block',  icon: '🌀', price: 10, desc: 'Swap places with a random player' },
  customDice: { name: 'Custom Dice', icon: '🎯', price: 12, desc: 'Pick your roll (1–10)' },
  tripleDice: { name: 'Triple Dice', icon: '🎰', price: 15, desc: 'Roll three dice and add them' },
  banditCall: { name: 'Bandit Call', icon: '🦹', price: 25, desc: 'Call the Bandit to steal coins or a Star', rare: true },
  goldenPipe: { name: 'Golden Pipe', icon: '🟡', price: 25, desc: 'Warp straight to the Star', rare: true },
};

// Dice items cancel a Bad Dice curse on the player who uses them
const DICE_ITEMS = new Set(['doubleDice', 'customDice', 'tripleDice']);

const MAX_ITEMS = 3;

module.exports = { ITEMS, DICE_ITEMS, MAX_ITEMS };
