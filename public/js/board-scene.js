// Phaser scene that draws the board like a real board game: an island in the sea with
// sandy roads, glossy 3D spaces, wooden signposts, scenery and pawns.
// It only renders: all game logic lives on the server.

const TOKEN_OFFSETS = [[-17, -12], [17, -12], [-17, 14], [17, 14]];
const hex = c => Phaser.Display.Color.HexStringToColor(c).color;
const shade = (c, pct) => Phaser.Display.Color.HexStringToColor(c).darken(pct).color;
const css = n => `#${n.toString(16).padStart(6, '0')}`;
const FONT = '"Lilita One", "Nunito", system-ui, sans-serif';
const MOVE_PHASES = ['MOVING', 'JUNCTION', 'STAR_PROMPT', 'SHOP', 'BANDIT', 'DISCARD'];

// Small seeded random generator so each board's scenery is the same every time
function seeded(str) {
  let h = 1779033703;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
  return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}
const distToSeg = (px, py, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
};

const LAND_DECOR = ['🌴', '🌴', '🌳', '🌳', '🌲', '🌼', '🌺', '🪨', '🏠', '🍄', '🌴', '🌻'];
const SEA_DECOR = ['⛵', '🐟', '🐠', '🐳', '🛶', '⛵'];
const FX_EMOJI = ['⭐', '✨', '🪙', '🏦', '🎁'];

class BoardScene extends Phaser.Scene {
  constructor() {
    super('board');
    this.tokens = new Map();    // playerId -> { container, halo, pawn, nodeId }
    this.nodeViews = new Map(); // nodeId -> { gfx, label, img, sub, type }
    this.activeId = null;
    this.camMode = 'overview';
    this.bg = [];               // static scenery objects, baked into one image after drawing
  }

  init(data) {
    this.boardData = data.board;
    this.spaceTypes = data.spaceTypes; // from server/spaces.js (name, color, icon, passOnly)
    this.itemsMeta = data.items || {};
    this.onReady = data.onReady;
    this.nodes = new Map(this.boardData.nodes.map(n => [n.id, n]));
    this.edges = [];
    for (const n of this.boardData.nodes) for (const id of n.next) this.edges.push([n, this.nodes.get(id)]);
  }

  // Load every emoji the board can draw as a Twemoji image, so it looks the same on any device
  preload() {
    const set = new Set([...LAND_DECOR, ...SEA_DECOR, ...FX_EMOJI]);
    const add = text => Emoji.all(text || '').forEach(e => set.add(e));
    Object.values(this.spaceTypes).forEach(t => add(t.icon));
    Object.values(this.itemsMeta).forEach(it => add(it.icon));
    (this.boardData.decor || []).forEach(d => add(d.text));
    for (const e of set) {
      if (!this.textures.exists(this.emojiKey(e))) this.load.svg(this.emojiKey(e), Emoji.url(e), { width: 96, height: 96 });
    }
  }

  create() {
    const { width: W, height: H } = this.boardData;
    this.cameras.main.setBounds(0, 0, W, H);
    // Static background: drawn once, then flattened into a single image (nothing animates)
    this.drawSea();
    this.drawLand();
    this.drawRoads();
    this.drawScenery();
    this.drawDecorText();
    this.bakeBackground();
    this.drawSpaces();

    // The Star: spinning rays + glow, sitting on the path between two spaces
    this.starRays = this.add.graphics().setDepth(4).setVisible(false);
    this.starRays.fillStyle(0xffe066, 0.45);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2, b = a + 0.13;
      this.starRays.fillTriangle(0, 0, Math.cos(a) * 70, Math.sin(a) * 70, Math.cos(b) * 70, Math.sin(b) * 70);
    }
    this.tweens.add({ targets: this.starRays, angle: 360, repeat: -1, duration: 9000 });
    this.starGlow = this.add.circle(0, 0, 34, 0xfff3b0, 0.55).setDepth(4).setVisible(false);
    this.tweens.add({ targets: this.starGlow, scale: 1.7, alpha: 0, repeat: -1, duration: 1300 });
    this.star = this.icon(0, 0, '⭐', 62).setDepth(5).setVisible(false);
    this.starScale = this.star.scale;
    this.tweens.add({ targets: this.star, scale: this.starScale * 1.15, yoyo: true, repeat: -1, duration: 650, ease: 'Sine.easeInOut' });

