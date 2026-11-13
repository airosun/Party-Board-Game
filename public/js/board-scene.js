// Phaser scene that draws the board graph, animates tokens and plays effects.
// It only renders: all game logic lives on the server.

const TOKEN_OFFSETS = [[-16, -16], [16, -16], [-16, 16], [16, 16]];
const hex = c => Phaser.Display.Color.HexStringToColor(c).color;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const EMOJI = /\p{Extended_Pictographic}/u;

class BoardScene extends Phaser.Scene {
  constructor() {
    super('board');
    this.tokens = new Map();    // playerId -> { container, halo, nodeId }
    this.nodeViews = new Map(); // nodeId -> { gfx, label, sub, type }
    this.rollingUntil = 0;
    this.activeId = null;
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

    // The Star lives on the path BETWEEN two spaces
    this.starGlow = this.add.circle(0, 0, 34, 0xffd166, 0.35).setDepth(4).setVisible(false);
    this.star = this.add.text(0, 0, '⭐', { fontSize: '54px' }).setOrigin(0.5).setDepth(5).setVisible(false);
    this.tweens.add({ targets: this.star, scale: 1.15, yoyo: true, repeat: -1, duration: 600 });
    this.tweens.add({ targets: this.starGlow, scale: 1.6, alpha: 0, repeat: -1, duration: 1200 });

    this.bankTexts = this.boardData.nodes.filter(n => n.type === 'bank').map(n => this.add.text(n.x, n.y - 52, '', {
      fontFamily: FONT, fontSize: '20px', fontStyle: 'bold', color: '#ffd166', stroke: '#000', strokeThickness: 5,
    }).setOrigin(0.5).setDepth(6));

    const [dx, dy] = this.boardData.dicePos || [this.boardData.width / 2, this.boardData.height / 2];
    this.dicePos = [dx, dy];
    this.diceBox = this.add.rectangle(dx, dy, 150, 150, 0xffffff, 1).setStrokeStyle(8, 0x14213d).setDepth(30).setVisible(false);
    this.diceText = this.add.text(dx, dy, '', {
      fontFamily: FONT, fontSize: '96px', fontStyle: 'bold', color: '#14213d',
    }).setOrigin(0.5).setDepth(31);
    this.diceDetail = this.add.text(dx, dy + 110, '', {
      fontFamily: FONT, fontSize: '30px', fontStyle: 'bold', color: '#ffca3a', stroke: '#000', strokeThickness: 6,
    }).setOrigin(0.5).setDepth(31);
    this.stepsText = this.add.text(dx, dy, '', {
      fontFamily: FONT, fontSize: '80px', fontStyle: 'bold', color: '#ffca3a', stroke: '#000', strokeThickness: 10,
    }).setOrigin(0.5).setDepth(29);

    this.onReady?.(this);
  }

