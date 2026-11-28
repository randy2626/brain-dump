if (window.SpeechRecognition || window.webkitSpeechRecognition) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onstart = () => { voiceSessionStart = Date.now(); };
  recognition.onresult = e => {
    const start = Math.max(0, e.resultIndex | 0);
    for (let i = start; i < e.results.length; i++) {
      const res = e.results[i];
      const text = (res[0] && res[0].transcript || '').trim();
      if (!res.isFinal) {
        if (text) voicePending = { idx: i, text };
        if (text && userWantsListening) {
          const pending = voiceBuffer ? voiceBuffer + ' ' + text : text;
          setStatus('Listening… ' + pending);
        }
        continue;
      }
      if (voiceDone.has(i)) continue;   // iOS can resend earlier finals; never add twice
      voiceDone.add(i);
      if (voicePending && voicePending.idx <= i) voicePending = null;
      if (text) queueFinalTranscript(text);
    }
  };
  recognition.onerror = e => {
    const err = (e && e.error) || '';
    if (err === 'network') {
      networkVoiceErrors += 1;
      if (networkVoiceErrors >= 3) {
        fatalVoiceError = true;
        userWantsListening = false;
        if (voiceRestartTimer) { clearTimeout(voiceRestartTimer); voiceRestartTimer = null; }
        resetMicUI(false);
        voiceErrorShown = true;
        setStatus('Voice needs an internet connection. Check it and tap the mic again.');
      } else {
        setStatus('Voice network issue, retrying…');
      }
      return;
    }
    const info = voiceErrorInfo(err);
    if (info.stop) {
      fatalVoiceError = true;
      userWantsListening = false;
      if (voiceRestartTimer) { clearTimeout(voiceRestartTimer); voiceRestartTimer = null; }
      resetMicUI(false);
    }
    if (info.msg) { voiceErrorShown = true; setStatus(info.msg); }
  };
  recognition.onend = () => {
    // Words still on screen that never got marked final (common on iPhone when you stop): keep them.
    if (voicePending && voicePending.text) {
      const t = voicePending.text;
      voicePending = null;
      queueFinalTranscript(t);
    }
    voicePending = null;
    voiceDone = new Set();
    const lasted = Date.now() - (voiceSessionStart || 0);
    if (userWantsListening && !fatalVoiceError && !IS_IOS) {
      // Desktop browsers end sessions on silence; restart, but never loop on instant ends.
      quickEnds = lasted < 1000 ? quickEnds + 1 : 0;
      if (quickEnds >= MAX_QUICK_ENDS) {
        userWantsListening = false;
        flushVoiceBuffer();
        resetMicUI(false);
        setStatus('Mic stopped. Tap the mic to keep going.');
        return;
      }
      if (voiceRestartTimer) clearTimeout(voiceRestartTimer);
      voiceRestartTimer = setTimeout(() => {
        voiceRestartTimer = null;
        if (!userWantsListening || fatalVoiceError) return;
        try {
          recognition.start();
          voiceSessionStart = Date.now();
          if (!/retrying/i.test(micStatus.textContent || '')) setStatus('Listening…');
        } catch (err) {
          const msg = String((err && err.message) || err);
          if (/already started|InvalidState/i.test(msg)) return;
          userWantsListening = false;
          resetMicUI(false);
          setStatus('Mic paused. Tap the mic to keep going.');
        }
      }, 80);
      return;
    }
    // iPhone: one session per tap (restarting would make iOS ask for the mic again).
    const endedByIOS = IS_IOS && userWantsListening && !fatalVoiceError;
    userWantsListening = false;
    flushVoiceBuffer();
    resetMicUI(false);
    if (endedByIOS && !voiceErrorShown) {
      if (!/^(Dropped|Removed)/.test(micStatus.textContent || '')) setStatus('Mic paused. Tap 🎤 to keep going.');
    }
    if (IS_IOS) maybeShowMicTip();
  };
} else {
  setStatus(UNSUPPORTED_VOICE_MSG);
}

// One-time, non-blocking tip on iPhone about the repeated mic question.
function maybeShowMicTip() {
  try {
    if (localStorage.getItem('bd-mic-tip')) return;
    localStorage.setItem('bd-mic-tip', '1');
  } catch (e) { return; }
  const msg = IS_STANDALONE
    ? 'iPhone may ask about the mic each time you open the app. Just tap Allow.'
    : 'Tip: to stop iPhone asking every time, tap aA in the address bar → Website Settings → Microphone → Allow.';
  setTimeout(() => {
    showVoiceToast(msg, null, 9000);
    const tipText = document.querySelector('#voiceToast .vt-msg');
    if (tipText) tipText.style.display = 'block'; // this one tip needs its full 3 lines, so no 2-line clamp
  }, 600);
}

let micReadyThisSession = false;
let micStream = null;
const MIC_EXPLAIN_KEY = 'bd-mic-explainer';

function micExplainerSeen() {
  try { return !!localStorage.getItem(MIC_EXPLAIN_KEY); } catch (e) { return true; }
}
function markMicExplainerSeen() {
  try { localStorage.setItem(MIC_EXPLAIN_KEY, '1'); } catch (e) {}
}
async function queryMicPermission() {
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'microphone' });
      return st && st.state ? st.state : 'unknown';
    }
  } catch (e) {}
  return 'unknown';
}
// Reuse one getUserMedia + SpeechRecognition setup per visit. Don't re-request
// if this session already got the mic, or if the permission is already granted.
async function ensureMicAccess() {
  if (micReadyThisSession) return { ok: true, state: 'granted' };
  const state = await queryMicPermission();
  if (state === 'granted') {
    micReadyThisSession = true;
    return { ok: true, state };
  }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    return { ok: true, state, skipped: true };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micReadyThisSession = true;
    micStream = stream;
    // Keep the permission, drop the live tracks so the tab isn't stuck "recording"
    // while we aren't listening. The SpeechRecognition object is reused below.
    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    micStream = null;
    return { ok: true, state: 'granted' };
  } catch (err) {
    return { ok: false, state, err };
  }
}
function captureMicExplainerText() {
  if (IS_IOS) {
    return IS_STANDALONE
      ? 'Your phone may ask to use the mic. Allow it once for this visit — we won’t keep asking in here.'
      : 'Your browser may ask to use the mic. Allow it — we won’t keep asking in this visit. (Safari in a regular tab can still re-prompt; the home-screen app is more reliable.)';
  }
  return 'Your browser may ask to use the mic. Allow it once — we won’t keep asking in this visit.';
}

function syncCaptureMicUI() {
  const btn = $('bdCapMic');
  const label = $('bdCapMicLabel');
  if (!btn) return;
  const on = !!(userWantsListening || listening);
  btn.classList.toggle('listening', on);
  btn.textContent = on ? '⏹' : '🎤';
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (label) label.textContent = on ? 'Listening… tap to stop' : 'Tap to start the mic';
}

function stopMic() {
  userWantsListening = false;
  fatalVoiceError = false;
  if (voiceRestartTimer) { clearTimeout(voiceRestartTimer); voiceRestartTimer = null; }
  flushVoiceBuffer();
  try { if (recognition) recognition.stop(); } catch (err) {}
  resetMicUI(true);
  syncCaptureMicUI();
}

function startMic() {
  if (!recognition) { setStatus(UNSUPPORTED_VOICE_MSG); return false; }
  if (userWantsListening || listening) return true;
  fatalVoiceError = false;
  networkVoiceErrors = 0;
  quickEnds = 0;
  voiceErrorShown = false;
  voiceDone = new Set();
  voicePending = null;
  voiceSessionStart = Date.now();
  userWantsListening = true;
  listening = true;
  micBtn.textContent = '⏹';
  micBtn.setAttribute('aria-label', 'Stop listening');
  micBtn.classList.add('listening');
  syncCaptureMicUI();
  try {
    recognition.start();
    setStatus('Listening…');
    const cap = $('bdCapStatus');
    if (cap) cap.textContent = 'Listening…';
    return true;
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (/already started|InvalidState/i.test(msg)) { setStatus('Listening…'); return true; }
    userWantsListening = false;
    resetMicUI(false);
    syncCaptureMicUI();
    setStatus("Couldn't start the mic. Tap it again in a second.");
    const cap = $('bdCapStatus');
    if (cap) cap.textContent = "Couldn't start the mic. Tap the big button.";
    return false;
  }
}

async function startMicWithPermission() {
  const state = await queryMicPermission();
  const skipExplainer = state === 'granted' || micReadyThisSession || micExplainerSeen();
  if (!skipExplainer && captureOpen) {
    const tip = $('bdCapTip');
    if (tip) { tip.hidden = false; tip.textContent = captureMicExplainerText(); }
    markMicExplainerSeen();
  } else if (state === 'granted' || micReadyThisSession) {
    const tip = $('bdCapTip');
    if (tip) tip.hidden = true;
  }
  const access = await ensureMicAccess();
  if (!access.ok && access.state === 'denied') {
    const msg = voiceErrorInfo('not-allowed').msg;
    setStatus(msg);
    const cap = $('bdCapStatus');
    if (cap) cap.textContent = msg;
    syncCaptureMicUI();
    return false;
  }
  return startMic();
}

function toggleMic() {
  if (!recognition) return setStatus(UNSUPPORTED_VOICE_MSG);
  if (userWantsListening || listening) stopMic();
  else startMicWithPermission();
}