    // Bank totals (all Banks share one pot)
    this.bankNodes = this.boardData.nodes.filter(n => n.type === 'bank');
    this.bankViews = [];
    this.bankValue = null;

    this.onReady?.(this);
  }

  // ---------- emoji helpers ----------

  emojiKey(e) { return `emoji-${e}`; }

  // One emoji as an image (falls back to plain text if the image is missing)
  icon(x, y, e, size) {
    const key = this.emojiKey(e);
    if (this.textures.exists(key)) return this.add.image(x, y, key).setDisplaySize(size, size);
    return this.add.text(x, y, e, { fontSize: `${Math.round(size * 0.8)}px` }).setOrigin(0.5);
  }

  // Text that may contain emoji: words as text, emoji as images, laid out in a row
  richText(x, y, str, style, size) {
    const objs = Emoji.split(str).map(p => (p.emoji ? this.icon(0, 0, p.emoji, size) : this.add.text(0, 0, p.text, style).setOrigin(0.5)));
    const widths = objs.map(o => o.displayWidth);
    let cx = -widths.reduce((a, b) => a + b, 0) / 2;
    objs.forEach((o, i) => { o.setPosition(cx + widths[i] / 2, 0); cx += widths[i]; });
    return this.add.container(x, y, objs);
  }

  // ---------- scenery (static) ----------

  drawSea() {
    const { width: W, height: H } = this.boardData;
    const g = this.add.graphics().setDepth(-10);
    g.fillGradientStyle(0x1b6ca8, 0x1b6ca8, 0x0b3c5d, 0x0b3c5d, 1).fillRect(0, 0, W, H);
    // Little wave marks in open water
    const rnd = seeded(this.boardData.id + 'sea');
    g.lineStyle(3, 0xbde0fe, 0.22);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * W, y = rnd() * H, r = 7 + rnd() * 5;
      if (this.nearLand(x, y, 150)) continue;
      for (const dx of [0, r * 1.8]) {
        g.beginPath();
        g.arc(x + dx, y, r, Math.PI * 1.15, Math.PI * 1.85);
        g.strokePath();
      }
    }
    this.bg.push(g);
  }

  nearLand(x, y, d) {
    return this.edges.some(([a, b]) => distToSeg(x, y, a, b) < d) || this.boardData.nodes.some(n => Math.hypot(n.x - x, n.y - y) < d);
  }

  // Land follows the roads: foam → beach → grass, drawn as thick strokes along every path
  drawLand() {
    const layers = [
      { w: 210, color: 0xffffff, alpha: 0.18 },
      { w: 180, color: 0xe9c46a, alpha: 1 },
      { w: 150, color: 0xd4a373, alpha: 0.35 },
      { w: 136, color: 0x52b788, alpha: 1 },
    ];
    for (const L of layers) {
      const g = this.add.graphics().setDepth(-8);
      g.lineStyle(L.w, L.color, L.alpha).fillStyle(L.color, L.alpha);
      for (const [a, b] of this.edges) g.lineBetween(a.x, a.y, b.x, b.y);
      for (const n of this.boardData.nodes) g.fillCircle(n.x, n.y, L.w / 2);
      this.bg.push(g);
    }
    // Grass texture: soft darker blotches
    const rnd = seeded(this.boardData.id + 'grass');
    const g = this.add.graphics().setDepth(-7);
    for (let i = 0; i < 260; i++) {
      const [a, b] = this.edges[Math.floor(rnd() * this.edges.length)];
      const t = rnd(), off = (rnd() - 0.5) * 110;
      const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      g.fillStyle(rnd() < 0.5 ? 0x40916c : 0x74c69d, 0.35).fillCircle(a.x + (b.x - a.x) * t + Math.cos(ang) * off, a.y + (b.y - a.y) * t + Math.sin(ang) * off, 6 + rnd() * 12);
    }
    this.bg.push(g);
  }

  drawRoads() {
    const g = this.add.graphics().setDepth(-6);
    g.lineStyle(34, 0x7f5539, 1);
    for (const [a, b] of this.edges) g.lineBetween(a.x, a.y, b.x, b.y);
    g.lineStyle(26, 0xe6ccb2, 1);
    for (const [a, b] of this.edges) g.lineBetween(a.x, a.y, b.x, b.y);
    // Dotted center line + direction chevrons
    const passOnly = n => this.spaceTypes[n.type]?.passOnly;
    for (const [a, b] of this.edges) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let d = 36; d < len - 36; d += 16) {
        const t = d / len;
        g.fillStyle(0xb08968, 1).fillCircle(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, 2.2);
      }
      if (passOnly(a) || passOnly(b)) continue;
      const ang = Math.atan2(b.y - a.y, b.x - a.x), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, s = 10;
      g.fillStyle(0x9c6644, 1).fillTriangle(cx + Math.cos(ang) * s, cy + Math.sin(ang) * s, cx + Math.cos(ang + 2.4) * s, cy + Math.sin(ang + 2.4) * s, cx + Math.cos(ang - 2.4) * s, cy + Math.sin(ang - 2.4) * s);
    }
    this.bg.push(g);
  }

  drawScenery() {
    const rnd = seeded(this.boardData.id + 'decor');
    const placed = [];
    const free = (x, y, gap) => !this.boardData.nodes.some(n => Math.hypot(n.x - x, n.y - y) < 58)
      && !this.edges.some(([a, b]) => distToSeg(x, y, a, b) < gap)
      && !placed.some(p => Math.hypot(p.x - x, p.y - y) < 40)
      && !(this.boardData.decor || []).some(d => Math.abs(d.x - x) < 120 && Math.abs(d.y - y) < 30);
    // Scenery on the grass beside the roads
    for (let i = 0; i < 400 && placed.length < 70; i++) {
      const [a, b] = this.edges[Math.floor(rnd() * this.edges.length)];
      const t = rnd(), side = rnd() < 0.5 ? -1 : 1, off = side * (40 + rnd() * 24);
      const ang = Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2;
      const x = a.x + (b.x - a.x) * t + Math.cos(ang) * off, y = a.y + (b.y - a.y) * t + Math.sin(ang) * off;
      if (!free(x, y, 36)) continue;
      placed.push({ x, y });
      const e = LAND_DECOR[Math.floor(rnd() * LAND_DECOR.length)];
      const size = 28 + rnd() * 16;
      this.bg.push(this.icon(x, y - size * 0.35, e, size).setDepth(-5 + y / 10000));
    }
    // Things in the sea
    const { width: W, height: H } = this.boardData;
    let boats = 0;
    for (let i = 0; i < 300 && boats < 9; i++) {
      const x = 40 + rnd() * (W - 80), y = 40 + rnd() * (H - 80);
      if (this.nearLand(x, y, 130)) continue;
      boats++;
      this.bg.push(this.icon(x, y, SEA_DECOR[boats % SEA_DECOR.length], 30 + rnd() * 12).setDepth(-5));
    }
  }

  drawDecorText() {
    if (this.boardData.decor) {
      for (const d of this.boardData.decor) {
        const big = (d.size || 24) >= 40;
        const size = d.size || 24;
        const c = this.richText(d.x, d.y, d.text, {
          fontFamily: FONT, fontSize: `${size}px`, color: big ? '#ffffff' : '#fefae0',
          stroke: big ? '#0b3c5d' : '#1b4332', strokeThickness: big ? 10 : 6,
        }, size * 1.1).setAlpha(big ? 0.85 : Math.max(0.85, d.alpha ?? 1)).setDepth(3);
        this.bg.push(c);
      }
    } else {
      this.bg.push(this.add.text(24, 20, this.boardData.name, { fontFamily: FONT, fontSize: '34px', color: '#fff', stroke: '#0b3c5d', strokeThickness: 8 }).setDepth(3));
    }
  }

  // Flatten everything static into one texture: far less work per frame than ~150 objects
  bakeBackground() {
    const { width: W, height: H } = this.boardData;
    const rt = this.add.renderTexture(0, 0, W, H).setOrigin(0, 0).setDepth(-10);
    const objs = [...this.bg].sort((a, b) => a.depth - b.depth);
    rt.draw(objs);
    objs.forEach(o => o.destroy());
    this.bg = [];
  }

  // ---------- spaces ----------

  drawSpaces() {
    for (const n of this.boardData.nodes) {
      const view = {
        gfx: this.add.graphics().setDepth(1),
        label: this.add.text(n.x, n.y, '', {}).setOrigin(0.5).setDepth(2),
        img: null,
        sub: this.add.text(n.x, n.y, '', {}).setOrigin(0.5).setDepth(2),
        type: null,
      };
      this.nodeViews.set(n.id, view);
      this.paintNode(n.id, n.type);
    }
  }

  // Put either an emoji image or text on a space
  setSpaceLabel(v, x, y, icon, size, style) {
    const e = Emoji.all(icon);
    if (e.length === 1 && e[0] === icon.replace(/\s/g, '')) {
      v.label.setVisible(false);
      v.img?.destroy();
      v.img = this.icon(x, y, e[0], size).setDepth(2);
    } else {
      v.img?.destroy(); v.img = null;
      v.label.setVisible(true).setPosition(x, y).setText(icon).setStyle(style);
    }
    return v.img || v.label;
  }

  // (Re)draw one space. Real spaces are glossy 3D discs; pass-only things (shops, the Bandit)
  // are wooden signposts beside the road, so it's obvious you can't stop there.
  paintNode(id, type) {
    const n = this.nodes.get(id), v = this.nodeViews.get(id), meta = this.spaceTypes[type] || {};
    if (v.type === type) return;
    const changed = v.type !== null;
    v.type = type;
    const g = v.gfx.clear();
    const icon = meta.icon || '';
    const color = meta.color || '#999999';

    if (meta.passOnly) {
      const sx = n.x, sy = n.y - 48;
      g.fillStyle(0x000000, 0.3).fillEllipse(n.x + 4, n.y + 6, 26, 9);
      g.fillStyle(0x6f4518, 1).fillRect(n.x - 4, sy + 10, 8, 46);           // pole
      g.fillStyle(0x000000, 0.3).fillRoundedRect(sx - 36, sy - 26 + 5, 72, 50, 10);
      g.fillStyle(0x9c6644, 1).fillRoundedRect(sx - 36, sy - 26, 72, 50, 10);   // wooden board
      g.lineStyle(3, 0x583101, 1).strokeRoundedRect(sx - 36, sy - 26, 72, 50, 10);
      g.fillStyle(hex(color), 1).fillRoundedRect(sx - 28, sy - 19, 56, 36, 8);  // colored panel
      g.fillStyle(0xffffff, 0.25).fillRoundedRect(sx - 26, sy - 17, 52, 10, 5);
      this.setSpaceLabel(v, sx, sy - 1, icon, 30, { fontSize: '28px' });
      v.sub.setPosition(sx, sy - 40).setText((meta.name || '').toUpperCase())
        .setStyle({ fontFamily: FONT, fontSize: '15px', color: '#fefae0', stroke: '#3a2400', strokeThickness: 5 });
      return;
    }

    const start = type === 'start';
    const r = start ? 38 : 30;
    g.fillStyle(0x000000, 0.35).fillEllipse(n.x + 3, n.y + 10, r * 2.1, r * 1.1);       // shadow
    g.fillStyle(start ? 0xb08900 : shade(color, 30), 1).fillCircle(n.x, n.y + 4, r);     // side/rim
    g.fillStyle(start ? 0xffd166 : hex(color), 1).fillCircle(n.x, n.y, r);              // top
    g.lineStyle(3, 0xffffff, 0.95).strokeCircle(n.x, n.y, r);
    g.lineStyle(2, 0xffffff, 0.3).strokeCircle(n.x, n.y, r - 7);
    g.fillStyle(0xffffff, 0.35).fillEllipse(n.x - r * 0.28, n.y - r * 0.45, r * 0.9, r * 0.38); // shine
    if (start) { g.lineStyle(4, 0xffffff, 1).strokeCircle(n.x, n.y, r + 6); }
    const label = this.setSpaceLabel(v, n.x, n.y + 1, start ? 'START' : icon, 32, {
      fontFamily: FONT,
      fontSize: start ? '17px' : icon.length > 1 ? '22px' : '30px',
      color: start ? '#5c3d00' : '#ffffff',
      stroke: start ? '#fff3b0' : css(shade(color, 45)),
      strokeThickness: 5,
    });
    v.sub.setText('');
    if (changed) this.tweens.add({ targets: label, scale: label.scale * 1.7, yoyo: true, duration: 260 });
  }

  // ---------- pawns ----------

  pawnTexture(color) {
    const key = `pawn-${color}`;
    if (this.textures.exists(key)) return key;
    const g = this.make.graphics({ add: false });
    const c = hex(color), dark = shade(color, 35);
    g.fillStyle(dark, 1).fillEllipse(26, 54, 40, 14);                       // base rim
    g.fillStyle(c, 1).fillEllipse(26, 51, 40, 14);                          // base top
    g.fillStyle(c, 1).fillTriangle(12, 51, 40, 51, 26, 18);                 // body
    g.fillStyle(dark, 0.35).fillTriangle(26, 51, 40, 51, 26, 18);           // body shading
    g.fillStyle(c, 1).fillEllipse(26, 24, 26, 8);                           // collar
    g.fillStyle(c, 1).fillCircle(26, 15, 12);                               // head
    g.fillStyle(dark, 0.3).fillCircle(29, 17, 9);
    g.fillStyle(0xffffff, 0.6).fillEllipse(21, 10, 9, 6);                   // shine
    g.lineStyle(2, 0x1d1d1d, 0.6).strokeCircle(26, 15, 12);
    g.generateTexture(key, 52, 62);
    g.destroy();
    return key;
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
    this.lastState = s;
    for (const n of this.boardData.nodes) this.paintNode(n.id, s.spaceOverrides?.[n.id] ?? n.type);
    // Bank totals: only rebuilt when the amount changes
    const bankLabel = s.phase === 'LOBBY' ? null : s.bank;
    if (bankLabel !== this.bankValue) {
      this.bankValue = bankLabel;
      this.bankViews.forEach(v => v.destroy());
      this.bankViews = bankLabel === null ? [] : this.bankNodes.map(n => this.richText(n.x, n.y - 56, `🏦 ${bankLabel}`, {
        fontFamily: FONT, fontSize: '22px', color: '#ffe066', stroke: '#3a2400', strokeThickness: 6,
      }, 26).setDepth(6));
    }

    // Star
    const starObjs = [this.star, this.starGlow, this.starRays];
    if (s.star && s.phase !== 'LOBBY') {
      const { x, y } = this.starPos(s.star);
      const key = `${s.star.from}-${s.star.to}`;
      if (this.starKey !== key) {
        const first = !this.starKey;
        this.starKey = key;
        // Stop anything still moving the Star, then fly it (all parts together) to the new spot
        this.starFlight?.stop();
        if (first) starObjs.forEach(o => o.setPosition(x, y));
        else {
          const sx = this.star.x, sy = this.star.y;
          this.starFlight = this.tweens.addCounter({
            from: 0, to: 1, duration: 1100, ease: 'Cubic.easeInOut',
            onUpdate: tw => {
              const k = tw.getValue();
              const px = sx + (x - sx) * k, py = sy + (y - sy) * k;
              this.starGlow.setPosition(px, py); this.starRays.setPosition(px, py);
              this.star.setPosition(px, py - Math.sin(k * Math.PI) * 120); // arc through the air
            },
            onComplete: () => starObjs.forEach(o => o.setPosition(x, y)),
          });
        }
      }
      starObjs.forEach(o => o.setVisible(true));
    } else {
      starObjs.forEach(o => o.setVisible(false));
      this.starKey = null;
    }

    // Pawns
    const seen = new Set();
    s.players.forEach((p, i) => {
      seen.add(p.id);
      let t = this.tokens.get(p.id);
      const pos = this.tokenPos(p.pos, i);
      if (!t) {
        const halo = this.add.ellipse(0, 6, 46, 18, hex(p.color), 0.7).setVisible(false);
        const pawn = this.add.image(0, 0, this.pawnTexture(p.color)).setOrigin(0.5, 0.9);
        const initial = this.add.text(0, -18, p.name.replace(/^CPU /, '')[0].toUpperCase(), {
          fontFamily: FONT, fontSize: '15px', color: '#ffffff', stroke: '#1d1d1d', strokeThickness: 4,
        }).setOrigin(0.5);
        const container = this.add.container(pos.x, pos.y, [halo, pawn, initial]).setDepth(10 + pos.y / 10000);
        t = { container, halo, pawn, nodeId: p.pos };
        this.tokens.set(p.id, t);
      } else if (t.nodeId !== p.pos) {
        t.nodeId = p.pos;
        // Hop: arc up and land with a little squash
        const sx = t.container.x, sy = t.container.y;
        t.hopping = true;
        this.tweens.addCounter({
          from: 0, to: 1, duration: 280,
          onUpdate: tw => {
            const k = tw.getValue();
            t.container.setPosition(sx + (pos.x - sx) * k, sy + (pos.y - sy) * k - Math.sin(k * Math.PI) * 28);
          },
          onComplete: () => { t.container.setPosition(pos.x, pos.y); t.hopping = false; },
        });
        this.tweens.add({ targets: t.pawn, scaleY: 0.8, scaleX: 1.15, delay: 260, duration: 80, yoyo: true });
      } else if (!t.hopping) {
        t.container.setPosition(pos.x, pos.y);
      }
      t.container.setAlpha(p.connected ? 1 : 0.45);
    });
    for (const [id, t] of this.tokens) if (!seen.has(id)) { t.container.destroy(); this.tokens.delete(id); }

    // Whoever's turn it is: pulsing halo + bobbing pawn
    if (this.activeId !== s.turnPlayerId) {
      const old = this.tokens.get(this.activeId);
      if (old) { this.tweens.killTweensOf([old.halo, old.pawn]); old.halo.setVisible(false); old.pawn.setY(0).setScale(1); }
      this.activeId = s.turnPlayerId;
      const t = this.tokens.get(this.activeId);
      if (t) {
        t.halo.setVisible(true).setScale(1).setAlpha(0.9);
        this.tweens.add({ targets: t.halo, scale: 2, alpha: 0, repeat: -1, duration: 800 });
        this.tweens.add({ targets: t.pawn, y: -8, yoyo: true, repeat: -1, duration: 380, ease: 'Sine.easeInOut' });
        t.container.setDepth(20);
      }
    }

    // Camera: follow the moving player up close, otherwise show the whole board
    const t = this.tokens.get(s.turnPlayerId);
    const wantFollow = t && MOVE_PHASES.includes(s.phase) && !s.boardView; // a player opened the full map
    const cam = this.cameras.main;
    if (this.time.now < (this.focusUntil || 0)) return; // showing where the Star went
    if (wantFollow && this.camMode !== s.turnPlayerId) {
      this.camMode = s.turnPlayerId;
      cam.startFollow(t.container, false, 0.08, 0.08);
      cam.zoomTo(1.4, 700, 'Sine.easeInOut');
    } else if (!wantFollow && this.camMode !== 'overview') {
      this.camMode = 'overview';
      cam.stopFollow();
      cam.pan(this.boardData.width / 2, this.boardData.height / 2, 700, 'Sine.easeInOut');
      cam.zoomTo(1, 700, 'Sine.easeInOut');
    }
  }

  // Fly the camera to the Star's new spot for a moment, then hand back control
  focusStar(star, ms = 2800) {
    const { x, y } = this.starPos(star);
    const cam = this.cameras.main;
    this.focusUntil = this.time.now + ms;
    cam.stopFollow();
    this.camMode = 'star';
    this.time.delayedCall(450, () => { cam.pan(x, y, 700, 'Sine.easeInOut'); cam.zoomTo(1.6, 700, 'Sine.easeInOut'); });
    this.time.delayedCall(ms, () => {
      this.focusUntil = 0;
      this.camMode = 'star-done';
      if (this.lastState) this.applyState(this.lastState);
    });
  }

  // ---------- effects (from server "fx" events) ----------

  tokenXY(playerId) {
    const t = this.tokens.get(playerId);
    return t ? { x: t.container.x, y: t.container.y } : { x: this.boardData.width / 2, y: this.boardData.height / 2 };
  }

  // Floating text that rises from a player's pawn
  floatText(playerId, text, color = '#ffffff', size = 36) {
    const { x, y } = this.tokenXY(playerId);
    const t = this.richText(x, y - 60, text, {
      fontFamily: FONT, fontSize: `${size}px`, color, stroke: '#1d1d1d', strokeThickness: 8,
    }, size * 1.05).setDepth(70).setScale(0.3);
    this.tweens.add({ targets: t, scale: 1, duration: 260, ease: 'Back.easeOut' });
    this.tweens.add({ targets: t, y: y - 140, alpha: 0, delay: 1000, duration: 900, onComplete: () => t.destroy() });
  }

  // Coins burst out of a pawn (gains) or fall off it (losses)
  coinShower(playerId, amount) {
    const { x, y } = this.tokenXY(playerId);
    const n = Math.min(10, Math.max(3, Math.abs(amount)));
    for (let i = 0; i < n; i++) {
      const c = this.icon(x, y - 30, '🪙', 24).setDepth(65);
      const dx = (Math.random() - 0.5) * 120;
      if (amount > 0) {
        this.tweens.add({ targets: c, x: x + dx, y: y - 80 - Math.random() * 60, alpha: 0, duration: 800 + Math.random() * 300, ease: 'Quad.easeOut', onComplete: () => c.destroy() });
      } else {
        this.tweens.add({ targets: c, x: x + dx, y: y + 40 + Math.random() * 30, alpha: 0, angle: 180, duration: 800, ease: 'Quad.easeIn', onComplete: () => c.destroy() });
      }
    }
  }

  // Expanding rings on a space
  burst(nodeId, color) {
    const n = this.nodes.get(nodeId);
    if (!n) return;
    for (let i = 0; i < 3; i++) {
      const ring = this.add.circle(n.x, n.y, 30).setStrokeStyle(8, hex(color)).setDepth(3);
      this.tweens.add({ targets: ring, scale: 3.2, alpha: 0, delay: i * 160, duration: 750, onComplete: () => ring.destroy() });
    }
    const v = this.nodeViews.get(nodeId);
    if (v) this.tweens.add({ targets: v.label, scale: 1.5, yoyo: true, duration: 180 });
  }

  starFx(playerId, amount) {
    const { x, y } = this.tokenXY(playerId);
    this.floatText(playerId, amount > 0 ? `+${amount} ⭐` : `${amount} ⭐`, amount > 0 ? '#ffe066' : '#ff8a8a', 56);
    if (amount > 0) {
      for (let i = 0; i < 14; i++) {
        const s = this.icon(x, y - 30, i % 2 ? '✨' : '⭐', 32).setDepth(66);
        const a = (i / 14) * Math.PI * 2;
        this.tweens.add({ targets: s, x: x + Math.cos(a) * 150, y: y - 30 + Math.sin(a) * 150, alpha: 0, angle: 180, duration: 1000, onComplete: () => s.destroy() });
      }
      this.cameras.main.flash(250, 255, 230, 120);
    }
  }
}