  drawBoard() {
    const g = this.add.graphics();
    const passOnly = id => this.spaceTypes[this.nodes.get(id).type]?.passOnly;

    // Paths between spaces, with a small arrow showing direction
    g.lineStyle(12, 0x33415c, 1);
    for (const n of this.boardData.nodes) for (const id of n.next) { const m = this.nodes.get(id); g.lineBetween(n.x, n.y, m.x, m.y); }
    g.fillStyle(0x5c677d, 1);
    for (const n of this.boardData.nodes) {
      for (const id of n.next) {
        if (passOnly(id) || passOnly(n.id)) continue; // markers sit there instead
        const m = this.nodes.get(id);
        const a = Math.atan2(m.y - n.y, m.x - n.x);
        const cx = (n.x + m.x) / 2, cy = (n.y + m.y) / 2, s = 9;
        g.fillTriangle(cx + Math.cos(a) * s, cy + Math.sin(a) * s, cx + Math.cos(a + 2.4) * s, cy + Math.sin(a + 2.4) * s, cx + Math.cos(a - 2.4) * s, cy + Math.sin(a - 2.4) * s);
      }
    }

    for (const n of this.boardData.nodes) {
      const view = {
        gfx: this.add.graphics().setDepth(1),
        label: this.add.text(n.x, n.y, '', { fontStyle: 'bold' }).setOrigin(0.5).setDepth(2),
        sub: this.add.text(n.x, n.y + 34, '', { fontFamily: FONT, fontSize: '13px', fontStyle: 'bold', color: '#ffffff' }).setOrigin(0.5).setDepth(2),
        type: null,
      };
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

  // (Re)draw one space. Pass-only things (shops, the Bandit) are drawn as signposts ON the
  // path, not as spaces, so it's obvious you can't stop there.
  paintNode(id, type) {
    const n = this.nodes.get(id), v = this.nodeViews.get(id), meta = this.spaceTypes[type] || {};
    if (v.type === type) return;
    const changed = v.type !== null;
    v.type = type;
    v.gfx.clear();
    const icon = meta.icon || '';
    if (meta.passOnly) {
      // Signpost: a rounded tag floating above the path, with a little pole
      v.gfx.fillStyle(0x000000, 0.4).fillRoundedRect(n.x - 26, n.y - 50, 52, 44, 10);
      v.gfx.lineStyle(3, 0xffffff, 0.9).lineBetween(n.x, n.y - 8, n.x, n.y + 2);
      v.gfx.fillStyle(hex(meta.color || '#999999'), 1).fillRoundedRect(n.x - 26, n.y - 54, 52, 44, 10);
      v.gfx.lineStyle(3, 0xffffff, 0.9).strokeRoundedRect(n.x - 26, n.y - 54, 52, 44, 10);
      v.gfx.fillStyle(0xffffff, 1).fillCircle(n.x, n.y + 2, 5);
      v.label.setPosition(n.x, n.y - 32).setText(icon).setStyle({ fontSize: '26px' });
      v.sub.setPosition(n.x, n.y - 66).setText((meta.name || '').toUpperCase()).setStyle({ fontSize: '12px', color: '#ffffff' });
      return;
    }
    v.gfx.fillStyle(0x000000, 0.35).fillCircle(n.x, n.y + 5, 30);
    v.gfx.fillStyle(hex(meta.color || '#999999'), 1).fillCircle(n.x, n.y, 30);
    v.gfx.lineStyle(4, 0xffffff, 0.85).strokeCircle(n.x, n.y, 30);
    v.label.setText(icon).setStyle({
      fontFamily: FONT, fontStyle: 'bold',
      fontSize: EMOJI.test(icon) ? '28px' : icon.length > 1 ? '20px' : '26px',
      color: type === 'start' ? '#14213d' : '#ffffff',
    });
    v.sub.setText('');
    if (changed) this.tweens.add({ targets: v.label, scale: 1.6, yoyo: true, duration: 250 });
  }

  tokenPos(nodeId, index) {
    const n = this.nodes.get(nodeId);
    const [dx, dy] = TOKEN_OFFSETS[index % TOKEN_OFFSETS.length];
    return { x: n.x + dx, y: n.y + dy };
  }

  starPos(star) {
    const a = this.nodes.get(star.from), b = this.nodes.get(star.to);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Called by host.js whenever the server sends new state
  applyState(s) {
    for (const n of this.boardData.nodes) this.paintNode(n.id, s.spaceOverrides?.[n.id] ?? n.type);
    this.bankTexts.forEach(t => t.setText(s.phase === 'LOBBY' ? '' : `🏦 ${s.bank}`));

    // Star
    if (s.star && s.phase !== 'LOBBY') {
      const { x, y } = this.starPos(s.star);
      const key = `${s.star.from}-${s.star.to}`;
      if (this.starKey !== key) {
        const first = !this.starKey;
        this.starKey = key;
        if (first) { this.star.setPosition(x, y); this.starGlow.setPosition(x, y); }
        else this.tweens.add({ targets: [this.star, this.starGlow], x, y, duration: 900, ease: 'Cubic.easeInOut' });
      }
      this.star.setVisible(true); this.starGlow.setVisible(true);
    } else {
      this.star.setVisible(false); this.starGlow.setVisible(false);
      this.starKey = null;
    }

    // Steps left while moving (hidden while the dice animation plays)
    const rolling = this.time.now < this.rollingUntil;
    this.stepsText.setText(!rolling && s.dice && s.dice.remaining > 0 ? `${s.dice.remaining}` : '');

    // Tokens
    const seen = new Set();
    s.players.forEach((p, i) => {
      seen.add(p.id);
      let t = this.tokens.get(p.id);
      const pos = this.tokenPos(p.pos, i);
      if (!t) {
        const halo = this.add.circle(0, 0, 26, hex(p.color), 0.5).setVisible(false);
        const circle = this.add.circle(0, 0, 17, hex(p.color)).setStrokeStyle(4, 0xffffff);
        const initial = this.add.text(0, 0, p.name.replace(/^CPU /, '')[0].toUpperCase(), {
          fontFamily: FONT, fontSize: '17px', fontStyle: 'bold', color: '#14213d',
        }).setOrigin(0.5);
        const container = this.add.container(pos.x, pos.y, [halo, circle, initial]).setDepth(10);
        t = { container, halo, nodeId: p.pos };
        this.tokens.set(p.id, t);
      } else if (t.nodeId !== p.pos) {
        t.nodeId = p.pos;
        this.tweens.add({ targets: t.container, x: pos.x, y: pos.y, duration: 260, ease: 'Quad.easeOut' });
        this.tweens.add({ targets: t.container, scale: 1.35, yoyo: true, duration: 130 });
      } else if (!this.tweens.isTweening(t.container)) {
        t.container.setPosition(pos.x, pos.y);
      }
      t.container.setAlpha(p.connected ? 1 : 0.4);
      t.container.setDepth(p.id === s.turnPlayerId ? 12 : 10);
    });
    for (const [id, t] of this.tokens) if (!seen.has(id)) { t.container.destroy(); this.tokens.delete(id); }

    // Whoever's turn it is: flashing halo + bobbing token
    if (this.activeId !== s.turnPlayerId) {
      const old = this.tokens.get(this.activeId);
      if (old) { this.tweens.killTweensOf(old.halo); old.halo.setVisible(false); }
      this.activeId = s.turnPlayerId;
      const t = this.tokens.get(this.activeId);
      if (t) {
        t.halo.setVisible(true).setScale(1).setAlpha(0.8);
        this.tweens.add({ targets: t.halo, scale: 1.9, alpha: 0, repeat: -1, duration: 750 });
      }
    }
  }

  // ---------- effects (from server "fx" events) ----------

  tokenXY(playerId) {
    const t = this.tokens.get(playerId);
    return t ? { x: t.container.x, y: t.container.y } : { x: this.dicePos[0], y: this.dicePos[1] };
  }

  // Floating text that rises from a player's token
  floatText(playerId, text, color = '#ffffff', size = 34) {
    const { x, y } = this.tokenXY(playerId);
    const t = this.add.text(x, y - 30, text, {
      fontFamily: FONT, fontSize: `${size}px`, fontStyle: 'bold', color, stroke: '#000', strokeThickness: 7,
    }).setOrigin(0.5).setDepth(40).setScale(0.4);
    this.tweens.add({ targets: t, scale: 1, duration: 200, ease: 'Back.easeOut' });
    this.tweens.add({ targets: t, y: y - 110, alpha: 0, delay: 900, duration: 900, onComplete: () => t.destroy() });
  }

  // Expanding ring on a space
  burst(nodeId, color) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    for (let i = 0; i < 2; i++) {
      const ring = this.add.circle(n.x, n.y, 30).setStrokeStyle(8, hex(color)).setDepth(3);
      this.tweens.add({ targets: ring, scale: 3, alpha: 0, delay: i * 180, duration: 700, onComplete: () => ring.destroy() });
    }
  }

  // Dice: tumble through numbers, then slam down the result
  showRoll(fx) {
    const [x, y] = this.dicePos;
    const total = 800;
    this.rollingUntil = this.time.now + total + 900;
    this.diceBox.setVisible(true).setScale(1).setAngle(0);
    this.diceDetail.setText('');
    this.stepsText.setText('');
    const max = fx.rollKind === 'bad' ? 3 : 10;
    const ev = this.time.addEvent({ delay: 60, repeat: Math.floor(total / 60), callback: () => {
      this.diceText.setText(String(1 + Math.floor(Math.random() * max)));
      this.diceBox.setAngle(Phaser.Math.Between(-18, 18));
    } });
    this.time.delayedCall(total, () => {
      ev.remove();
      this.diceBox.setAngle(0);
      this.diceText.setText(String(fx.value)).setScale(2.2);
      this.tweens.add({ targets: this.diceText, scale: 1, duration: 350, ease: 'Bounce.easeOut' });
      this.tweens.add({ targets: this.diceBox, scale: 1.25, yoyo: true, duration: 150 });
      const detail = fx.dice && (fx.dice.length > 1 || fx.boost) ? `${fx.dice.join(' + ')}${fx.boost ? ` + ${fx.boost} 🚀` : ''}` : fx.rollKind === 'bad' ? '🐌 Bad Dice' : '';
      this.diceDetail.setText(detail);
      this.cameras.main.shake(180, 0.006);
    });
    this.time.delayedCall(total + 900, () => {
      this.diceBox.setVisible(false); this.diceText.setText(''); this.diceDetail.setText('');
    });
    this.diceText.setPosition(x, y);
  }

  starFx(playerId, amount) {
    const { x, y } = this.tokenXY(playerId);
    this.floatText(playerId, amount > 0 ? `+${amount} ⭐` : `${amount} ⭐`, amount > 0 ? '#ffd166' : '#ff8a8a', 52);
    if (amount > 0) {
      for (let i = 0; i < 10; i++) {
        const s = this.add.text(x, y, '✨', { fontSize: '28px' }).setOrigin(0.5).setDepth(39);
        const a = (i / 10) * Math.PI * 2;
        this.tweens.add({ targets: s, x: x + Math.cos(a) * 120, y: y + Math.sin(a) * 120, alpha: 0, duration: 900, onComplete: () => s.destroy() });
      }
    }
  }
}
