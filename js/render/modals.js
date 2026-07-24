/* Habit editor modal + undo toasts. */
import { esc } from './util.js';

export function openHabitModal(opts) {
  const { habit, onSave, onArchive, onRestore, onDelete, onMove, checkCount = 0 } = opts;
  const isNew = !habit;
  close();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>${isNew ? 'New routine' : 'Edit routine'}</h3>
      <label class="field"><span>Name</span>
        <input type="text" id="mName" maxlength="40" value="${habit ? esc(habit.name) : ''}" placeholder="e.g. Gym">
      </label>
      <label class="field"><span>Emoji <em>(optional)</em></span>
        <input type="text" id="mEmoji" maxlength="8" value="${habit ? esc(habit.emoji) : ''}" placeholder="🏋️">
      </label>
      <div class="field"><span>Days per week</span>
        <div class="stepper">
          <button type="button" id="mMinus">−</button>
          <div id="mTarget">${habit ? habit.targetPerWeek : 7}</div>
          <button type="button" id="mPlus">+</button>
          <span class="stepper-hint">×/week</span>
        </div>
      </div>
      ${!isNew ? `
      <div class="field"><span>Position</span>
        <div class="row-gap">
          <button type="button" class="btn ghost" id="mUp">↑ Move up</button>
          <button type="button" class="btn ghost" id="mDown">↓ Move down</button>
        </div>
      </div>
      <div class="modal-danger">
        ${habit.archivedOn
          ? '<button type="button" class="btn ghost" id="mRestore">Restore routine</button>'
          : '<button type="button" class="btn ghost" id="mArchive">Archive routine</button>'}
        <button type="button" class="btn danger" id="mDelete">Delete…</button>
      </div>` : ''}
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="mCancel">Cancel</button>
        <button type="button" class="btn primary" id="mSave">${isNew ? 'Add routine' : 'Save'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = id => overlay.querySelector('#' + id);
  let target = habit ? habit.targetPerWeek : 7;
  const clampTarget = () => { target = Math.min(7, Math.max(1, target)); $('mTarget').textContent = target; };
  $('mMinus').onclick = () => { target--; clampTarget(); };
  $('mPlus').onclick = () => { target++; clampTarget(); };

  function close() {
    document.querySelectorAll('.modal-overlay').forEach(n => n.remove());
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

  $('mCancel').onclick = close;
  $('mSave').onclick = () => {
    const name = $('mName').value.trim();
    if (!name) { $('mName').classList.add('invalid'); $('mName').focus(); return; }
    onSave({ name, emoji: $('mEmoji').value.trim(), targetPerWeek: target });
    close();
  };
  if (!isNew) {
    $('mUp').onclick = () => onMove(-1);
    $('mDown').onclick = () => onMove(1);
    if ($('mArchive')) $('mArchive').onclick = () => { onArchive(); close(); };
    if ($('mRestore')) $('mRestore').onclick = () => { onRestore(); close(); };
    /* two-step delete: first click arms it */
    let armed = false;
    $('mDelete').onclick = () => {
      if (!armed) {
        armed = true;
        $('mDelete').textContent = `Really delete? Removes ${checkCount} check${checkCount === 1 ? '' : 's'}`;
        return;
      }
      onDelete();
      close();
    };
  }
  $('mName').focus();
}

export function openSettingsModal(opts) {
  const { settings, accents, onSave, onChangePass, onExport, onLogout, onResetDevice } = opts;
  document.querySelectorAll('.modal-overlay').forEach(n => n.remove());

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <h3>Settings</h3>
      <label class="field"><span>Board name</span>
        <input type="text" id="sBoardName" maxlength="40" value="${esc(settings.boardName)}" placeholder="daily habit tracker">
      </label>
      <div class="field"><span>Accent color</span>
        <div class="swatches" id="sSwatches">
          ${accents.map(c => `<button type="button" class="swatch${c === settings.accent ? ' sel' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
        </div>
      </div>
      <div class="modal-sep"></div>
      <details class="field">
        <summary>Change passphrase</summary>
        <div class="pass-form">
          <input type="password" id="sOldPass" placeholder="Current passphrase" autocomplete="current-password">
          <input type="password" id="sNewPass" placeholder="New passphrase (10+ chars)" autocomplete="new-password">
          <input type="password" id="sNewPass2" placeholder="Repeat new passphrase" autocomplete="new-password">
          <div class="auth-err" id="sPassErr" style="display:none"></div>
          <button type="button" class="btn ghost" id="sPassBtn">Change passphrase</button>
        </div>
      </details>
      <div class="row-gap">
        <button type="button" class="btn ghost" id="sExport">Export decrypted backup</button>
      </div>
      <div class="modal-danger">
        <button type="button" class="btn ghost" id="sLogout">Lock now (log out)</button>
        <button type="button" class="btn danger" id="sReset">Reset device…</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="sCancel">Cancel</button>
        <button type="button" class="btn primary" id="sSave">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = id => overlay.querySelector('#' + id);
  let accent = settings.accent;
  $('sSwatches').addEventListener('click', e => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    accent = b.dataset.c;
    overlay.querySelectorAll('.swatch').forEach(s => s.classList.toggle('sel', s === b));
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });

  $('sCancel').onclick = close;
  $('sSave').onclick = () => { onSave({ boardName: $('sBoardName').value.trim(), accent }); close(); };
  $('sExport').onclick = onExport;
  $('sLogout').onclick = () => { close(); onLogout(); };
  let resetArmed = false;
  $('sReset').onclick = () => {
    if (!resetArmed) {
      resetArmed = true;
      $('sReset').textContent = 'Really reset? Wipes vault + cache on this device only';
      return;
    }
    close();
    onResetDevice();
  };
  $('sPassBtn').onclick = async () => {
    const err = $('sPassErr');
    err.style.display = 'none';
    const np = $('sNewPass').value;
    if (np.length < 10) { err.textContent = 'New passphrase must be at least 10 characters.'; err.style.display = ''; return; }
    if (np !== $('sNewPass2').value) { err.textContent = 'New passphrases don’t match.'; err.style.display = ''; return; }
    $('sPassBtn').disabled = true; $('sPassBtn').textContent = 'Changing…';
    try {
      await onChangePass($('sOldPass').value, np);
      close();
    } catch (e2) {
      err.textContent = e2.message;
      err.style.display = '';
    } finally {
      $('sPassBtn').disabled = false; $('sPassBtn').textContent = 'Change passphrase';
    }
  };
}

export function showToast(msg, undoFn) {
  let wrap = document.getElementById('toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'toasts';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span>${esc(msg)}</span>`;
  if (undoFn) {
    const btn = document.createElement('button');
    btn.textContent = 'Undo';
    btn.onclick = () => { undoFn(); el.remove(); };
    el.appendChild(btn);
  }
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}