function ensureCaptureUI() {
  if ($('bdCapture')) return $('bdCapture');
  const wrap = document.createElement('div');
  wrap.id = 'bdCapture';
  wrap.hidden = true;
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-labelledby', 'bdCapTitle');
  wrap.innerHTML = '<div class="bd-cap-back" data-cap-close="1"></div>' +
    '<div class="bd-cap-sheet">' +
    '<button type="button" class="bd-cap-close" data-cap-close="1" aria-label="Close capture">✕</button>' +
    '<h2 id="bdCapTitle">Quick capture</h2>' +
    '<p class="bd-cap-sub">Say it or type it. I’ll put it where you tell me, or in Unsorted.</p>' +
    '<div class="bd-cap-mic">' +
    '<button type="button" class="bd-cap-mic-btn" id="bdCapMic" aria-label="Start microphone">🎤</button>' +
    '<div class="bd-cap-mic-label" id="bdCapMicLabel">Tap to start the mic</div>' +
    '</div>' +
    '<div class="bd-cap-row">' +
    '<textarea id="bdCapInput" rows="2" placeholder="add milk to Ideas" enterkeyhint="enter"></textarea>' +
    '<button type="button" id="bdCapAdd">Add</button>' +
    '</div>' +
    '<div class="bd-cap-status" id="bdCapStatus"></div>' +
    '<p class="bd-cap-tip" id="bdCapTip" hidden></p>' +
    '</div>';
  document.body.appendChild(wrap);
  wrap.addEventListener('click', ev => {
    if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-cap-close')) closeCapture();
  });
  $('bdCapMic').onclick = () => toggleMic();
  $('bdCapAdd').onclick = () => submitCaptureInput();
  $('bdCapInput').addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submitCaptureInput(); }
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && captureOpen) { ev.preventDefault(); closeCapture(); }
  });
  return wrap;
}

function submitCaptureInput() {
  const el = $('bdCapInput');
  const text = el ? el.value.trim() : '';
  if (!text) return;
  handleCaptureText(text);
  if (el) el.value = '';
}

function isCaptureUrl() {
  try { return /[?&]capture=1(?:&|$)/.test(location.search || ''); } catch (e) { return false; }
}
function isCompareUrlMain() {
  try { return /[?&]compare=1(?:&|$)/.test(location.search || ''); } catch (e) { return false; }
}

function openCapture(opts) {
  opts = opts || {};
  if (isCompareUrlMain()) return;
  ensureCaptureUI();
  const el = $('bdCapture');
  el.hidden = false;
  captureOpen = true;
  document.documentElement.classList.add('bd-capturing');
  syncCaptureMicUI();
  const input = $('bdCapInput');
  if (opts.focusInput && input) input.focus();
  if (opts.autoStart) {
    startMicWithPermission().then(function (ok) {
      if (!ok) {
        const label = $('bdCapMicLabel');
        if (label) label.textContent = 'Tap the mic to start';
      }
    }).catch(function () {
      const label = $('bdCapMicLabel');
      if (label) label.textContent = 'Tap the mic to start';
    });
  }
}

function closeCapture() {
  captureOpen = false;
  document.documentElement.classList.remove('bd-capturing');
  const el = $('bdCapture');
  if (el) el.hidden = true;
  if (userWantsListening || listening) stopMic();
  if (isCaptureUrl()) {
    try {
      const u = new URL(location.href);
      u.searchParams.delete('capture');
      history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }
}

function maybeOpenCaptureFromUrl() {
  if (isCaptureUrl() && !isCompareUrlMain()) openCapture({ autoStart: true });
}

micBtn.onclick = () => toggleMic();

document.addEventListener('keydown', ev => {
  if (ev.altKey || ev.repeat) return;
  const space = ev.code === 'Space' || ev.key === ' ' || ev.key === 'Spacebar';
  if (!space || !ev.shiftKey || !(ev.ctrlKey || ev.metaKey)) return;
  ev.preventDefault();
  ev.stopPropagation();
  openCapture({ autoStart: true });
}, true);

window.__bdCapture = {
  open: openCapture,
  close: closeCapture,
  isOpen: function () { return !!captureOpen; },
  submit: handleCaptureText,
  startMic: startMicWithPermission,
  resolve: resolveCaptureDest
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maybeOpenCaptureFromUrl);
else maybeOpenCaptureFromUrl();


(function initVoicePause() {
  const el = $('voicePause');
  if (!el) return;
  const stored = localStorage.getItem('bd-voice-pause');
  const valid = [...el.options].some(o => o.value === stored);
  el.value = valid ? stored : String(DEFAULT_VOICE_PAUSE_MS);
  el.onchange = () => localStorage.setItem('bd-voice-pause', el.value);
})();

// PREVIEW wiring: due tag taps, search, trackers
listEl.addEventListener('click', e => {
  const tag = e.target.closest('.due-tag');
  if (!tag) return;
  e.stopPropagation();
  const it = items.find(i => i.id == tag.dataset.id);
  if (it) openDueSheet(it);
}, true);
(function initSearch() {
  const s = $('searchInput');
  if (!s) return;
  s.addEventListener('input', () => { searchQuery = s.value; render(); });
  s.addEventListener('keydown', e => { if (e.key === 'Escape') { s.value = ''; searchQuery = ''; render(); } });
  $('searchClear').onclick = () => { s.value = ''; searchQuery = ''; render(); s.focus(); };
})();
initTrackers();
setInterval(() => { if (items.some(i => i.due && !i.deleted)) render(); }, 30 * 60 * 1000); // keep due colors fresh

initProfileUI();

// PREVIEW combined: touch-friendly category header
let lastPointerType = 'mouse';
let touchToggleAt = 0;
document.addEventListener('pointerdown', e => { lastPointerType = e.pointerType || 'mouse'; }, true);
function unwireDismiss(sel) {
  document.querySelectorAll(sel).forEach(p => {
    if (p._sheetDismiss) p._sheetDismiss();
    p.remove();
  });
}
function wireDismiss(el, closeFn) {
  if (!el) return;
  const back = document.createElement('div');
  back.className = 'sheet-backdrop';
  back.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); closeFn(); });
  document.body.insertBefore(back, el);
  const onKey = ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeFn(); }
  };
  document.addEventListener('keydown', onKey, true);
  el._sheetDismiss = () => {
    document.removeEventListener('keydown', onKey, true);
    if (back.parentNode) back.remove();
    delete el._sheetDismiss;
  };
}
function closeCatSheet() { unwireDismiss('.cat-sheet'); }
function openCatSheet(name) {
  closeCatSheet();
  const safe = name.replace(/"/g, '');
  const header = document.querySelector(`.group-header[data-cat="${safe}"]`);
  const canSub = !!header && !!header.querySelector('.add-sub');
  const div = document.createElement('div');
  div.className = 'cat-sheet';
  div.innerHTML = `<div class="cat-sheet-title">${esc(typeof catPath === 'function' ? catPath(name) : name)}</div>
    <button type="button" class="secondary" data-act="rename">✏️ Rename</button>
    <button type="button" class="secondary" data-act="color">Change color</button>
    ${canSub ? '<button type="button" class="secondary" data-act="sub">➕ Add subcategory</button>' : ''}
    <button type="button" class="danger" data-act="delete">🗑 Delete category</button>
    <button type="button" class="secondary" data-act="close">Close</button>`;
  div.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    closeCatSheet();
    const h = document.querySelector(`.group-header[data-cat="${safe}"]`);
    if (act === 'rename' && h) { lastPointerType = 'mouse'; const n = h.querySelector('.cat-name'); if (n) n.click(); }
    else if (act === 'color') showColorPicker(name);
    else if (act === 'sub' && h) { const s = h.querySelector('.add-sub'); if (s) s.click(); }
    else if (act === 'delete' && h) { const d = h.querySelector('.del-cat'); if (d) d.click(); }
  });
  document.body.appendChild(div);
  wireDismiss(div, closeCatSheet);
}
listEl.addEventListener('click', e => {
  const menu = e.target.closest('.cat-menu');
  if (menu) { e.stopPropagation(); openCatSheet(menu.dataset.cat); return; }
  if (lastPointerType === 'mouse') return;
  const name = e.target.closest('.cat-name');
  if (name) { // touch: tap the name = add to this category (rename is in ⋯)
    e.stopPropagation();
    const h = name.closest('.group-header');
    if (h) h.click();
    return;
  }
  const arrow = e.target.closest('.arrow');
  if (arrow && arrow.closest('.group-header') && arrow.closest('.group-header').dataset.cat !== 'Finished') { // touch: single tap collapses
    e.stopPropagation();
    touchToggleAt = Date.now();
    arrow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }
}, true);
listEl.addEventListener('dblclick', e => {
  // ignore the browser's own double-tap dblclick right after a touch toggle
  if (e.isTrusted && Date.now() - touchToggleAt < 700) e.stopImmediatePropagation();
}, true);

// Auto-clean old deleted
setInterval(() => {
  const cutoff = Date.now() - 48*60*60*1000;
  const before = items.length;
  items = items.filter(i => !i.deleted || (i.deletedAt || 0) > cutoff);
  if (items.length !== before) { save(); render(); }
}, 60000);

