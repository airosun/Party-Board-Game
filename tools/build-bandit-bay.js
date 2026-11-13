// Generates server/boards/bandit-bay.json. Run: node tools/build-bandit-bay.js
// Lay out paths as polylines + a list of space types; nodes are spaced evenly along them.
const fs = require('fs');
const path = require('path');

// Evenly place n nodes along a polyline (includes the first point, excludes the last)
function along(points, n) {
  const segs = [];
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segs.push({ a, b, len, start: total });
    total += len;
  }
  return Array.from({ length: n }, (_, k) => {
    const d = (total * k) / n;
    const s = segs.find(sg => d <= sg.start + sg.len) || segs[segs.length - 1];
    const t = (d - s.start) / s.len;
    return [Math.round(s.a[0] + (s.b[0] - s.a[0]) * t), Math.round(s.a[1] + (s.b[1] - s.a[1]) * t)];
  });
}
// Same but excluding the first point too (for branches between two existing spaces)
const between = (points, n) => along(points, n + 1).slice(1);

const L = 220, R = 1700, T = 170, B = 910;
const types = s => s.trim().split(/\s+/);

// Main loop, clockwise from START
const mainTypes = [
  // top: left → right (13)
  ...types('start blue blue event shop blue blue lucky red blue blue event blue'),
  // right: top → bottom (6)
  ...types('chance blue vs blue red blue'),
  // bottom: right → left (13)
  ...types('blue event blue shop blue badluck blue bank blue red lucky blue event'),
  // left: bottom → top (6)
  ...types('blue blue red vs event blue'),
];
const mainPts = [
  ...along([[L, T], [R, T]], 13),
  ...along([[R, T], [R, B]], 6),
  ...along([[R, B], [L, B]], 13),
  ...along([[L, B], [L, T]], 6),
];

const nodes = mainPts.map(([x, y], i) => ({ id: i, type: mainTypes[i], x, y, next: [(i + 1) % mainPts.length] }));
// Add a branch path from one existing space to another. The space at fromId becomes a fork.
const add = (pts, tps, fromId, toId, labelFrom, labelTo) => {
  if (pts.length !== tps.length) throw new Error(`branch from ${fromId}: ${pts.length} points but ${tps.length} types`);
  const ids = pts.map((_, k) => nodes.length + k);
  pts.forEach(([x, y], k) => nodes.push({ id: ids[k], type: tps[k], x, y, next: [k < pts.length - 1 ? ids[k + 1] : toId] }));
  const from = nodes[fromId];
  from.next.push(ids[0]);
  from.labels = { [from.next[0]]: labelFrom, [ids[0]]: labelTo };
  return ids;
};

// Risky shortcut straight down the middle: top node 6 → bottom node 26 (the Bank)
const sTop = nodes[6], sBot = nodes[26];
add(between([[sTop.x, sTop.y], [sBot.x, sBot.y]], 5), types('red badluck chance red badluck'),
  6, 26, 'Main road ➡️', 'Shortcut ⬇️ (risky)');

// Bandit's Hideout: a detour off the left side, node 33 → node 37
const dA = nodes[33], dB = nodes[37];
add(between([[dA.x, dA.y], [420, 760], [540, 540], [420, 320], [dB.x, dB.y]], 7),
  types('red event blue bandit lucky red blue'),
  33, 37, 'Main road ⬆️', "Bandit's Hideout ➡️ (longer)");

// Treasure Trail: from the middle of the shortcut (the Chance space) across to the right side.
// Avoids the shortcut's last Bad Luck space but drops you back on the main loop.
add(between([[nodes[40].x, nodes[40].y], [nodes[16].x, nodes[16].y]], 5), types('blue lucky event blue red'),
  40, 16, 'Keep going ⬇️ (to the Bank)', 'Treasure Trail ➡️');

// Coin Cliffs: a longer, safer loop around the outside of the right side (node 14 → node 18)
add(between([[nodes[14].x, nodes[14].y], [1815, 370], [1840, 540], [1815, 710], [nodes[18].x, nodes[18].y]], 5),
  types('blue blue lucky blue blue'),
  14, 18, 'Main road ⬇️ (VS + Red)', 'Coin Cliffs ↘️ (longer, safer)');

// Back Alley: dips under the Bank so you skip the toll, but you can't cash it out either
add(between([[nodes[25].x, nodes[25].y], [960, 1012], [846, 1012], [nodes[27].x, nodes[27].y]], 2),
  types('red blue'),
  25, 27, 'Main road ⬅️ (Bank)', 'Back Alley ↙️ (skip the Bank)');

const board = {
  id: 'bandit-bay',
  name: 'Bandit Bay',
  description: 'Big board with 5 forks: risky shortcut, Treasure Trail, Coin Cliffs, Back Alley and the Bandit\'s Hideout',
  width: 1920,
  height: 1080,
  startNodeId: 0,
  dicePos: [1300, 760],
  // Text drawn on the board (decoration only)
  decor: [
    { text: 'Bandit Bay', x: 1300, y: 360, size: 64, alpha: 0.25 },
    { text: 'Treasure Trail', x: 1300, y: 495, size: 20, alpha: 0.5 },
    { text: 'Coin Cliffs', x: 1835, y: 290, size: 18, alpha: 0.5 },
    { text: 'Back Alley', x: 903, y: 1060, size: 16, alpha: 0.5 },
    { text: "◀ Bandit's Hideout", x: 680, y: 540, size: 22, alpha: 0.8 },
    { text: 'Shortcut ▼', x: 1000, y: 330, size: 20, alpha: 0.5 },
  ],
  nodes,
};
const out = path.join(__dirname, '..', 'server', 'boards', 'bandit-bay.json');
fs.writeFileSync(out, JSON.stringify(board, null, 1));
const count = {};
nodes.forEach(n => { count[n.type] = (count[n.type] || 0) + 1; });
console.log(`wrote ${nodes.length} nodes`, count);
