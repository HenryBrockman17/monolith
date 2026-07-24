/* Drag-to-reorder rows via a grip handle. Pointer events → works for mouse
   and touch alike. Rows FLIP-animate out of the way as the dragged row
   crosses them; the new order is reported once, on drop. */

export function attachDragOrder(root, { rowSelector, gripSelector, onReorder }) {
  root.addEventListener('pointerdown', e => {
    const grip = e.target.closest(gripSelector);
    if (!grip) return;
    const row = grip.closest(rowSelector);
    if (!row) return;
    e.preventDefault();
    startDrag(e, grip, row, rowSelector, onReorder);
  });
}

function rowsOf(row, rowSelector) {
  return [...row.closest('tbody, table').querySelectorAll(rowSelector)];
}

/* FLIP: mutate the DOM, then animate the element from its old position. */
function animateShift(el, mutate) {
  const before = el.getBoundingClientRect().top;
  mutate();
  const delta = before - el.getBoundingClientRect().top;
  if (!delta) return;
  el.style.transition = 'none';
  el.style.transform = `translateY(${delta}px)`;
  requestAnimationFrame(() => {
    el.style.transition = 'transform 160ms ease';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 200);
  });
}

function startDrag(e0, grip, row, rowSelector, onReorder) {
  const startOrder = rowsOf(row, rowSelector).map(r => r.dataset.habitRow);
  let lastY = e0.clientY;
  let offset = 0;                        // visual delta from the row's DOM slot

  row.classList.add('dragging');
  document.body.classList.add('drag-noselect');

  const render = () => { row.style.transform = `translateY(${offset}px)`; };

  const move = e => {
    if (e.pointerId !== e0.pointerId) return;
    offset += e.clientY - lastY;
    lastY = e.clientY;
    render();

    for (;;) {
      const all = rowsOf(row, rowSelector);
      const i = all.indexOf(row);
      const next = all[i + 1], prev = all[i - 1];
      if (next && offset > next.offsetHeight * 0.55) {
        const before = row.getBoundingClientRect().top;
        animateShift(next, () => next.after(row));
        offset -= row.getBoundingClientRect().top - before;   // keep it under the pointer
        render();
      } else if (prev && -offset > prev.offsetHeight * 0.55) {
        const before = row.getBoundingClientRect().top;
        animateShift(prev, () => prev.before(row));
        offset -= row.getBoundingClientRect().top - before;
        render();
      } else break;
    }
  };

  const stopScroll = ev => ev.preventDefault();

  const finish = e => {
    if (e && e.pointerId !== e0.pointerId) return;
    /* NOTE: listeners live on document, never on the row/grip — Chrome and
       Safari release pointer capture (and stop delivering events) the moment
       the captured element is moved in the DOM, which is exactly what a
       reorder does. */
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    document.removeEventListener('touchmove', stopScroll);
    document.body.classList.remove('drag-noselect');
    /* settle into the DOM slot with a short glide */
    row.style.transition = 'transform 140ms ease';
    row.style.transform = '';
    setTimeout(() => {
      row.style.transition = '';
      row.classList.remove('dragging');
    }, 160);

    const endOrder = rowsOf(row, rowSelector).map(r => r.dataset.habitRow);
    if (endOrder.join() !== startOrder.join()) onReorder(endOrder);
  };

  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  /* pointer events can't cancel touch scrolling once the pointer leaves the
     grip's touch-action:none zone — a non-passive touchmove handler can */
  document.addEventListener('touchmove', stopScroll, { passive: false });
}