// Touch: long-press then drag to reorder items or Front-page categories.
// Aborts if the finger moves first (scroll wins). Native HTML5 dragstart cancels this path.
(function hookPointerReorder() {
  const HOLD = 420, MOVE = 12;
  let timer = null, startX = 0, startY = 0, mode = null, srcEl = null, ghost = null, pointerId = null, lastEv = null;
  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
  function hit(x, y) { return document.elementFromPoint(x, y); }
  function liftGhost(el, ev) {
    if (ghost) ghost.remove();
    ghost = el.cloneNode(true);
    ghost.className = (el.className || '') + ' nb-drag-ghost';
    ghost.removeAttribute('id');
    ghost.style.position = 'fixed';
    ghost.style.left = ev.clientX + 'px';
    ghost.style.top = ev.clientY + 'px';
    ghost.style.width = Math.min(el.getBoundingClientRect().width, window.innerWidth * 0.8) + 'px';
    ghost.style.margin = '0';
    ghost.style.pointerEvents = 'none';
    ghost.style.zIndex = '80';
    ghost.style.opacity = '0.9';
    document.body.appendChild(ghost);
  }
  function moveGhost(ev) {
    if (!ghost) return;
    ghost.style.left = (ev.clientX + 8) + 'px';
    ghost.style.top = (ev.clientY - 10) + 'px';
  }
  function end() {
    clearTimer();
    if (ghost) { ghost.remove(); ghost = null; }
    if (srcEl) srcEl.classList.remove('nb-dragging');
    document.querySelectorAll('.group-header, .group-items').forEach(z => { z.style.background = ''; });
    mode = null; srcEl = null; pointerId = null; lastEv = null;
    cancelNest();
    nestDragId = null;
    catDragName = null;
    clearDropMarks();
    setTimeout(() => { itemWasDragged = false; catWasDragged = false; }, 0);
  }
  function startFrom(el, ev, kind) {
    mode = kind;
    srcEl = el;
    el.classList.add('nb-dragging');
    liftGhost(el, ev);
    if (kind === 'item') {
      itemWasDragged = true;
      nestDragId = el.dataset.id;
      catDragName = null;
    } else {
      catWasDragged = true;
      catDragName = el.dataset.cat;
      nestDragId = null;
    }
  }
  function applyOver(ev) {
    lastEv = ev;
    moveGhost(ev);
    const t = hit(ev.clientX, ev.clientY);
    const overItem = t && t.closest ? t.closest('.item[data-id]') : null;
    const overHead = t && t.closest ? t.closest('.group-header') : null;
    const zone = t && t.closest ? t.closest('.group-header, .group-items') : null;
    document.querySelectorAll('.nb-drop-before, .nb-drop-after').forEach(n => n.classList.remove('nb-drop-before', 'nb-drop-after'));
    document.querySelectorAll('.group-header, .group-items').forEach(z => { z.style.background = ''; });
    if (mode === 'cat') {
      if (isReorderableHeader(overHead) && overHead.dataset.cat !== catDragName) {
        overHead.classList.add(dropAfter(overHead, ev) ? 'nb-drop-after' : 'nb-drop-before');
      }
      return;
    }
    if (overItem) {
      const fake = { target: overItem, clientY: ev.clientY };
      trackNestHover(fake);
    } else {
      cancelNest();
    }
    if (overItem && !nestReady && String(overItem.dataset.id) !== String(nestDragId)) {
      overItem.classList.add(dropAfter(overItem, ev) ? 'nb-drop-after' : 'nb-drop-before');
    } else if (zone && !(nestReady && zone.contains(document.querySelector('.item.nest-target')))) {
      zone.style.background = 'rgba(96,165,250,0.1)';
    }
  }
  function dropAt(ev) {
    const t = hit(ev.clientX, ev.clientY) || (ev.target && ev.target.closest ? ev.target : null);
    const overItem = t && t.closest ? t.closest('.item[data-id]') : null;
    const overHead = t && t.closest ? t.closest('.group-header') : null;
    const zone = t && t.closest ? t.closest('.group-header, .group-items') : null;
    if (mode === 'cat') {
      const target = isReorderableHeader(overHead) ? overHead : (isReorderableHeader(zone) ? zone : null);
      const name = catDragName;
      if (target && target.dataset.cat !== name) reorderTopCats(name, target.dataset.cat, dropAfter(target, ev));
      return;
    }
    const id = nestDragId;
    if (nestReady && nestTargetId != null && overItem && String(overItem.dataset.id) === String(nestTargetId)) {
      const tid = nestTargetId;
      if (makeSubFromItem(tid, id)) return;
    }
    const cat = zone ? (zone.dataset.for || zone.dataset.cat) : null;
    if (overItem) {
      placeItemAt(id, overItem.dataset.id, dropAfter(overItem, ev), cat || overItem.closest('.group-items') && overItem.closest('.group-items').dataset.for);
      return;
    }
    if (cat && cat !== 'Recently Deleted' && cat !== 'Let go') {
      const it = items.find(i => String(i.id) === String(id));
      if (it) {
        it.category = (cat === 'Uncategorized' || cat === 'Finished') ? '' : cat;
        it.color = getColor(it.category);
        if (cat !== 'Finished') { it.ghosted = false; it.finishedAt = null; }
        save(); render();
      }
    }
  }
  document.addEventListener('pointerdown', ev => {
    if (ev.pointerType !== 'touch' || ev.button) return;
    if (ev.target && ev.target.closest && ev.target.closest('input, textarea, select, button, a, .color-picker, .cat-sheet, .kind-sheet')) return;
    const item = ev.target.closest && ev.target.closest('.item[draggable]');
    const header = ev.target.closest && ev.target.closest('.group-header');
    const kind = item ? 'item' : (isReorderableHeader(header) ? 'cat' : null);
    const el = kind === 'item' ? item : header;
    if (!kind || !el) return;
    startX = ev.clientX; startY = ev.clientY; pointerId = ev.pointerId;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      startFrom(el, ev, kind);
      try { el.setPointerCapture(ev.pointerId); } catch (e) {}
    }, HOLD);
  }, true);
  document.addEventListener('dragstart', () => { clearTimer(); }, true);
  document.addEventListener('pointermove', ev => {
    if (pointerId != null && ev.pointerId !== pointerId) return;
    if (timer) {
      if (Math.abs(ev.clientX - startX) > MOVE || Math.abs(ev.clientY - startY) > MOVE) clearTimer();
      return;
    }
    if (!mode) return;
    ev.preventDefault();
    applyOver(ev);
  }, { capture: true, passive: false });
  function finishPointer(ev) {
    if (pointerId != null && ev.pointerId !== pointerId) return;
    if (timer) { clearTimer(); pointerId = null; return; }
    if (!mode) return;
    ev.preventDefault();
    try { dropAt(ev); } finally { end(); }
  }
  document.addEventListener('pointerup', finishPointer, true);
  document.addEventListener('pointercancel', ev => {
    if (pointerId != null && ev.pointerId !== pointerId) return;
    clearTimer();
    if (mode) end();
    else pointerId = null;
  }, true);
})();

if ((location.protocol === 'http:' || location.protocol === 'https:') && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();

// --- tracker-preview helpers: ?demo=1 seed + placement hooks. Capture/organize flow unchanged. ---
(function () {
  const placement = document.body.getAttribute('data-tracker-place') || 'top';

  function openTrackerView(showForm) {
    const panel = document.getElementById('trackers');
    if (!panel) return;
    if (placement === 'tab') {
      panel.classList.add('open');
      const tab = document.getElementById('trackerToggle');
      if (tab) tab.classList.add('active');
      if (showForm) {
        const f = document.getElementById('trackerForm');
        if (f) { f.style.display = 'flex'; const t = document.getElementById('trackerText'); if (t) t.focus(); }
      }
    } else if (placement === 'strip') {
      panel.classList.add('open');
      const strip = document.getElementById('trackerStrip');
      if (strip) strip.setAttribute('aria-expanded', 'true');
      if (showForm) {
        const f = document.getElementById('trackerForm');
        if (f) { f.style.display = 'flex'; const t = document.getElementById('trackerText'); if (t) t.focus(); }
      }
    }
  }

  window.openTrackerView = openTrackerView;

  function updateStrip() {
    const el = document.getElementById('trackerStripText');
    if (!el) return;
    if (!trackers.length) {
      el.textContent = 'No trackers yet — tap + to start';
      return;
    }
    el.innerHTML = trackers.map(t => {
      const done = t.count >= t.target;
      const streak = t.streak ? ` ${t.streak}d` : '';
      const name = t.label;
      return `<span class="strip-bit${done ? ' done' : ''}"><strong>${esc(name)}</strong> ${t.count}/${t.target}${streak}</span>`;
    }).join('<span class="strip-dot">·</span>');
  }

  const _renderTrackers = renderTrackers;
  renderTrackers = function () {
    _renderTrackers();
    // Show a streak on each card when we have one
    document.querySelectorAll('.tracker[data-tid]').forEach(row => {
      const t = trackers.find(x => String(x.id) === String(row.dataset.tid));
      if (!t) return;
      const sub = row.querySelector('.tracker-sub');
      if (!sub) return;
      const done = t.count >= t.target;
      const bits = [];
      bits.push(done ? ('Done ' + PERIOD_WORD[t.period] + ' 🎉') : PERIOD_WORD[t.period]);
      if (t.streak) bits.push('<span class="tracker-streak">' + t.streak + '-day streak</span>');
      if (!done) bits.push(daysLeftText(t.period));
      sub.innerHTML = bits.join(' · ');
    });
    updateStrip();
  };

  const _addTracker = addTracker;
  addTracker = function (label, target, period) {
    const t = _addTracker(label, target, period);
    if (placement !== 'top') openTrackerView(false);
    renderTrackers();
    return t;
  };

  if (placement === 'tab') {
    const btn = document.getElementById('trackerToggle');
    if (btn) btn.onclick = () => {
      const panel = document.getElementById('trackers');
      const opening = !panel.classList.contains('open');
      if (opening) {
        openTrackerView(true);
      } else {
        const f = document.getElementById('trackerForm');
        if (f && f.style.display === 'flex') {
          f.style.display = 'none';
        } else {
          panel.classList.remove('open');
          btn.classList.remove('active');
          if (f) f.style.display = 'none';
        }
      }
    };
    const closeBtn = document.getElementById('trackerTabClose');
    if (closeBtn) closeBtn.onclick = () => {
      const panel = document.getElementById('trackers');
      panel.classList.remove('open');
      btn.classList.remove('active');
      const f = document.getElementById('trackerForm');
      if (f) f.style.display = 'none';
    };
  }

  if (placement === 'strip') {
    const strip = document.getElementById('trackerStrip');
    const btn = document.getElementById('trackerToggle');
    if (strip) strip.onclick = () => {
      const panel = document.getElementById('trackers');
      const opening = !panel.classList.contains('open');
      if (opening) {
        openTrackerView(false);
      } else {
        panel.classList.remove('open');
        strip.setAttribute('aria-expanded', 'false');
        const f = document.getElementById('trackerForm');
        if (f) f.style.display = 'none';
      }
    };
    if (btn) btn.onclick = () => {
      openTrackerView(true);
    };
  }

  function seedDemo() {
    try {
      if (!/[?&]demo=1(?:&|$)/.test(location.search || '')) return;
      const raw = localStorage.getItem('bd-items');
      if (raw && raw !== '[]') return;
    } catch (err) {
      return;
    }
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const at = n => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d.toISOString(); };
    categories = [
      { name: 'Work', color: '#82b1ff' },
      { name: 'AccuLynx', color: '#ffd180', parent: 'Work' },
      { name: 'Estimates', color: '#ffd180', parent: 'AccuLynx' },
      { name: 'Home', color: '#b9f6ca' },
      { name: 'Goals', color: '#ea80fc' }
    ];
    currentCat = 'Estimates';
    items = [
      { id: now + 1, text: 'Call Mike about the Johnson estimate', category: 'Estimates', color: '#ffd180', ghosted: false, finishedAt: null, due: at(2), deleted: false, selected: false },
      { id: now + 2, text: 'Follow up on the roofing bid for the Millers', category: 'Estimates', color: '#ffd180', ghosted: false, finishedAt: null, due: null, deleted: false, selected: false },
      { id: now + 3, text: 'Order materials for next week', category: 'Work', color: '#82b1ff', ghosted: false, finishedAt: null, due: at(5), deleted: false, selected: false },
      { id: now + 4, text: 'Pick up milk and coffee on the way home', category: 'Home', color: '#b9f6ca', ghosted: false, finishedAt: null, due: at(0), deleted: false, selected: false },
      { id: now + 5, text: 'Fix the leaky faucet in the hall bath', category: 'Home', color: '#b9f6ca', ghosted: false, finishedAt: null, due: null, deleted: false, selected: false },
      { id: now + 6, text: 'Be more present at dinner — phone in the other room', category: 'Goals', color: '#ea80fc', ghosted: false, finishedAt: null, due: null, deleted: false, selected: false },
      { id: now + 7, text: 'Walk 20 minutes after work this week', category: 'Goals', color: '#ea80fc', ghosted: false, finishedAt: null, due: null, deleted: false, selected: false }
    ];
    collapsed = { Goals: true };
    trackers = [
      { id: now + 101, label: 'Water', target: 8, period: 'day', count: 5, streak: 4, periodKey: periodKey('day'), created: now - 4 * day },
      { id: now + 102, label: 'Workout', target: 1, period: 'day', count: 1, streak: 6, periodKey: periodKey('day'), created: now - 6 * day },
      { id: now + 103, label: 'Read 10 pages', target: 10, period: 'day', count: 4, streak: 2, periodKey: periodKey('day'), created: now - 2 * day }
    ];
    profile = { become: ['More present', 'Healthier'], becomeText: '', matters: 'feeling good and keeping promises', nudge: 'light', setupDone: true, skipped: false };
    saveProfile(profile);
    const welcome = document.getElementById('welcome');
    if (welcome) { welcome.style.display = 'none'; welcome.innerHTML = ''; }
    save();
    saveTrackers();
    if (typeof renderWhy === 'function') renderWhy();
    render();
    renderTrackers();
  }

  seedDemo();
  if (placement === 'strip') updateStrip();
})();


