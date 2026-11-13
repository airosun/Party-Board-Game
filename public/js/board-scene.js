// Phaser scene that draws the board graph and animates player tokens.
// It only renders: all game logic lives on the server.

const SPACE_COLORS = { blue: 0x1982c4, red: 0xe63946, event: 0x8338ec, start: 0xf4f1de };
const TOKEN_OFFSETS = [[-15, -15], [15, -15], [-15, 15], [15, 15]];

class BoardScene extends Phaser.Scene {
  constructor() {
    super('board');
    this.tokens = new Map(); // playerId -> { container, nodeId }
  }

  init(data) {
    this.boardData = data.board;
    this.onReady = data.onReady;
    this.nodes = new Map(this.boardData.nodes.map(n => [n.id, n]));
  }

  create() {
    this.cameras.main.setBackgroundColor('#0d1528');
    this.drawBoard();

    this.star = this.add.text(0, 0, '⭐', { fontSize: '44px' }).setOrigin(0.5).setDepth(5).setVisible(false);
    this.tweens.add({ targets: this.star, scale: 1.15, yoyo: true, repeat: -1, duration: 600 });

    this.diceText = this.add.text(this.boardData.width / 2, this.boardData.height / 2, '', {
      fontSize: '96px', fontStyle: 'bold', color: '#ffca3a', stroke: '#000', strokeThickness: 8,
    }).setOrigin(0.5).setDepth(20);

    this.onReady?.(this);
  }

  drawBoard() {
    const g = this.add.graphics();

    // Paths between spaces, with a small arrow showing direction
    g.lineStyle(10, 0x33415c, 1);
    for (const n of this.boardData.nodes) {
      for (const id of n.next) {
        const m = this.nodes.get(id);
        g.lineBetween(n.x, n.y, m.x, m.y);
      }
    }
    g.fillStyle(0x5c677d, 1);
    for (const n of this.boardData.nodes) {
      for (const id of n.next) {
        const m = this.nodes.get(id);
        const a = Math.atan2(m.y - n.y, m.x - n.x);
        const cx = (n.x + m.x) / 2, cy = (n.y + m.y) / 2, s = 9;
        g.fillTriangle(
          cx + Math.cos(a) * s, cy + Math.sin(a) * s,
          cx + Math.cos(a + 2.4) * s, cy + Math.sin(a + 2.4) * s,
          cx + Math.cos(a - 2.4) * s, cy + Math.sin(a - 2.4) * s,
        );
      }
    }

    // Spaces
    for (const n of this.boardData.nodes) {
      g.fillStyle(0x000000, 0.35).fillCircle(n.x, n.y + 5, 30);
      g.fillStyle(SPACE_COLORS[n.type] ?? 0x999999, 1).fillCircle(n.x, n.y, 30);
      g.lineStyle(4, 0xffffff, 0.85).strokeCircle(n.x, n.y, 30);
      const label = { event: '?', start: 'GO', red: '−', blue: '+' }[n.type];
      if (label) {
        this.add.text(n.x, n.y, label, {
          fontSize: n.type === 'start' ? '20px' : '26px', fontStyle: 'bold',
          color: n.type === 'start' ? '#14213d' : '#ffffff',
        }).setOrigin(0.5);
      }
    }

    this.add.text(24, 20, this.boardData.name, { fontSize: '28px', fontStyle: 'bold', color: '#ffffff' });
  }

  tokenPos(nodeId, index) {
    const n = this.nodes.get(nodeId);
    const [dx, dy] = TOKEN_OFFSETS[index % TOKEN_OFFSETS.length];
    return { x: n.x + dx, y: n.y + dy };
  }

  // Called by host.js whenever the server sends new state
  applyState(s) {
    // Star
    if (s.starNodeId != null && s.phase !== 'LOBBY') {
      const n = this.nodes.get(s.starNodeId);
      this.star.setPosition(n.x, n.y - 48).setVisible(true);
    } else {
      this.star.setVisible(false);
    }

    // Dice: show remaining steps while moving
    this.diceText.setText(s.dice ? String(s.dice.remaining) : '');

    // Tokens
    const seen = new Set();
    s.players.forEach((p, i) => {
      seen.add(p.id);
      let t = this.tokens.get(p.id);
      const pos = this.tokenPos(p.pos, i);
      if (!t) {
        const circle = this.add.circle(0, 0, 15, Phaser.Display.Color.HexStringToColor(p.color).color)
          .setStrokeStyle(4, 0xffffff);
        const initial = this.add.text(0, 0, p.name[0].toUpperCase(), {
          fontSize: '16px', fontStyle: 'bold', color: '#14213d',
        }).setOrigin(0.5);
        const container = this.add.container(pos.x, pos.y, [circle, initial]).setDepth(10);
        t = { container, nodeId: p.pos };
        this.tokens.set(p.id, t);
      } else if (t.nodeId !== p.pos) {
        t.nodeId = p.pos;
        this.tweens.add({ targets: t.container, x: pos.x, y: pos.y, duration: 260, ease: 'Quad.easeOut' });
        // Little hop
        this.tweens.add({ targets: t.container, scale: 1.3, yoyo: true, duration: 130 });
      } else {
        t.container.setPosition(pos.x, pos.y); // e.g. offsets changed after someone left
      }
      t.container.setAlpha(p.connected ? 1 : 0.4);
      t.container.setDepth(p.id === s.turnPlayerId ? 12 : 10);
    });

    // Remove tokens for players who left
    for (const [id, t] of this.tokens) {
      if (!seen.has(id)) { t.container.destroy(); this.tokens.delete(id); }
    }
  }
}
