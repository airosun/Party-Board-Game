// Phone controllers for each minigame type ("controls" in server/minigames).
// Controls.build(el, mg, send) draws the controller; Controls.update(mg) refreshes it on new state.
// Games that time/score themselves on the phone report with send({ points }) or send({ value }).

window.Controls = (() => {
  let active = null; // { type, cleanup(), update(mg) }

  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const press = (el, fn) => el.addEventListener('pointerdown', e => { e.preventDefault(); fn(e); });
  const vibrate = ms => { try { navigator.vibrate?.(ms); } catch {} };

  function build(el, mg, send) {
    stop();
    el.innerHTML = '';
    // Phone-side end time (a little early so final scores reach the server in time)
    const endAt = performance.now() + (mg.timeLeftMs ?? mg.durationMs) - 300;
    const timers = [];
    const every = (fn, ms) => { const t = setInterval(fn, ms); timers.push(() => clearInterval(t)); };
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(() => clearTimeout(t)); };
    const frame = fn => { let id; const loop = t => { if (fn(t) !== false) id = requestAnimationFrame(loop); }; id = requestAnimationFrame(loop); timers.push(() => cancelAnimationFrame(id)); };
    const over = () => performance.now() >= endAt;
    const cfg = mg.config || {};
    let update = () => {};

    switch (mg.controls) {
      case 'mash': {
        const b = h('button', 'mash-btn', 'TAP!');
        press(b, () => { send({ tap: true }); b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); });
        el.append(b);
        break;
      }

      case 'alternate': {
        const row = h('div', 'alt-row');
        let last = null;
        for (const side of ['L', 'R']) {
          const b = h('button', 'alt-btn', side === 'L' ? '🦶 LEFT' : 'RIGHT 🦶');
          press(b, () => {
            send({ side });
            row.querySelectorAll('.alt-btn').forEach(x => x.classList.toggle('next', x !== b));
            if (side === last) vibrate(40);
            last = side;
          });
          row.append(b);
        }
        el.append(row);
        break;
      }

      case 'reaction': {
        const pad = h('div', 'reaction-pad', 'WAIT…');
        let goAt = null, done = false, timer = null;
        press(pad, () => {
          if (done) return;
          done = true;
          if (goAt == null) { pad.textContent = 'TOO EARLY!'; send({ early: true }); return; }
          const ms = Math.round(performance.now() - goAt);
          pad.textContent = `${ms} ms`;
          send({ reactionMs: ms });
        });
        el.append(pad);
        update = m => {
          if (timer || m.live.goInMs == null) return;
          timer = setTimeout(() => { if (!done) { goAt = performance.now(); pad.classList.add('go'); pad.textContent = 'GO!'; vibrate(80); } }, m.live.goInMs);
          timers.push(() => clearTimeout(timer));
        };
        update(mg);
        break;
      }

      case 'quiz': {
        const prompt = h('div', 'quiz-prompt');
        const opts = h('div', 'quiz-options');
        const score = h('div', 'quiz-score');
        el.append(score, prompt, opts);
        let shownQid = null;
        update = m => {
          const me = m.live.perPlayer?.[window.ME];
          score.textContent = m.live.display?.[window.ME] ?? '';
          if (!me || me.qid === shownQid) return;
          shownQid = me.qid;
          prompt.textContent = me.prompt.text;
          prompt.style.color = me.prompt.color || '';
          prompt.dataset.size = me.prompt.size || 'lg';
          opts.innerHTML = '';
          opts.dataset.count = me.options.length;
          me.options.forEach((o, i) => {
            const b = h('button', 'quiz-btn', typeof o === 'string' ? o : o.text);
            if (o.color) b.style.color = o.color;
            press(b, () => { opts.querySelectorAll('button').forEach(x => { x.disabled = true; }); send({ qid: me.qid, answer: i }); });
            opts.append(b);
          });
        };
        update(mg);
        break;
      }

      case 'timing': {
        // A marker bounces across a bar; stop it in the middle. Points = accuracy (0–100).
        const track = h('div', 'timing-track');
        const zone = h('div', 'timing-zone');
        const marker = h('div', 'timing-marker');
        track.append(zone, marker);
        const info = h('div', 'big-info', `${cfg.attempts} tries left`);
        const b = h('button', 'mash-btn small', 'STOP!');
        el.append(info, track, b);
        let left = cfg.attempts, pos = 0, paused = false, total = 0;
        const start = performance.now();
        frame(t => {
          if (!paused) {
            const phase = ((t - start) % (cfg.periodMs * 2)) / cfg.periodMs; // 0..2
            pos = phase < 1 ? phase : 2 - phase;
            marker.style.left = `${pos * 100}%`;
          }
          return left > 0 && !over();
        });
        press(b, () => {
          if (!left || paused || over()) return;
          const pts = Math.max(0, Math.round(100 - Math.abs(pos - 0.5) * 200));
          total += pts; left--;
          send({ points: pts });
          paused = true;
          info.textContent = `${pts} pts! ${left ? `${left} tries left` : `Total: ${total}`}`;
          vibrate(50);
          if (left) later(() => { paused = false; }, 700);
          else b.disabled = true;
        });
        break;
      }

      case 'hold': {
        const target = cfg.targetMs;
        const b = h('button', 'mash-btn', 'HOLD');
        const info = h('div', 'big-info', `Hold for exactly ${(target / 1000).toFixed(2)}s`);
        el.append(info, b);
        let downAt = null, done = false;
        press(b, () => { if (done) return; downAt = performance.now(); b.textContent = '…'; b.classList.add('held'); });
        const release = () => {
          if (done || downAt == null) return;
          done = true;
          const held = performance.now() - downAt;
          const off = Math.round(Math.abs(held - target));
          send({ value: off });
          b.classList.remove('held');
          b.textContent = `${(held / 1000).toFixed(2)}s`;
          info.textContent = `${off} ms off`;
        };
        b.addEventListener('pointerup', release);
        b.addEventListener('pointerleave', release);
        b.addEventListener('pointercancel', release);
        break;
      }

      case 'blind': {
        const start = performance.now();
        const clock = h('div', 'blind-clock', '0.00');
        const info = h('div', 'big-info', `Tap at ${(cfg.targetMs / 1000).toFixed(2)}s`);
        const b = h('button', 'mash-btn', 'NOW!');
        el.append(info, clock, b);
        let done = false;
        frame(t => {
          const s = (t - start) / 1000;
          clock.textContent = t - start < cfg.visibleMs ? s.toFixed(2) : '?.??';
          return !done;
        });
        press(b, () => {
          if (done) return;
          done = true;
          const elapsed = performance.now() - start;
          const off = Math.round(Math.abs(elapsed - cfg.targetMs));
          clock.textContent = (elapsed / 1000).toFixed(2);
          info.textContent = `${off} ms off`;
          send({ value: off });
          b.disabled = true;
        });
        break;
      }

      case 'grid': {
        // Whack-a-mole: things pop up in a 3x3 grid; tap the good ones.
        const grid = h('div', 'mole-grid');
        const score = h('div', 'big-info', '0 pts');
        const cells = Array.from({ length: 9 }, () => { const c = h('button', 'mole-cell'); grid.append(c); return c; });
        el.append(score, grid);
        let pts = 0;
        const add = n => { pts += n; score.textContent = `${pts} pts`; send({ points: n }); };
        cells.forEach(c => press(c, () => {
          const kind = c.dataset.kind;
          if (!kind) return;
          c.dataset.kind = ''; c.textContent = '';
          if (kind === 'bomb') { add(-(cfg.bombPenalty || 2)); vibrate(150); c.classList.add('boom'); later(() => c.classList.remove('boom'), 300); }
          else { add(1); c.classList.add('hit'); later(() => c.classList.remove('hit'), 150); }
        }));
        every(() => {
          if (over()) return;
          const empty = cells.filter(c => !c.dataset.kind);
          if (!empty.length) return;
          const c = empty[Math.floor(Math.random() * empty.length)];
          const bomb = cfg.bombs && Math.random() < 0.35;
          c.dataset.kind = bomb ? 'bomb' : 'good';
          c.textContent = bomb ? '💣' : cfg.bombs ? '🪙' : '🐹';
          later(() => { if (c.dataset.kind) { c.dataset.kind = ''; c.textContent = ''; } }, cfg.spawnMs * 1.6);
        }, cfg.spawnMs);
        break;
      }

      case 'memory': {
        // Simon-style: watch the pads, then repeat. Each completed pattern = 1 level.
        const info = h('div', 'big-info', 'Watch…');
        const pads = h('div', 'memory-pads');
        const colors = ['#ff595e', '#1982c4', '#8ac926', '#ffca3a'];
        const btns = colors.map((c, i) => { const b = h('button', 'memory-pad'); b.style.background = c; b.dataset.i = i; pads.append(b); return b; });
        el.append(info, pads);
        const seq = [];
        let input = 0, accepting = false, level = 0, out = false;
        const flash = (i, ms = 350) => { btns[i].classList.add('lit'); later(() => btns[i].classList.remove('lit'), ms); };
        const playSeq = () => {
          accepting = false;
          info.textContent = `Level ${level + 1}: watch…`;
          seq.push(Math.floor(Math.random() * 4));
          seq.forEach((i, k) => later(() => flash(i), 600 + k * 550));
          later(() => { accepting = true; input = 0; info.textContent = 'Your turn!'; }, 600 + seq.length * 550);
        };
        btns.forEach((b, i) => press(b, () => {
          if (!accepting || out || over()) return;
          flash(i, 150);
          if (i !== seq[input]) { out = true; accepting = false; info.textContent = `❌ Out at level ${level}`; vibrate(200); return; }
          input++;
          if (input === seq.length) { level++; send({ value: level }); info.textContent = `✅ Level ${level}!`; later(playSeq, 700); accepting = false; }
        }));
        playSeq();
        break;
      }

      case 'rhythm': {
        // A circle pulses on each beat; tap in time. Perfect (≤70ms) = 2, Good (≤150ms) = 1.
        const beatMs = 60000 / cfg.bpm;
        const ring = h('button', 'beat-ring', '');
        const info = h('div', 'big-info', 'Tap on the beat!');
        el.append(info, ring);
        const start = performance.now() + 1000;
        const scored = new Set();
        let pts = 0;
        frame(t => {
          const since = t - start;
          if (since >= 0) {
            const k = (since % beatMs) / beatMs;
            ring.style.transform = `scale(${1 + 0.35 * Math.max(0, 1 - k * 4)})`;
          }
          return !over();
        });
        press(ring, () => {
          if (over()) return;
          const since = performance.now() - start;
          const n = Math.round(since / beatMs);
          const diff = Math.abs(since - n * beatMs);
          if (n < 0 || scored.has(n)) return;
          scored.add(n);
          const p = diff <= 70 ? 2 : diff <= 150 ? 1 : 0;
          pts += p;
          info.textContent = `${p === 2 ? 'PERFECT!' : p === 1 ? 'Good' : 'Miss'}  ·  ${pts} pts`;
          if (p) send({ points: p });
        });
        break;
      }

      default:
        el.append(h('div', 'big-info', 'Watch the TV!'));
    }

    active = { cleanup: () => timers.forEach(f => f()), update };
  }

  function update(mg) { active?.update(mg); }
  function stop() { active?.cleanup(); active = null; }

  return { build, update, stop };
})();