// Theme finish motion. Does not change capture or organize flow.
(function () {
  const seenIds = new Set();
  function decorateItems() {
    document.querySelectorAll('.item[data-id]').forEach(el => {
      const id = el.dataset.id;
      if (!seenIds.has(id)) {
        seenIds.add(id);
        el.classList.add('item-enter');
      }
      if (el.classList.contains('ghosted') && !el.dataset.finishMarked) {
        el.dataset.finishMarked = '1';
        el.classList.add('item-finish');
      }
    });
  }
  if (typeof listEl !== 'undefined' && listEl) {
    new MutationObserver(decorateItems).observe(listEl, { childList: true, subtree: true });
    decorateItems();
  }
  document.addEventListener('click', function (e) {
    const t = e.target;
    if (!t || !t.classList || !t.classList.contains('done')) return;
    spawnFinishFX(t);
  }, true);
  function spawnFinishFX(origin) {
    let root = document.getElementById('finish-fx');
    if (!root) {
      root = document.createElement('div');
      root.id = 'finish-fx';
      root.setAttribute('aria-hidden', 'true');
      document.body.appendChild(root);
    }
    const theme = document.documentElement.getAttribute('data-theme') || currentTheme || 'warm';
    const r = origin.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const n = theme === 'playful' ? 22 : (theme === 'bold' ? 10 : 12);
    const colors = theme === 'playful'
      ? ['#ff6b9a', '#ffd166', '#6bcbff', '#b388ff', '#80e5a0', '#ff9f6b']
      : theme === 'warm'
        ? ['#c45c26', '#e8b86d', '#7a9e7e', '#d4a574']
        : theme === 'bold'
          ? ['#f5c518', '#ffffff', '#ff8a00']
          : ['#5eead4', '#a78bfa', '#93c5fd'];
    for (let i = 0; i < n; i++) {
      const p = document.createElement('span');
      p.className = 'fx-particle';
      const ang = (Math.PI * 2 * i) / n + Math.random() * 0.35;
      const dist = 36 + Math.random() * 74;
      p.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
      p.style.setProperty('--dy', (Math.sin(ang) * dist) + 'px');
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.color = colors[i % colors.length];
      p.style.background = colors[i % colors.length];
      root.appendChild(p);
      setTimeout(function () { p.remove(); }, 900);
    }
  }
})();

// Live handwritten date/time on the Warm paper page (the device's local time zone).
(function () {
  function fmt() {
    const el = document.getElementById('pageWhen');
    if (!el) return;
    const warm = document.documentElement.getAttribute('data-theme') === 'warm';
    if (!warm) { el.textContent = ''; return; }
    try {
      const now = (typeof window.__bdNow === 'number') ? new Date(window.__bdNow) : new Date();
      const day = now.toLocaleDateString('en-US', { weekday: 'short' });
      const mon = now.toLocaleDateString('en-US', { month: 'short' });
      const d = now.toLocaleDateString('en-US', { day: 'numeric' });
      let t = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      t = t.replace(/\u202f/g, ' ').replace(/\s+/g, ' ').trim();
      el.textContent = day + ', ' + mon + ' ' + d + ' · ' + t;
    } catch (e) {}
  }
  window.__bdUpdatePageWhen = fmt;
  fmt();
  setInterval(fmt, 15000);
})();


