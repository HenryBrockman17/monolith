/* Shared render helpers. */
export const WEEK_COLORS = ['var(--w1)', 'var(--w2)', 'var(--w3)', 'var(--w4)', 'var(--w5)', 'var(--w6)'];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* One floating tooltip for the whole app. */
let tip = null;
function ensureTip() {
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'tip';
    document.body.appendChild(tip);
  }
  return tip;
}
export function showTip(html, x, y) {
  const t = ensureTip();
  t.innerHTML = html;
  t.style.display = 'block';
  t.style.left = Math.min(x + 14, window.innerWidth - 180) + 'px';
  t.style.top = (y + 16) + 'px';
}
export function hideTip() { if (tip) tip.style.display = 'none'; }

/* Split a month timeline into Sun–Sat weeks. */
export function weeksOf(tl) {
  const weeks = [];
  for (let s = 0; s < tl.length; s += 7) weeks.push(tl.slice(s, s + 7));
  return weeks;
}

export function pctRound(n, d) { return d > 0 ? Math.round(n / d * 100) : 0; }
