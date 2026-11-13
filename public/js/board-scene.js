// Phaser scene that draws the board graph and animates player tokens.
// It only renders: all game logic lives on the server.

const TOKEN_OFFSETS = [[-15, -15], [15, -15], [-15, 15], [15, 15]];
const hex = c => Phaser.Display.Color.HexStringToColor(c).color;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

class BoardScene extends Phaser.Scene {
  constructor() {
    super('board');
    this.tokens = new Map();    // playerId -> { container, nodeId }
    this.nodeViews = new Map(); // nodeId -> { gfx, label, type }
  }

  init(data) {
    this.boardData = data.board;
    this.spaceTypes = data.spaceTypes; // from server/spaces.js (name, color, icon, passOnly)
    this.onReady = data.onReady;
    this.nodes = new Map(this.boardData.nodes.map(n => [n.id, n]));
  }

  create() {
    this.cameras.main.setBackgroundColor('#0d1528');
    this.drawBoard();

    this.star = this.add.text(0, 0, '⭐', { fontSize: '44px' }).setOrigin(0.5).setDepth(5).setVisible(false);
    this.tweens.add({ targets: this.star, scale: 1.15, yoyo: true, repeat: -1, duration: 600 });

    const bankNode = this.boardData.nodes.find(n => n.type === 'bank');
    this.bankText = bankNode && this.add.text(bankNode.x, bankNode.y + 50, '', {
      fontFamily: FONT, fontSize: '18px', fontStyle: 'bold', color: '#ffb703', stroke: '#000', strokeThickness: 4,
    }).setOrigin(0.5).setDepth(6);

    const [dx, dy] = this.boardData.dicePos || [this.boardData.width / 2, this.boardData.height / 2];
    this.diceText = this.add.text(dx, dy, '', {
      fontFamily: FONT, fontSize: '96px', fontStyle: 'bold', color: '#ffca3a', stroke: '#000', strokeThickness: 8,
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
        if (this.spaceTypes[m.type]?.passOnly || this.spaceTypes[n.type]?.passOnly) continue; // too tight for arrows
        const a = Math.atan2(m.y - n.y, m.x - n.x);
        const cx = (n.x + m.x) / 2, cy = (n.y + m.y) / 2, s = 9;
        g.fillTriangle(
          cx + Math.cos(a) * s, cy + Math.sin(a) * s,
          cx + Math.cos(a + 2.4) * s, cy + Math.sin(a + 2.4) * s,
          cx + Math.cos(a - 2.4) * s, cy + Math.sin(a - 2.4) * s,
        );
      }
    }

    for (const n of this.boardData.nodes) {
      const view = { gfx: this.add.graphics(), label: this.add.text(n.x, n.y, '', { fontStyle: 'bold' }).setOrigin(0.5), type: null };
      this.nodeViews.set(n.id, view);
      this.paintNode(n.id, n.type);
    }

    if (this.boardData.decor) {
      for (const d of this.boardData.decor) {
        this.add.text(d.x, d.y, d.text, { fontFamily: FONT, fontSize: `${d.size || 24}px`, fontStyle: 'bold', color: '#ffffff' })
          .setOrigin(0.5).setAlpha(d.alpha ?? 1);
      }
    } else {
      this.add.text(24, 20, this.boardData.name, { fontFamily: FONT, fontSize: '28px', fontStyle: 'bold', color: '#ffffff' });
    }
  }

  // (Re)draw one space, used again when a space changes type (VS → blue)
  paintNode(id, type) {
    const n = this.nodes.get(id), v = this.nodeViews.get(id), meta = this.spaceTypes[type] || {};
    if (v.type === type) return;
    v.type = type;
    const r = meta.passOnly ? 24 : 30;
    v.gfx.clear();
    v.gfx.fillStyle(0x000000, 0.35).fillCircle(n.x, n.y + 5, r);
    v.gfx.fillStyle(hex(meta.color || '#999999'), 1).fillCircle(n.x, n.y, r);
    v.gfx.lineStyle(4, 0xffffff, 0.85).strokeCircle(n.x, n.y, r);
    const icon = meta.icon || '';
    const emoji = /\p{Extended_Pictographic}/u.test(icon);
    v.label.setText(icon).setStyle({
      fontFamily: FONT,
      fontStyle: 'bold',
      fontSize: emoji ? (meta.passOnly ? '24px' : '28px') : icon.length > 1 ? '20px' : '26px',
      color: type === 'start' ? '#14213d' : '#ffffff',
    });
    if (v.type && v.flash !== false) {
      this.tweens.add({ targets: v.label, scale: 1.4, yoyo: true, duration: 200 });
    }
  }

  tokenPos(nodeId, index) {
    const n = this.nodes.get(nodeId);
    const [dx, dy] = TOKEN_OFFSETS[index % TOKEN_OFFSETS.length];
    return { x: n.x + dx, y: n.y + dy };
  }

  // Called by host.js whenever the server sends new state
  applyState(s) {
    // Spaces that changed type during the game
    for (const n of this.boardData.nodes) this.paintNode(n.id, s.spaceOverrides?.[n.id] ?? n.type);
    if (this.bankText) this.bankText.setText(s.phase === 'LOBBY' ? '' : `🏦 ${s.bank}`);

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
          fontFamily: FONT, fontSize: '16px', fontStyle: 'bold', color: '#14213d',
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
