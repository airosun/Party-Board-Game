// One emoji art set (Twemoji) for every device. Without this, each phone/TV draws emoji
// with its own system font: they look different everywhere and newer ones (🪙 🪨 …) show up
// as empty boxes on older devices. The SVGs are served by our own server from /twemoji.
//
//   Emoji.observe()        swap emoji in the page for images, now and whenever the page changes
//   Emoji.url('⭐')         image URL for one emoji (for SVG <image> and Phaser textures)
//   Emoji.split(text)      [{ emoji } | { text }] pieces, for drawing mixed text on canvas
window.Emoji = (() => {
  const RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?|[\u{1F3FB}-\u{1F3FF}])*/gu;
  // Twemoji file names drop the FE0F "emoji style" marker unless the emoji has joiners (ZWJ)
  const code = e => twemoji.convert.toCodePoint(e.includes('‍') ? e : e.replace(/️/g, ''));
  const url = e => `/twemoji/${code(e)}.svg`;
  const opts = { callback: icon => `/twemoji/${icon}.svg`, className: 'emoji' };

  function split(text) {
    const out = [];
    let last = 0;
    for (const m of String(text).matchAll(RE)) {
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push({ emoji: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }
  const all = text => [...String(text).matchAll(RE)].map(m => m[0]);

  // Parse changed parts of the page (batched per frame). SVGs (wheel, map) draw their own images.
  const pending = new Set();
  let queued = false;
  const flush = () => {
    queued = false;
    for (const node of pending) if (node.isConnected && !node.closest?.('svg')) twemoji.parse(node, opts);
    pending.clear();
  };
  function observe(root = document.body) {
    twemoji.parse(root, opts);
    new MutationObserver(muts => {
      for (const m of muts) {
        const el = m.type === 'characterData' ? m.target.parentElement : m.target;
        if (el && el.nodeType === 1) pending.add(el);
      }
      if (!queued && pending.size) { queued = true; requestAnimationFrame(flush); }
    }).observe(root, { childList: true, subtree: true, characterData: true });
  }

  return { observe, url, split, all, RE };
})();