/* ===== TEST: notebook pages ===== */
/* TEST: notebook pages, contents, and a Settings page with on/off extras. */
(function () {
  "use strict";
  if (window.__bdNotebook) return;
  function isCompareUrl() {
    try { return /[?&]compare=1(?:&|$)/.test(location.search || ""); } catch (e) { return false; }
  }
  if (isCompareUrl()) return;

  var EXTRAS_KEY = "bd-extras";
  var DEFAULT_EXTRAS = { friend: false, checkins: false, weekly: false, trackers: false, goals: false, looks: false };
  var FRONT = "front";
  var SETTINGS = "settings";
  var MAX_CAT_TABS = 6;
  var nbPage = FRONT;
  var extrasState = null;
  var flipping = false;
  var flipTimer = null;
  var paperCache = null;
  var paperCacheTimer = null;
  var reduced = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

  function $(id) { return document.getElementById(id); }
  function extras() {
    if (extrasState) return extrasState;
    try { extrasState = Object.assign({}, DEFAULT_EXTRAS, JSON.parse(localStorage.getItem(EXTRAS_KEY) || "null") || {}); }
    catch (e) { extrasState = Object.assign({}, DEFAULT_EXTRAS); }
    return extrasState;
  }
  function saveExtras() {
    try { localStorage.setItem(EXTRAS_KEY, JSON.stringify(extrasState)); } catch (e) {}
  }
  function isSimple() {
    var x = extras();
    return !x.friend && !x.checkins && !x.weekly && !x.trackers && !x.goals && !x.looks;
  }
  function topLevelCats() {
    var list;
    if (typeof orderedCats === "function") {
      list = orderedCats().filter(function (o) { return o.depth === 1 && typeof findCat === "function" && findCat(o.name); })
        .map(function (o) { return findCat(o.name); });
    } else {
      list = (categories || []).filter(function (c) { return c && !c.parent; });
    }
    var hasU = typeof unsortedHasItems === "function" && unsortedHasItems();
    list = list.filter(function (c) { return !(c && c.name && String(c.name).toLowerCase() === "unsorted") || hasU; });
    if (hasU && !list.some(function (c) { return c && String(c.name).toLowerCase() === "unsorted"; })) {
      list.unshift(typeof getUnsortedCat === "function" ? getUnsortedCat() : { name: "Unsorted", color: "#d4c4ae" });
    } else if (hasU) {
      var u = list.filter(function (c) { return c && String(c.name).toLowerCase() === "unsorted"; });
      var rest = list.filter(function (c) { return !(c && String(c.name).toLowerCase() === "unsorted"); });
      list = u.concat(rest);
    }
    return list;
  }
  function pageIds() {
    return [FRONT].concat(topLevelCats().map(function (c) { return c.name; })).concat([SETTINGS]);
  }
  function pageIndex(id) {
    var ids = pageIds();
    var i = ids.indexOf(id);
    return i < 0 ? 0 : i;
  }
  function namesIn(name) {
    var out = [name];
    if (typeof descendantsOf === "function") out = out.concat(descendantsOf(name));
    return out;
  }
  function countIn(name, pred) {
    var set = namesIn(name);
    return (items || []).filter(function (it) {
      if (it.deleted || it.letGo) return false;
      if (set.indexOf(it.category) < 0) return false;
      return pred ? pred(it) : true;
    }).length;
  }
  function frontCount() {
    return (items || []).filter(function (it) { return !it.deleted && !it.letGo; }).length;
  }
  function liveItems() {
    return (items || []).filter(function (it) { return !it.deleted && !it.letGo; });
  }

  function ensureChrome() {
    if ($("nbTabs")) return;
    var body = document.body;
    var tabs = document.createElement("nav");
    tabs.id = "nbTabs";
    tabs.className = "nb-tabs";
    tabs.setAttribute("aria-label", "Notebook pages");
    body.appendChild(tabs);

    var bd = document.createElement("div");
    bd.id = "nbTocBackdrop";
    bd.className = "nb-toc-backdrop";
    bd.hidden = true;
    body.appendChild(bd);

    var toc = document.createElement("div");
    toc.id = "nbToc";
    toc.className = "nb-toc";
    toc.hidden = true;
    toc.setAttribute("role", "dialog");
    toc.setAttribute("aria-label", "Contents");
    body.appendChild(toc);

    var settings = document.createElement("div");
    settings.id = "nbSettingsPage";
    settings.className = "nb-settings";
    settings.hidden = true;
    var extrasBox = document.createElement("div");
    extrasBox.id = "nbExtras";
    settings.appendChild(extrasBox);
    var oldSettings = $("settings");
    if (oldSettings) settings.appendChild(oldSettings);
    var more = document.createElement("div");
    more.id = "nbMoreSettings";
    settings.appendChild(more);
    var list = $("list");
    if (list && list.parentNode) list.parentNode.insertBefore(settings, list.nextSibling);
    else body.appendChild(settings);

    var ghost = document.createElement("div");
    ghost.id = "nbFlipGhost";
    ghost.className = "nb-flip-ghost";
    ghost.hidden = true;
    ghost.setAttribute("aria-hidden", "true");
    body.appendChild(ghost);

    bd.addEventListener("click", function () { nbCloseToc(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (!$("nbToc").hidden) { e.preventDefault(); nbCloseToc(); } }
    });
  }

  function renderTabs() {
    var nav = $("nbTabs");
    if (!nav) return;
    var cats = topLevelCats();
    var overflow = cats.length > MAX_CAT_TABS;
    var shown = overflow ? cats.slice(0, MAX_CAT_TABS) : cats;
    var html = "";
    var tocOpen = $("nbToc") && !$("nbToc").hidden;
    function tab(id, label, color) {
      var isPage = id !== "contents" && id !== "more";
      var on = (isPage && nbPage === id) ? " is-on" : "";
      if (id === "contents" && tocOpen) on += " is-open";
      var style = color ? ' style="background:' + color + ';"' : "";
      var extra = id === "contents" ? ' id="nbContentsTab" aria-haspopup="dialog" aria-controls="nbToc" aria-expanded="' + (tocOpen ? "true" : "false") + '"' : "";
      return '<button type="button" class="nb-tab' + on + '" data-page="' + escAttr(id) + '"' + style + extra +
        ' aria-label="' + escAttr(label) + '" aria-current="' + (isPage && nbPage === id ? "page" : "false") + '" title="' + escAttr(label) + '"><span>' + escHtml(label) + "</span></button>";
    }
    html += tab(FRONT, "Front", "");
    html += tab("contents", "Contents", "");
    shown.forEach(function (c) { html += tab(c.name, shortLabel(c.name), c.color || "#e0d2bc"); });
    if (overflow) html += tab("more", "···", "");
    html += tab(SETTINGS, "Settings", "");
    nav.innerHTML = html;
    nav.querySelectorAll(".nb-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-page");
        if (id === "contents" || id === "more") nbOpenToc();
        else nbGo(id);
      });
    });
  }

  function shortLabel(name) {
    name = String(name || "");
    return name.length > 10 ? name.slice(0, 9) + "…" : name;
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function escAttr(s) { return escHtml(s).replace(/\n/g, " "); }

  function renderToc() {
    var toc = $("nbToc");
    if (!toc) return;
    var rows = "";
    function row(id, name, count, color, sub, jumpId) {
      var on = (jumpId || id) === nbPage || (id === FRONT && nbPage === FRONT) || (id === SETTINGS && nbPage === SETTINGS);
      var pip = color
        ? '<span class="nb-pip" style="background:' + color + ';"></span>'
        : '<span class="nb-pip" style="background:#f4ead8;box-shadow:0 0 0 1px rgba(90,60,20,0.28);"></span>';
      var cnt = (count == null) ? "" : '<span class="nb-toc-count">' + count + "</span>";
      return '<li><button type="button" class="' + (on ? "is-on " : "") + (sub ? "is-sub" : "") + '" data-jump="' + escAttr(jumpId || id) + '">' +
        pip + '<span class="nb-toc-name">' + escHtml(name) + "</span>" + cnt + "</button></li>";
    }
    var fc = frontCount();
    var fd = liveItems().filter(function (it) { return it.ghosted; }).length;
    rows += row(FRONT, "Front page", fd + "/" + fc, "", false, FRONT);
    topLevelCats().forEach(function (c) {
      var total = countIn(c.name);
      var done = countIn(c.name, function (it) { return it.ghosted; });
      rows += row(c.name, c.name, done + "/" + total, c.color, false, c.name);
      (typeof childrenOf === "function" ? childrenOf(c.name) : []).forEach(function (k) {
        var t = countIn(k.name);
        var d = countIn(k.name, function (it) { return it.ghosted; });
        rows += row(k.name, k.name, d + "/" + t, k.color || c.color, true, c.name);
      });
    });
    rows += row(SETTINGS, "Settings", null, "", false, SETTINGS);
    toc.innerHTML = '<div class="nb-toc-head"><h2>Contents</h2><button type="button" class="nb-toc-close" id="nbTocClose" aria-label="Close contents">✕</button></div>' +
      '<p class="nb-toc-note">Tap a page to flip straight there.</p>' +
      '<ul class="nb-toc-list">' + rows + "</ul>";
    $("nbTocClose").onclick = function () { nbCloseToc(); };
    toc.querySelectorAll("[data-jump]").forEach(function (btn) {
      btn.onclick = function () {
        var id = btn.getAttribute("data-jump");
        nbCloseToc();
        nbGo(id);
      };
    });
  }

  function nbOpenToc() {
    renderToc();
    $("nbToc").hidden = false;
    $("nbTocBackdrop").hidden = false;
    syncContentsTab(true);
  }
  function nbCloseToc() {
    var toc = $("nbToc"), bd = $("nbTocBackdrop");
    if (toc) toc.hidden = true;
    if (bd) bd.hidden = true;
    syncContentsTab(false);
  }
  function syncContentsTab(open) {
    var btn = $("nbContentsTab") || document.querySelector('.nb-tab[data-page="contents"]');
    if (!btn) return;
    btn.classList.toggle("is-open", !!open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function syncPageLock() {
    if (typeof workingItemId !== "undefined" && nbPage !== FRONT && nbPage !== SETTINGS) {
      // Keep adds going to this page (or a sub the user already picked on it).
      var allowed = namesIn(nbPage);
      if (!currentCat || allowed.indexOf(currentCat) < 0) {
        currentCat = nbPage;
        workingItemId = null;
        if (typeof save === "function") save();
      }
    } else if (nbPage === SETTINGS) {
      // don't change currentCat
    }
  }

  function nbAfterRender() {
    syncPageLock();
    filterListToPage();
    try { syncTipBubbles(); } catch (e) {}
    if (nbPage === SETTINGS) {
      $("nbSettingsPage").hidden = false;
      nbRenderSettings();
    } else {
      $("nbSettingsPage").hidden = true;
    }
    nbApplyExtras();
    renderTabs();
    syncTopbar();
    if (typeof markWorkingSpot === "function") markWorkingSpot({ scroll: false });
    if (typeof updateAddingTo === "function") updateAddingTo();
    if (!flipping) schedulePaperCache();
  }

  function filterListToPage() {
    var list = $("list");
    if (!list || nbPage === FRONT || nbPage === SETTINGS) return;
    var keep = namesIn(nbPage);
    list.querySelectorAll(".group-header, .group-items").forEach(function (el) {
      var name = el.getAttribute("data-cat") || el.getAttribute("data-for") || "";
      if (!name) return;
      if (name === "Finished" || name === "Recently Deleted" || name === "Let go") {
        el.style.display = "none";
        return;
      }
      if (keep.indexOf(name) < 0) el.style.display = "none";
    });
    // A quiet note on a truly empty page (sub-pages with items count as not empty).
    if (list.querySelector(".page-empty") || (searchQuery || "").trim()) return;
    if (items.some(function (i) { return !i.deleted && !i.letGo && keep.indexOf(i.category) >= 0; })) return;
    var area = Array.prototype.find.call(list.querySelectorAll(".group-items"), function (el) {
      return el.getAttribute("data-for") === nbPage;
    });
    if (!area) return;
    var note = document.createElement("div");
    note.className = "page-empty";
    note.textContent = uiCopyText("emptyPage", null, "Nothing on this page yet. Type or talk to add something.");
    if (area.classList.contains("collapsed")) area.parentNode.insertBefore(note, area.nextSibling);
    else area.appendChild(note);
  }

  function syncTopbar() {
    document.documentElement.setAttribute("data-nb-page", nbPage);
    document.documentElement.classList.toggle("nb-simple", isSimple() && nbPage === FRONT);
  }

  function nbApplyExtras() {
    var x = extras();
    var root = document.documentElement;
    root.classList.toggle("nb-x-friend", !!x.friend);
    root.classList.toggle("nb-x-checkins", !!x.checkins);
    root.classList.toggle("nb-x-weekly", !!x.weekly);
    root.classList.toggle("nb-x-trackers", !!x.trackers);
    root.classList.toggle("nb-x-goals", !!x.goals);
    root.classList.toggle("nb-x-looks", !!x.looks);
    var why = $("whyLine");
    if (why && (nbPage !== FRONT || !x.goals)) why.style.display = "none";
    var tr = $("trackers");
    if (tr) tr.style.display = (x.trackers && nbPage === FRONT) ? "" : "none";
    var th = $("trackHint");
    if (th && !x.trackers) th.style.display = "none";
    if (!x.friend || nbPage !== FRONT) {
      try { if (typeof hideNudge === "function") hideNudge(); } catch (e) {}
      try { if (typeof hideFriend === "function") hideFriend(); } catch (e) {}
    }
    root.classList.toggle("nb-simple", isSimple() && nbPage === FRONT);
  }

  function paperRect() {
    var b = document.body.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: Math.max(b.height, window.innerHeight - 20) };
  }
  function placeGhost(ghost, r) {
    ghost.style.position = "fixed";
    ghost.style.left = r.left + "px";
    ghost.style.top = r.top + "px";
    ghost.style.width = r.width + "px";
    ghost.style.height = r.height + "px";
    ghost.style.margin = "0";
    ghost.style.zIndex = "8";
    ghost.style.pointerEvents = "none";
  }
  function fillGhostNow() {
    var ghost = $("nbFlipGhost");
    if (!ghost) return null;
    var r = paperRect();
    placeGhost(ghost, r);
    var bodyStyle = getComputedStyle(document.body);
    ghost.style.background = bodyStyle.backgroundColor || "#f4ead8";
    ghost.style.backgroundImage = bodyStyle.backgroundImage;
    ghost.style.backgroundSize = bodyStyle.backgroundSize;
    ghost.style.backgroundPosition = bodyStyle.backgroundPosition;
    ghost.innerHTML = "";
    if (paperCache) {
      ghost.appendChild(paperCache);
      paperCache = null;
    }
    ghost.hidden = false;
    return ghost;
  }
  function cachePaper() {
    paperCache = null;
    try {
      var clone = document.body.cloneNode(true);
      clone.querySelectorAll("#nbTabs, #nbToc, #nbTocBackdrop, #nbFlipGhost, .nb-riffle, .nb-drag-ghost, .color-picker, .sheet-backdrop, .kind-sheet, .cat-sheet, .ask-sheet, .due-sheet, [hidden], #addingTo").forEach(function (n) { n.remove(); });
      clone.querySelectorAll("[id]").forEach(function (n) { n.removeAttribute("id"); });
      var wrap = document.createElement("div");
      wrap.style.cssText = "position:absolute;inset:0;overflow:hidden;";
      wrap.appendChild(clone);
      clone.style.cssText = "margin:0;min-height:0;box-shadow:none;padding:" + getComputedStyle(document.body).padding + ";background:" + getComputedStyle(document.body).backgroundColor + ";";
      paperCache = wrap;
    } catch (e) { paperCache = null; }
  }
  function schedulePaperCache() {
    if (paperCacheTimer) clearTimeout(paperCacheTimer);
    paperCacheTimer = setTimeout(function () {
      paperCacheTimer = null;
      if (flipping) return;
      cachePaper();
    }, 80);
  }
  function clearGhost() {
    if (flipTimer) { clearTimeout(flipTimer); flipTimer = null; }
    var ghost = $("nbFlipGhost");
    if (ghost) {
      ghost.hidden = true;
      ghost.innerHTML = "";
      ghost.style.transition = "none";
      ghost.style.transform = "";
      ghost.style.opacity = "";
    }
    document.querySelectorAll(".nb-riffle").forEach(function (n) { n.remove(); });
    document.documentElement.classList.remove("nb-turning", "nb-turning-out", "nb-turning-in", "nb-midturn", "nb-flipping", "nb-flip-fwd", "nb-flip-back", "nb-fade", "nb-curl-land");
    flipping = false;
  }
  var CURL_STRIPS = 8;
  var CURL_EASE = "cubic-bezier(0.23, 0.12, 0.28, 1)";
  function curlWorldAngle(i, n, dir, kind) {
    var t = n <= 1 ? 0 : i / (n - 1);
    var sign = dir === "back" ? 1 : -1;
    if (kind === "mid") return sign * (72 - 34 * t);
    return sign * (112 - 12 * t);
  }
  function curlRelAngles(n, dir, kind) {
    var rel = [];
    var prev = 0;
    for (var i = 0; i < n; i++) {
      var w = curlWorldAngle(i, n, dir, kind);
      rel.push(w - prev);
      prev = w;
    }
    return rel;
  }
  function buildCurl(ghost, dir) {
    var n = CURL_STRIPS;
    var src = ghost.firstChild;
    ghost.innerHTML = "";
    var under = document.createElement("div");
    under.className = "nb-under-shadow";
    under.setAttribute("aria-hidden", "true");
    ghost.appendChild(under);
    var curl = document.createElement("div");
    curl.className = "nb-curl";
    curl.setAttribute("aria-hidden", "true");
    var W = ghost.clientWidth || window.innerWidth || 390;
    var stripW = W / n;
    var strips = [];
    var parent = curl;
    for (var i = 0; i < n; i++) {
      var strip = document.createElement("div");
      strip.className = "nb-curl-strip" + (i === n - 1 ? " is-edge" : "");
      strip.style.width = (stripW + 0.6) + "px";
      strip.style.transform = "rotateY(0deg)";
      strip.style.transition = "none";
      if (dir === "back") {
        strip.style.transformOrigin = "right center";
        if (i === 0) { strip.style.right = "0"; strip.style.left = "auto"; }
        else { strip.style.right = "100%"; strip.style.left = "auto"; }
      } else {
        strip.style.transformOrigin = "left center";
        strip.style.left = i === 0 ? "0" : "100%";
      }
      var clip = document.createElement("div");
      clip.className = "nb-curl-clip";
      var face = document.createElement("div");
      face.className = "nb-curl-face";
      face.style.width = W + "px";
      var slice = dir === "back" ? (n - 1 - i) : i;
      face.style.left = (-slice * stripW) + "px";
      if (src) face.appendChild(src.cloneNode(true));
      clip.appendChild(face);
      var shine = document.createElement("div");
      shine.className = "nb-curl-shine";
      clip.appendChild(shine);
      strip.appendChild(clip);
      parent.appendChild(strip);
      parent = strip;
      strips.push(strip);
    }
    ghost.appendChild(curl);
    return strips;
  }
  function startBookFlip(dir, opts) {
    opts = opts || {};
    var root = document.documentElement;
    if (!paperCache) cachePaper();
    var ghost = fillGhostNow();
    if (!ghost) return 0;
    flipping = true;
    root.classList.add("nb-flipping");
    root.classList.add(dir === "back" ? "nb-flip-back" : "nb-flip-fwd");
    ghost.style.transition = "none";
    ghost.style.transform = "none";
    ghost.style.opacity = "1";
    if (opts.reduced) {
      root.classList.add("nb-fade");
      ghost.style.transition = "opacity 160ms linear";
      ghost.style.opacity = "0";
      return 160;
    }
    var strips = buildCurl(ghost, dir);
    ghost.style.background = "transparent";
    ghost.style.backgroundImage = "none";
    void ghost.offsetWidth;
    if (opts.freezeMid) {
      root.classList.add("nb-midturn", "nb-turning");
      var midRel = curlRelAngles(strips.length, dir, "mid");
      for (var mi = 0; mi < strips.length; mi++) {
        strips[mi].style.transition = "none";
        strips[mi].style.transform = "rotateY(" + midRel[mi] + "deg)";
      }
      return 0;
    }
    var land = 640;
    var riffleMs = 0;
    var stagger = 8;
    if (opts.riffle) {
      var flicks = Math.min(4, Math.max(2, opts.flicks || 3));
      var each = flicks >= 4 ? 107 : 120;
      riffleMs = flicks * each;
      land = Math.max(400, 930 - riffleMs);
      var box = document.createElement("div");
      box.className = "nb-riffle" + (dir === "back" ? " back" : "");
      box.setAttribute("aria-hidden", "true");
      for (var r = 0; r < flicks; r++) {
        var page = document.createElement("div");
        page.className = "nb-riffle-page";
        page.style.animationDelay = (r * each) + "ms";
        for (var s = 0; s < 5; s++) {
          var sliver = document.createElement("i");
          sliver.style.left = dir === "back" ? "auto" : (s * 22) + "%";
          sliver.style.right = dir === "back" ? (s * 22) + "%" : "auto";
          sliver.style.zIndex = String(s + 1);
          var startAng = 0;
          var endAng = dir === "back" ? (88 - s * 10) : -(88 - s * 10);
          sliver.style.transformOrigin = dir === "back" ? "right center" : "left center";
          sliver.style.animation = "none";
          sliver.style.transition = "transform " + each + "ms " + CURL_EASE + " " + (r * each + s * 8) + "ms, opacity " + each + "ms linear " + (r * each) + "ms";
          sliver.style.transform = "rotateY(" + startAng + "deg)";
          sliver.style.opacity = "1";
          sliver.setAttribute("data-end", String(endAng));
          page.appendChild(sliver);
        }
        box.appendChild(page);
      }
      document.body.appendChild(box);
      void box.offsetWidth;
      box.querySelectorAll("i").forEach(function (sliver) {
        sliver.style.transform = "rotateY(" + sliver.getAttribute("data-end") + "deg)";
        sliver.style.opacity = "0.15";
      });
    }
    var n = strips.length;
    var total = riffleMs + land + (n ? (n - 1) * stagger : 0);
    if (total > 930 && opts.riffle) {
      stagger = 6;
      total = riffleMs + land + (n ? (n - 1) * stagger : 0);
      if (total > 930) {
        land = Math.max(373, 930 - riffleMs - (n ? (n - 1) * stagger : 0));
        total = riffleMs + land + (n ? (n - 1) * stagger : 0);
      }
    }
    function landPage() {
      ghost.style.setProperty("--nb-land", land + "ms");
      root.classList.add("nb-curl-land");
      var midRel = curlRelAngles(n, dir, "mid");
      var endRel = curlRelAngles(n, dir, "end");
      for (var i = 0; i < n; i++) {
        if (strips[i].animate) {
          strips[i].animate([
            { transform: "rotateY(0deg)" },
            { transform: "rotateY(" + midRel[i] + "deg)", offset: 0.42 },
            { transform: "rotateY(" + endRel[i] + "deg)" }
          ], { duration: land, delay: i * stagger, easing: CURL_EASE, fill: "forwards" });
        } else {
          strips[i].style.transition = "transform " + land + "ms " + CURL_EASE + " " + (i * stagger) + "ms";
          strips[i].style.transform = "rotateY(" + endRel[i] + "deg)";
        }
      }
    }
    if (riffleMs) setTimeout(landPage, riffleMs);
    else landPage();
    return total;
  }

  function nbGo(id, opts) {
    opts = opts || {};
    if (!id) id = FRONT;
    if (id !== FRONT && id !== SETTINGS && typeof findCat === "function" && !findCat(id)) {
      // Sub-category names jump to the top-level parent page.
      var p = typeof parentOf === "function" ? parentOf(id) : "";
      while (p && typeof parentOf === "function" && parentOf(p)) p = parentOf(p);
      id = p || FRONT;
    }
    if (id === nbPage && !opts.force && !opts.freezeMid) return;
    if (flipping && !opts.freezeMid) {
      // A new tap (tab, Pages, Back, gear) should cancel the in-progress turn, not get swallowed.
      clearGhost();
    }
    var from = nbPage;
    var dir = opts.dir || (pageIndex(id) < pageIndex(from) ? "back" : "fwd");
    var dist = Math.abs(pageIndex(id) - pageIndex(from));
    var riffle = !reduced && dist >= 2;
    var animate = opts.animate !== false && from !== id && !opts.instant;
    nbCloseToc();
    try { if (typeof closeColorPicker === "function") closeColorPicker(); else document.querySelectorAll(".color-picker").forEach(function (p) { p.remove(); }); } catch (e) {}

    var ms = 0;
    if (animate || opts.freezeMid) {
      // Start the motion in this same turn, before the (slower) render of the new page.
      ms = startBookFlip(dir, { riffle: riffle, flicks: dist, freezeMid: !!opts.freezeMid, reduced: reduced });
    }

    nbPage = id;
    document.documentElement.setAttribute("data-nb-page", nbPage);
    if (id !== FRONT && id !== SETTINGS) {
      try { currentCat = id; workingItemId = null; } catch (e) {}
      try { if (typeof save === "function") save(); } catch (e) {}
    }
    if (typeof closeSettings === "function") { try { closeSettings(); } catch (e) {} }
    if (typeof closeHowTo === "function") { try { closeHowTo(); } catch (e) {} }
    if (typeof render === "function") render();
    else nbAfterRender();
    nbAfterRender();
    try { window.scrollTo(0, 0); } catch (e) {}

    if (opts.freezeMid) return;
    if (animate) {
      flipTimer = setTimeout(function () {
        clearGhost();
        schedulePaperCache();
      }, Math.max(160, ms + 20));
    } else {
      clearGhost();
      schedulePaperCache();
    }
  }

  function sampleLine(style, cuss) {
    try {
      if (typeof friendPool === "function") {
        var pool = friendPool("sample", style, !!cuss);
        return pool && pool[0] ? pool[0] : "";
      }
    } catch (e) {}
    return "";
  }
  function nudgeExample(level) {
    if (level === "off") return "The list just sits there. No check-ins, no reminders.";
    if (level === "light") return "“Book a dentist checkup” is due. No big deal, just saying.";
    if (level === "check") return "3 things in the dump. Pick one, let’s go.";
    if (level === "stay") return "You told me to stay on you, so: today.";
    return "";
  }

  function wireExtraSwitches(root) {
    if (!root) return;
    root.querySelectorAll("input[data-extra]").forEach(function (inp) {
      inp.onchange = function () {
        extrasState = extras();
        extrasState[inp.getAttribute("data-extra")] = inp.checked;
        if ((inp.getAttribute("data-extra") === "checkins" || inp.getAttribute("data-extra") === "weekly") && inp.checked) {
          extrasState.friend = true;
        }
        if (inp.getAttribute("data-extra") === "friend" && !inp.checked) {
          extrasState.checkins = false;
          extrasState.weekly = false;
        }
        if (inp.getAttribute("data-extra") === "looks" && !inp.checked) {
          try { if (typeof applyTheme === "function") applyTheme("warm", true); } catch (e) {}
        }
        if (inp.getAttribute("data-extra") === "goals") {
          try { if (typeof renderWelcome === "function") renderWelcome(); } catch (e) {}
        }
        if (inp.getAttribute("data-extra") === "checkins") {
          try {
            profile = Object.assign({}, profile || {}, { checkins: inp.checked });
            if (typeof saveProfile === "function") saveProfile(profile);
          } catch (e) {}
        }
        saveExtras();
        nbApplyExtras();
        if (typeof renderWhy === "function") renderWhy();
        if (typeof renderTrackers === "function") renderTrackers();
        if (typeof renderWelcome === "function") { try { renderWelcome(); } catch (e) {} }
        if (nbPage === SETTINGS) nbRenderSettings();
        syncTopbar();
      };
    });
  }

  function nbRenderSettings() {
    var root = $("nbSettingsPage");
    if (!root) return;
    var x = extras();
    function sw(key, name, help) {
      return '<div class="nb-switch-row">' +
        '<div class="nb-switch-text"><div class="nb-switch-name">' + escHtml(name) + "</div>" +
        '<p class="nb-switch-help">' + help + "</p></div>" +
        '<label class="nb-switch"><input type="checkbox" data-extra="' + key + '"' + (x[key] ? " checked" : "") + '><span></span></label></div>';
    }

    var extrasBox = $("nbExtras");
    if (!extrasBox) {
      extrasBox = document.createElement("div");
      extrasBox.id = "nbExtras";
      root.insertBefore(extrasBox, root.firstChild);
    }
    var html = "";
    html += '<section class="nb-sec"><h2>How to use Brain Dump</h2>' +
      '<p class="nb-sec-lead">A short guide to typing, talking, and pages.</p>' +
      '<div class="nb-actions"><button type="button" class="secondary" id="nbHowTo">How to use Brain Dump</button></div></section>';
    html += '<section class="nb-sec"><h2>What’s in your notebook</h2>' +
      '<p class="nb-sec-lead">A new notebook starts simple: the dump box, your list, and pages. Everything else is here if you want it, and each one can be turned off again.</p>';
    html += sw("looks", "Looks picker", "Try Playful, Calm, or Bold. Off, the notebook stays Warm — yellow paper and handwriting.");
    html += sw("friend", "Friend & nudges", "A short, friendly note now and then about what’s actually on your list. Off, the notebook stays quiet.");
    html += sw("checkins", "Goal check-ins", "About once a week, a question if a goal you named has gone quiet. Off unless you turn it on.");
    html += sw("weekly", "Weekly recap", "A Sunday note about what you finished, in your friend’s voice.");
    html += sw("trackers", "Trackers", "Little counters for habits, like “4 walks this week.” Tap a card to check one off.");
    html += sw("goals", "About you & goals", "Optional. Your friend uses this to make notes more personal, like reminding you about the gym if you said Healthier.");
    html += "</section>";
    extrasBox.innerHTML = html;
    wireExtraSwitches(extrasBox);
    if ($("nbHowTo")) $("nbHowTo").onclick = function () { if (typeof openHowTo === "function") openHowTo(); };

    // Reuse the existing Settings panel so v15 controls (Real default, cussing, Compare personalities, Save) stay intact.
    var original = (typeof openSettings === "function" && openSettings._original) ? openSettings._original : null;
    if (original) {
      try { original(); } catch (e) {}
    }
    var setClose = $("setClose");
    if (setClose) setClose.onclick = function () { nbGo(FRONT); };

    var more = $("nbMoreSettings");
    if (more) {
      var moreHtml = "";
      if (x.friend && (x.checkins || x.weekly)) {
        moreHtml += '<p class="nb-quiet">Check-ins and the weekly recap use this same voice. They’re still off until you flip those switches above.</p>';
      }
      moreHtml += '<section class="nb-sec"><h2>Voice</h2>' +
        '<p class="nb-sec-lead">Talk into the dump box on any page. This only sets how long to wait after you pause before saving a thought.</p>' +
        '<div class="nb-field"><label for="nbVoicePause">Voice pause</label>' +
        '<select id="nbVoicePause">' +
        '<option value="0">Off — save as soon as a thought is recognized</option>' +
        '<option value="1000">1 second</option>' +
        '<option value="1500">1.5 seconds (a comfortable default)</option>' +
        '<option value="2000">2 seconds</option>' +
        '<option value="2500">2.5 seconds</option>' +
        "</select></div>" +
        '<p class="nb-quiet">Example: if you say “call the accountant and—” and pause, 1.5 seconds usually waits for the rest instead of saving a half-thought.</p>' +
        "</section>";
      moreHtml += '<section class="nb-sec"><h2>Feedback</h2>' +
        '<p class="nb-sec-lead">See something off, or have an idea? Send a short note.</p>' +
        '<div class="nb-actions"><button type="button" class="secondary" id="nbFeedback">Send feedback</button></div>' +
        "</section>";
      moreHtml += '<section class="nb-sec"><h2>Data</h2>' +
        '<p class="nb-sec-lead">During the trial, notes aren’t copied between your phones and computers yet.</p>' +
        '<div class="nb-actions">' +
        '<button type="button" id="nbImport">Restore from a backup</button>' +
        '<button type="button" class="secondary" id="nbExport">Download backup (JSON)</button>' +
        '<button type="button" class="secondary" id="nbExportText">Download a readable copy</button></div>' +
        '<p class="nb-quiet">Restore is one tap. It asks first, and Merge is the default — it keeps what’s already here. The JSON backup can be imported later if something goes missing. The readable copy is for you to keep or print.</p>' +
        '<p class="nb-quiet" id="nbLastBackup"></p>' +
        '<p class="nb-quiet" id="nbInstallHint"></p>' +
        "</section>";
      more.innerHTML = moreHtml;
      var pause = $("nbVoicePause");
      var src = $("voicePause");
      if (pause) {
        if (src) pause.value = src.value || "1500";
        pause.onchange = function () {
          if (src) {
            src.value = pause.value;
            src.dispatchEvent(new Event("change", { bubbles: true }));
          }
          try { localStorage.setItem("bd-voice-pause", pause.value); } catch (e) {}
        };
      }
      if ($("nbExport")) $("nbExport").onclick = function () { if (typeof exportJSONBackup === "function") exportJSONBackup(); else if ($("exportBtn")) $("exportBtn").click(); };
      if ($("nbExportText")) $("nbExportText").onclick = function () { if (typeof exportPlainText === "function") exportPlainText(); };
      if ($("nbImport")) $("nbImport").onclick = function () { var inp = $("importFile"); if (inp) inp.click(); };
      if ($("nbLastBackup") && typeof backupLastLabel === "function") $("nbLastBackup").textContent = backupLastLabel();
      if ($("nbFeedback")) $("nbFeedback").onclick = function () { if (typeof openFeedbackSheet === "function") openFeedbackSheet(); };

      var hint = $("nbInstallHint");
      if (hint) {
        if (typeof isStandaloneApp === "function" && isStandaloneApp()) hint.textContent = "Brain Dump is on your Home Screen — good.";
        else hint.textContent = "Add Brain Dump to your Home Screen so it opens like an app.";
      }
      if ($("nbClearWhy")) $("nbClearWhy").onclick = function () {
        if ($("setClear")) $("setClear").click();
        else if (typeof askSheet === "function") {
          askSheet({ title: "Clear your why?", body: "This forgets the goals and ‘what matters’ you wrote. You can set them up again any time.", ok: "Clear", cancel: "Keep them", danger: true }).then(function (yes) {
            if (!yes) return;
            try {
              profile = { skipped: true };
              if (typeof saveProfile === "function") saveProfile(profile);
              if (typeof renderWhy === "function") renderWhy();
              nbRenderSettings();
              if (typeof setStatus === "function") setStatus("Cleared");
            } catch (e) {}
          });
        }
      };
    }
  }

  function hookFns() {
    if (typeof render === "function" && !render.__nbWrapped) {
      var _render = render;
      var wrapped = function () {
        var r = _render.apply(this, arguments);
        try { nbAfterRender(); } catch (e) {}
        return r;
      };
      wrapped.__nbWrapped = true;
      render = wrapped;
    }
    if (typeof maybeShowNudge === "function" && !maybeShowNudge.__nbWrapped) {
      var _nudge = maybeShowNudge;
      maybeShowNudge = function () {
        if (!extras().friend || nbPage !== FRONT) { try { hideNudge(); } catch (e) {} return; }
        return _nudge.apply(this, arguments);
      };
      maybeShowNudge.__nbWrapped = true;
    }
    if (typeof maybeShowFriend === "function" && !maybeShowFriend.__nbWrapped) {
      var _friend = maybeShowFriend;
      maybeShowFriend = function () {
        if (!extras().friend || nbPage !== FRONT) { try { hideFriend(); } catch (e) {} return; }
        return _friend.apply(this, arguments);
      };
      maybeShowFriend.__nbWrapped = true;
    }
    if (typeof showWeekly === "function" && !showWeekly.__nbWrapped) {
      var _sw = showWeekly;
      showWeekly = function () {
        if (!extras().friend || !extras().weekly || nbPage !== FRONT) return;
        return _sw.apply(this, arguments);
      };
      showWeekly.__nbWrapped = true;
    }
    if (typeof showCheckin === "function" && !showCheckin.__nbWrapped) {
      var _sc = showCheckin;
      showCheckin = function () {
        if (!extras().friend || !extras().checkins || nbPage !== FRONT) return;
        return _sc.apply(this, arguments);
      };
      showCheckin.__nbWrapped = true;
    }
    if (typeof showBigger === "function" && !showBigger.__nbWrapped) {
      var _sb = showBigger;
      showBigger = function () {
        if (!extras().goals || nbPage !== FRONT) return;
        return _sb.apply(this, arguments);
      };
      showBigger.__nbWrapped = true;
    }
    if (typeof openSettings === "function" && !openSettings.__nbWrapped) {
      var _os = openSettings;
      openSettings = function () { nbGo(SETTINGS); };
      openSettings.__nbWrapped = true;
      openSettings._original = _os;
    }
    if (typeof renderWhy === "function" && !renderWhy.__nbWrapped) {
      var _rw = renderWhy;
      renderWhy = function () {
        _rw.apply(this, arguments);
        if (!extras().goals || nbPage !== FRONT) {
          var el = $("whyLine");
          if (el) el.style.display = "none";
        }
      };
      renderWhy.__nbWrapped = true;
    }
    // Keep the original “Adding to: No category” chip on the Front page (core check + clear-tap).
    if (typeof renderTrackers === "function" && !renderTrackers.__nbWrapped) {
      var _rt = renderTrackers;
      renderTrackers = function () {
        _rt.apply(this, arguments);
        var tr = $("trackers");
        if (tr) tr.style.display = (extras().trackers && nbPage === FRONT) ? "" : "none";
      };
      renderTrackers.__nbWrapped = true;
    }
    if (typeof renderWelcome === "function" && !renderWelcome.__nbWrapped) {
      var _welcome = renderWelcome;
      renderWelcome = function () {
        if (!extras().goals) {
          var card = $("welcome");
          if (card) { card.style.display = "none"; if (arguments.length === 0) card.innerHTML = ""; }
          return;
        }
        return _welcome.apply(this, arguments);
      };
      renderWelcome.__nbWrapped = true;
    }
    if (typeof openCompare === "function" && !openCompare.__nbWrapped) {
      var _oc = openCompare;
      openCompare = function () {
        if (nbPage !== FRONT) nbGo(FRONT, { instant: true });
        document.documentElement.classList.add("nb-compare-open");
        return _oc.apply(this, arguments);
      };
      openCompare.__nbWrapped = true;
    }
    if (typeof closeCompare === "function" && !closeCompare.__nbWrapped) {
      var _cc = closeCompare;
      closeCompare = function () {
        document.documentElement.classList.remove("nb-compare-open");
        var r = _cc.apply(this, arguments);
        try { syncTopbar(); nbApplyExtras(); } catch (e) {}
        return r;
      };
      closeCompare.__nbWrapped = true;
    }
    var setBtn = $("settingsBtn");
    if (setBtn) setBtn.onclick = function () {
      if (nbPage === SETTINGS) nbGo(FRONT);
      else nbGo(SETTINGS);
    };
    var addTo = $("addingTo");
    if (addTo) {
      addTo.onclick = function () {
        if (nbPage !== FRONT && nbPage !== SETTINGS) {
          try {
            currentCat = nbPage;
            workingItemId = null;
            if (typeof save === "function") save();
            if (typeof updateSelect === "function") updateSelect();
            if (typeof markWorkingSpot === "function") markWorkingSpot({ scroll: false });
            if (typeof setStatus === "function") setStatus("You’re on the " + nbPage + " page, so new things go here. Flip to the front to add somewhere else.");
          } catch (e) {}
          return;
        }
        if (typeof clearWorkingSpot === "function") {
          if (!currentCat && !workingItemId) { if ($("catSelect")) $("catSelect").focus(); return; }
          clearWorkingSpot();
        }
      };
    }
  }

  function hookSwipe() {
    var startX = 0, startY = 0, tracking = false;
    function ignore(t) {
      if (!t || !t.closest) return false;
      return !!(t.closest("input, textarea, select, button, a, .item, [draggable], .group-header, .group-items, #list, #trackers, #compareView, .nb-toc, .nb-tabs, .color-picker, .kind-sheet, .cat-sheet, .ask-sheet, .due-sheet, #howTo, #toolbar"));
    }
    document.addEventListener("touchstart", function (e) {
      if (flipping || ($("nbToc") && !$("nbToc").hidden)) return;
      if (document.documentElement.classList.contains("nb-compare-open")) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (ignore(e.target)) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      tracking = true;
    }, { passive: true });
    document.addEventListener("touchend", function (e) {
      if (!tracking) return;
      tracking = false;
      var t = e.changedTouches && e.changedTouches[0];
      if (!t) return;
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
      var ids = pageIds();
      var i = pageIndex(nbPage);
      if (dx < 0 && i < ids.length - 1) nbGo(ids[i + 1], { dir: "fwd" });
      else if (dx > 0 && i > 0) nbGo(ids[i - 1], { dir: "back" });
    }, { passive: true });
  }

  function init() {
    if (isCompareUrl()) return;
    document.documentElement.classList.add("nb-notebook");
    ensureChrome();
    hookFns();
    hookSwipe();
    // Always land on the front page, even if a previous session had a current category.
    nbPage = FRONT;
    document.documentElement.setAttribute("data-nb-page", nbPage);
    try { currentCat = currentCat || ""; } catch (e) {}
    try { if (typeof hideNudge === "function") hideNudge(); } catch (e) {}
    try { if (typeof hideFriend === "function") hideFriend(); } catch (e) {}
    nbApplyExtras();
    if (typeof renderWhy === "function") renderWhy();
    if (typeof renderWelcome === "function") renderWelcome();
    if (typeof render === "function") render();
    else nbAfterRender();
    nbAfterRender();
    if (typeof updateAddingTo === "function") updateAddingTo();
    if (typeof __bdUpdatePageWhen === "function") __bdUpdatePageWhen();
  }

  function setExtras(partial, andRender) {
    extrasState = Object.assign({}, extras(), partial || {});
    saveExtras();
    if (andRender !== false) {
      nbApplyExtras();
      if (nbPage === SETTINGS) nbRenderSettings();
      if (typeof renderWhy === "function") renderWhy();
      if (typeof renderTrackers === "function") renderTrackers();
      if (typeof render === "function") render();
      syncTopbar();
    }
    return extras();
  }

  window.__bdNotebook = {
    go: nbGo,
    page: function () { return nbPage; },
    openToc: nbOpenToc,
    closeToc: nbCloseToc,
    extras: extras,
    setExtras: setExtras,
    pages: pageIds,
    init: init
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

