// Preview trick: ?debugdate=2026-11-22T19:00 (or 2026-11-22, or +5 for "5 days from now") pretends it's that time.
// Friend-card timing isn't saved while previewing, so the real weekly card still shows on schedule.
(function () {
  try {
    var m = /[?&]debugdate=([^&]+)/.exec(location.search || '');
    if (!m) return;
    var s = decodeURIComponent(m[1]).trim(), t;
    if (/^[+-]\d+$/.test(s)) t = Date.now() + Number(s) * 86400000;
    else { if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T19:00'; t = new Date(s).getTime(); }
    if (!isNaN(t) && typeof window.__bdNow !== 'number') window.__bdNow = t;
    window.__bdFriendPreview = true;
  } catch (e) {}
})();
const $ = id => document.getElementById(id);
const catInput = $('catInput'), addCatBtn = $('addCatBtn'), catSelect = $('catSelect');
const itemInput = $('itemInput'), addItemBtn = $('addItemBtn'), micBtn = $('micBtn'), listEl = $('list');
const howTo = $('howTo'), howToToggle = $('howToToggle');
const modeRemove = null, modeGhost = null, selectBtn = $('selectBtn');
const toolbar = $('toolbar'), micStatus = $('micStatus');

let items = JSON.parse(localStorage.getItem('bd-items') || '[]');
let categories = JSON.parse(localStorage.getItem('bd-cats') || '[]');
let currentCat = localStorage.getItem('bd-current') || '';
let finishMode = 'ghost'; // always ghost now
let selectMode = false;
let lastAddedId = null;
let pendingCorrection = false;

const PALETTE = ['#ff8a80','#82b1ff','#b9f6ca','#ffff8d','#ea80fc','#ffd180','#ff9e80','#b388ff'];

// FEEDBACK_EMAIL is a PLACEHOLDER until the owner picks a real address.
// Replace this with the inbox that should receive tester notes. Do not put note contents in feedback.
const FEEDBACK_EMAIL = 'feedback@example.com';
const APP_VERSION = 'v32';

let collapsed = JSON.parse(localStorage.getItem('bd-collapsed') || '{}');

// ---- Subcategories (category.parent = parent category name; missing/'' = top level) ----
const MAX_DEPTH = 3;
const UNSORTED = 'Unsorted';
const UNSORTED_COLOR = '#d4c4ae';
function isUnsortedName(name) {
  return String(name || '').trim().toLowerCase() === 'unsorted';
}
function getUnsortedCat() {
  const existing = categories.find(c => isUnsortedName(c.name) && !c.parent) || categories.find(c => isUnsortedName(c.name));
  if (existing) return existing;
  return { name: UNSORTED, color: UNSORTED_COLOR, builtin: true };
}
function unsortedHasItems() {
  return (items || []).some(i => !i.deleted && !i.letGo && isUnsortedName(i.category));
}
function findCat(name) {
  const exact = categories.find(c => c.name === name);
  if (exact) return exact;
  if (isUnsortedName(name)) return getUnsortedCat();
  return null;
}
function findCatCI(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const real = categories.find(c => c.name.toLowerCase() === n);
  if (real) return real;
  if (n === 'unsorted') return getUnsortedCat();
  return null;
}
function parentOf(name) { const c = findCat(name); return (c && c.parent) || ''; }
function childrenOf(name) {
  return categories.filter(c => (c.parent || '') === (name || '') && c.name !== name)
    .sort((a, b) => a.name.localeCompare(b.name));
}
function ancestorsOf(name) {
  const out = [], seen = new Set([name]);
  let p = parentOf(name);
  while (p && !seen.has(p)) { out.push(p); seen.add(p); p = parentOf(p); }
  return out; // nearest parent first
}
function depthOf(name) { return ancestorsOf(name).length + 1; }
function descendantsOf(name) {
  const out = [];
  const walk = n => childrenOf(n).forEach(c => {
    if (c.name !== name && !out.includes(c.name)) { out.push(c.name); walk(c.name); }
  });
  walk(name);
  return out;
}
function subtreeHeight(name, seen) {
  seen = seen || new Set();
  if (seen.has(name)) return 1;
  seen.add(name);
  const kids = childrenOf(name);
  return 1 + (kids.length ? Math.max(...kids.map(k => subtreeHeight(k.name, seen))) : 0);
}
function catPath(name) { return [...ancestorsOf(name).reverse(), name].join(' › '); }
// Old data has no parent field: it loads as top level. Bad parents (missing, loops, too deep) are repaired.
function normalizeCategories() {
  if (!Array.isArray(categories)) categories = [];
  categories = categories.filter(c => c && typeof c.name === 'string' && c.name.trim());
  categories.forEach(c => {
    if (c.parent != null && (typeof c.parent !== 'string' || !c.parent || c.parent === c.name || !findCat(c.parent))) delete c.parent;
  });
  categories.forEach(c => {
    const seen = new Set([c.name]);
    let p = c.parent;
    while (p) {
      if (seen.has(p)) { delete c.parent; break; }
      seen.add(p);
      p = parentOf(p);
    }
  });
  categories.forEach(c => {
    while (c.parent && depthOf(c.name) > MAX_DEPTH) {
      const up = parentOf(c.parent);
      if (up) c.parent = up; else delete c.parent;
    }
  });
}
normalizeCategories();
// Tree order: top level A–Z until the user rearranges on the Front page, then saved `order`.
function hasCustomCatOrder() {
  return categories.some(c => c && !c.parent && typeof c.order === 'number');
}
function catOrderOf(name) {
  const c = typeof findCat === 'function' ? findCat(name) : categories.find(x => x.name === name);
  return (c && typeof c.order === 'number') ? c.order : 1e9;
}
function nextTopCatOrder() {
  let m = -1;
  categories.forEach(c => { if (c && !c.parent && typeof c.order === 'number' && c.order > m) m = c.order; });
  return m + 1;
}
function applyTopCatOrder(names) {
  names.forEach((n, i) => { const c = findCat(n); if (c && !c.parent) c.order = i; });
}
function topCatNames() {
  return orderedCats().filter(o => o.depth === 1 && findCat(o.name) && !parentOf(o.name)).map(o => o.name);
}
function orderedCats(extraNames) {
  const known = new Set(categories.map(c => c.name));
  const tops = categories.filter(c => !c.parent).map(c => c.name);
  (extraNames || []).forEach(n => { if (n && n !== 'Uncategorized' && !known.has(n) && !tops.includes(n)) tops.push(n); });
  if (hasCustomCatOrder()) tops.sort((a, b) => { const d = catOrderOf(a) - catOrderOf(b); return d !== 0 ? d : a.localeCompare(b); });
  else tops.sort((a, b) => a.localeCompare(b));
  const out = [];
  const walk = (name, depth) => {
    if (out.some(o => o.name === name)) return;
    out.push({ name, depth });
    if (known.has(name)) childrenOf(name).forEach(k => walk(k.name, depth + 1));
  };
  tops.forEach(n => walk(n, 1));
  categories.forEach(c => { if (!out.some(o => o.name === c.name)) out.push({ name: c.name, depth: 1 }); });
  return out;
}
// Put a category (new or existing) under parentName ('' = top). Returns {cat, created, moved} or {error}.
function placeCategory(name, parentName, afterItem) {
  name = String(name || '').trim().replace(/[\s.,!?…]+$/g, '').trim();
  if (!name) return { error: 'Type a name first' };
  if (isUnsortedName(name)) {
    if (parentName) return { error: '“Unsorted” is a built-in page' };
    return { cat: getUnsortedCat(), created: false };
  }
  if (parentName && isUnsortedName(parentName)) return { error: "You can't nest under Unsorted" };
  let pName = '';
  if (parentName) {
    const parent = findCatCI(parentName);
    if (!parent) return { error: 'No category called “' + parentName + '”' };
    pName = parent.name;
  }
  const parentDepth = pName ? depthOf(pName) : 0;
  let c = findCatCI(name);
  if (c) {
    if ((c.parent || '') === pName) {
      if (afterItem != null) c.afterItem = afterItem;
      return { cat: c, created: false };
    }
    if (c.name === pName || (pName && ancestorsOf(pName).includes(c.name))) return { error: '“' + c.name + '” can’t go inside itself' };
    if (parentDepth + subtreeHeight(c.name) > MAX_DEPTH) return { error: 'That would be more than 3 levels deep' };
    if (pName) c.parent = pName; else delete c.parent;
    if (afterItem != null) c.afterItem = afterItem; else delete c.afterItem;
    return { cat: c, created: false, moved: true };
  }
  if (parentDepth + 1 > MAX_DEPTH) return { error: '“' + pName + '” is already 3 levels deep' };
  // New subcategories start with their parent's color so a branch reads as one group.
  c = { name, color: pName ? (findCat(pName).color || PALETTE[0]) : PALETTE[categories.length % PALETTE.length] };
  if (pName) c.parent = pName;
  else if (hasCustomCatOrder()) c.order = nextTopCatOrder();
  if (afterItem != null) c.afterItem = afterItem;
  categories.push(c);
  return { cat: c, created: true };
}
function applyRename(oldName, newName) {
  newName = String(newName || '').trim();
  if (!newName || newName === oldName) return false;
  const clash = categories.find(c => c.name !== oldName && c.name.toLowerCase() === newName.toLowerCase());
  if (clash) { setStatus('“' + clash.name + '” already exists. Pick another name.'); return false; }
  const cat = findCat(oldName);
  if (cat) cat.name = newName;
  categories.forEach(c => { if (c.parent === oldName) c.parent = newName; });
  items.forEach(it => {
    if (it.category === oldName) it.category = newName;
    if (it.deletedCat && it.deletedCat.parent === oldName) it.deletedCat.parent = newName;
  });
  if (currentCat === oldName) currentCat = newName;
  if (collapsed[oldName] !== undefined) {
    collapsed[newName] = collapsed[oldName];
    delete collapsed[oldName];
  }
  save();
  return true;
}

function save() {
  localStorage.setItem('bd-items', JSON.stringify(items));
  localStorage.setItem('bd-cats', JSON.stringify(categories));
  localStorage.setItem('bd-current', currentCat);
  localStorage.setItem('bd-finish', finishMode);
  localStorage.setItem('bd-collapsed', JSON.stringify(collapsed));
}
function setStatus(msg) { micStatus.textContent = msg || ''; }

function updateSelect() {
  const opts = orderedCats().filter(o => findCat(o.name) && !isUnsortedName(o.name)).map(o => `<option value="${o.name}">${'\u00a0\u00a0\u00a0'.repeat(o.depth - 1)}${o.depth > 1 ? '↳ ' : ''}${o.name}</option>`).join('');
  const uOpt = (unsortedHasItems() || isUnsortedName(currentCat)) ? '<option value="Unsorted">Unsorted</option>' : '';
  catSelect.innerHTML = '<option value="">No category</option>' + uOpt + opts;
  catSelect.value = currentCat || '';
  // Also update move dropdown
  const moveSel = $('moveSelectedTo');
  if (moveSel) {
    moveSel.innerHTML = '<option value="">Move to...</option><option value="Uncategorized">Uncategorized</option>' +
      opts;
  }
}
function getColor(name) {
  if (isUnsortedName(name)) return (categories.find(c => isUnsortedName(c.name)) || {}).color || UNSORTED_COLOR;
  return (categories.find(c => c.name === name) || {}).color || '#ffffff';
}

// Mobile fix 10: on phones How-to opens as a sheet over the page (✕, outside tap, or Escape closes it)
// so it never pushes the dump box off screen. On wider screens it stays an inline panel.
function howToIsSheet() { return !!(window.matchMedia && matchMedia('(max-width: 480px)').matches); }
function openHowTo() {
  howTo.style.display = 'block';
  howToToggle.textContent = 'How to (close)';
  const onSettings = document.documentElement.getAttribute('data-nb-page') === 'settings';
  if (howToIsSheet() || onSettings) {
    howTo.classList.add('as-sheet');
    howTo.scrollTop = 0;
    if (!document.querySelector('.howto-backdrop')) {
      const back = document.createElement('div');
      back.className = 'sheet-backdrop howto-backdrop';
      back.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); closeHowTo(); });
      document.body.appendChild(back);
    }
  }
}
function closeHowTo() {
  howTo.style.display = 'none';
  howTo.classList.remove('as-sheet');
  howToToggle.textContent = 'How to';
  document.querySelectorAll('.howto-backdrop').forEach(b => b.remove());
}
howToToggle.onclick = () => {
  if (howTo.style.display === 'none' || howTo.style.display === '') openHowTo();
  else closeHowTo();
};
howTo.querySelector('.howto-close').onclick = closeHowTo;
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && howTo.classList.contains('as-sheet') && howTo.style.display !== 'none') { ev.preventDefault(); closeHowTo(); }
});

// Mobile fix 12: small in-app sheets instead of the browser's confirm()/prompt() popups.
// askSheet({ title, body, ok, cancel, danger, input, placeholder }) → Promise: true/false (confirm) or text/null (input).
function askSheet(o) {
  o = o || {};
  document.querySelectorAll('.ask-sheet').forEach(s => { if (s._askDone) s._askDone(o.input ? null : false); });
  return new Promise(resolve => {
    const div = document.createElement('div');
    div.className = 'kind-sheet ask-sheet';
    div.setAttribute('role', 'dialog');
    div.innerHTML = `<div class="kind-title">${esc(o.title || 'Are you sure?')}</div>` +
      (o.body ? `<div class="ask-body">${esc(o.body)}</div>` : '') +
      (o.input ? `<input type="text" class="ask-input" placeholder="${esc(o.placeholder || '')}" autocomplete="off" enterkeyhint="done">` : '') +
      `<div class="ask-actions"><button type="button" class="secondary" data-act="cancel">${esc(o.cancel || 'Cancel')}</button>` +
      `<button type="button" class="${o.danger ? 'danger' : ''}" data-act="ok">${esc(o.ok || 'OK')}</button></div>`;
    let done = false;
    const finish = val => {
      if (done) return; done = true;
      if (div._sheetDismiss) div._sheetDismiss();
      div.remove();
      resolve(val);
    };
    div._askDone = finish;
    const inp = div.querySelector('.ask-input');
    const okVal = () => o.input ? ((inp.value || '').trim() || null) : true;
    div.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      ev.stopPropagation();
      finish(b.dataset.act === 'ok' ? okVal() : (o.input ? null : false));
    });
    if (inp) inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); finish(okVal()); } });
    document.body.appendChild(div);
    wireDismiss(div, () => finish(o.input ? null : false));
    if (inp) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
  });
}
selectBtn.onclick = () => {
  selectMode = !selectMode;
  selectBtn.textContent = selectMode ? 'Done' : 'Select';
  selectBtn.classList.toggle('active', selectMode);
  if (!selectMode) items.forEach(i => i.selected = false);
  render();
};

// ===== PREVIEW: Search, Due dates, Trackers =====
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Due dates ----------
const DUE_WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const DUE_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DUE_SUBJECT_RE = /^(i|i'm|im|i've|ive|i'd|we|we're|were|it|it's|its|that|that's|thats|he|she|they|you|there|today|yesterday)\b/i;
const DUE_BLOCK_BEFORE = /(?:^|\s)(every|each|last|since|until|till|from|black|good|past|of|a|the|than|was|were|is|are|after|day|night|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function dayDiff(due, now) { return Math.round((startOfDay(due) - startOfDay(now)) / 86400000); }
function atNoon(d) { const x = startOfDay(d); x.setHours(12); return x; }

// Conservative: only a clear date phrase at the END of the text is pulled out.
// Returns { text, due: Date|null, phrase }
function parseDuePhrase(input, now) {
  now = now ? new Date(now) : new Date();
  const original = String(input || '');
  const s = original.replace(/[\s.!?,;]+$/, '');
  const days = DUE_WEEKDAYS.join('|');
  const re = new RegExp('(^|[\\s,;:–-]+)((?:(?:due|by|on|for|before|this|next)\\s+){0,2})(today|tonight|tomorrow|week|' + days + '|the\\s+(\\d{1,2})(?:st|nd|rd|th)|(\\d{1,2})(?:st|nd|rd|th))$', 'i');
  const m = s.match(re);
  const none = { text: original.trim(), due: null, phrase: '' };
  if (!m) return none;
  const lead = (m[2] || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const when = m[3].toLowerCase();
  let rest = s.slice(0, m.index).trim().replace(/[\s,;:–-]+$/, '');
  if (rest.replace(/[^a-z0-9]/gi, '').length < 2) return none;

  const strongLead = lead.some(w => w === 'due' || w === 'by' || w === 'before');
  const isNext = lead.includes('next');
  const hasLead = lead.length > 0;

  // "week" is only valid as "next week"
  if (when === 'week' && !isNext) return none;
  // "the 20th"/"20th" needs "the" or a lead word
  const dayNum = m[4] || m[5];
  if (m[5] && !hasLead) return none;
  // "next today", "next tomorrow", "this the 20th" -> not a phrase
  if (isNext && !(when === 'week' || DUE_WEEKDAYS.includes(when))) return none;
  if (lead.includes('this') && !DUE_WEEKDAYS.includes(when)) return none;
  // Ordinary sentences ("I was born on the 20th", "it rained today") stay as typed
  if (!strongLead && DUE_SUBJECT_RE.test(rest)) return none;
  // "every Friday", "last Monday", "Black Friday", "since Tuesday"
  if (!hasLead && DUE_BLOCK_BEFORE.test(rest)) return none;
  if (hasLead && /(?:^|\s)(every|each|last|since|until|till|from)$/i.test(rest)) return none;

  const today = startOfDay(now);
  let due = null;
  if (when === 'today' || when === 'tonight') due = today;
  else if (when === 'tomorrow') due = addDays(today, 1);
  else if (when === 'week') { // next week = Monday of next week
    const iso = today.getDay() || 7;
    due = addDays(today, 8 - iso);
  } else if (DUE_WEEKDAYS.includes(when)) {
    const target = DUE_WEEKDAYS.indexOf(when);
    if (isNext) { // the <weekday> in next Mon–Sun week
      const iso = today.getDay() || 7;
      const nextMon = addDays(today, 8 - iso);
      due = addDays(nextMon, ((target + 6) % 7));
    } else {
      let diff = (target - today.getDay() + 7) % 7;
      if (diff === 0 && !lead.includes('this')) diff = 7; // "Friday" on Friday = a week out; "this Friday" = today
      due = addDays(today, diff);
    }
  } else if (dayNum) {
    const n = +dayNum;
    if (n < 1 || n > 31) return none;
    let y = today.getFullYear(), mo = today.getMonth();
    if (n < today.getDate()) mo += 1;
    const last = new Date(y, mo + 1, 0).getDate();
    due = new Date(y, mo, Math.min(n, last));
  }
  if (!due) return none;
  // "report is due Friday" -> "report"
  if (lead.includes('due')) rest = rest.replace(/\s+(is|are|was)$/i, '');
  return { text: rest, due: atNoon(due), phrase: s.slice(m.index).trim().replace(/^[\s,;:–-]+/, '') };
}

function dueLabel(dueISO, now) {
  const d = new Date(dueISO);
  if (isNaN(d)) return '';
  const diff = dayDiff(d, now || new Date());
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  if (diff === -1) return 'due yesterday';
  if (diff > 1 && diff < 7) return 'due ' + DUE_SHORT[d.getDay()];
  return 'due ' + d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function dueState(dueISO, now) {
  const diff = dayDiff(new Date(dueISO), now || new Date());
  if (diff < 0) return 'overdue';
  if (diff <= 1) return 'soon';
  return '';
}
function dueTagHTML(it) {
  if (!it.due || isNaN(new Date(it.due))) return '';
  const st = it.ghosted ? '' : dueState(it.due);
  const title = st === 'overdue' ? 'Overdue — tap to change or clear' : 'Tap to change or clear';
  return `<button type="button" class="due-tag ${st}" data-id="${it.id}" title="${title}">${dueLabel(it.due)}</button>`;
}

function closeDueSheet() { unwireDismiss('.due-sheet'); }
function openDueSheet(it, opts) {
  closeDueSheet();
  if (!it) return;
  const div = document.createElement('div');
  div.className = 'due-sheet';
  const now = new Date();
  const iso = d => { const x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0'); };
  const prompt = (opts && opts.prompt) ? `<div class="letgo-note">${esc(opts.prompt)}</div>` : '';
  div.innerHTML = `<div class="due-sheet-title">${esc(it.text)}</div>
    ${prompt}
    <div class="due-sheet-row">
      <button type="button" data-days="0">Today</button>
      <button type="button" data-days="1">Tomorrow</button>
      <button type="button" data-nextweek="1">Next week</button>
    </div>
    <div class="due-sheet-row"><label>Pick a day <input type="date" class="due-pick" value="${it.due ? iso(it.due) : ''}"></label></div>
    <div class="due-sheet-row">
      <button type="button" class="secondary due-clear">Clear date</button>
      <button type="button" class="secondary due-close">Close</button>
    </div>`;
  const setDue = d => { it.due = atNoon(d).toISOString(); save(); render(); closeDueSheet(); setStatus(dueLabel(it.due)); };
  div.querySelectorAll('[data-days]').forEach(b => b.onclick = () => setDue(addDays(startOfDay(now), +b.dataset.days)));
  div.querySelector('[data-nextweek]').onclick = () => { const i = now.getDay() || 7; setDue(addDays(startOfDay(now), 8 - i)); };
  div.querySelector('.due-pick').onchange = e => { if (e.target.value) { const [y,mo,d] = e.target.value.split('-').map(Number); setDue(new Date(y, mo-1, d)); } };
  div.querySelector('.due-clear').onclick = () => { it.due = null; save(); render(); closeDueSheet(); setStatus('Date cleared'); };
  div.querySelector('.due-close').onclick = closeDueSheet;
  document.body.appendChild(div);
  wireDismiss(div, closeDueSheet);
}

// ---------- Search ----------
let searchQuery = '';
function matchesSearch(it, q) {
  if (!q) return true;
  return String(it.text || '').toLowerCase().includes(q) || String(it.category || '').toLowerCase().includes(q) || String(it.why || '').toLowerCase().includes(q);
}

// ---------- Trackers ----------
const TRACKER_KEY = 'bd-trackers';
let trackers = JSON.parse(localStorage.getItem(TRACKER_KEY) || '[]');
const TRACK_WORD_NUMS = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,fifteen:15,twenty:20,thirty:30};
function saveTrackers() { localStorage.setItem(TRACKER_KEY, JSON.stringify(trackers)); }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function periodKey(period, now) {
  const d = startOfDay(now || new Date());
  if (period === 'day') return ymd(d);
  if (period === 'week') { const i = d.getDay() || 7; return 'W' + ymd(addDays(d, 1 - i)); }
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}
function daysLeftText(period, now) {
  const d = startOfDay(now || new Date());
  if (period === 'day') return 'resets tonight';
  let left;
  if (period === 'week') left = 7 - (d.getDay() || 7);
  else left = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
  if (left === 0) return 'last day';
  return left + (left === 1 ? ' day left' : ' days left');
}
// "4 books this month", "read 4 books a month", "8 glasses of water today", "gym 3 times a week"
function parseTrackerPhrase(text) {
  let s = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  const pm = s.match(/\s+(?:(?:a|per|this|each|every)\s+)?(today|day|daily|tonight|week|weekly|month|monthly)$/);
  if (!pm) return null;
  const p = pm[1];
  const period = /day|daily|tonight/.test(p) ? 'day' : /week/.test(p) ? 'week' : 'month';
  let body = s.slice(0, pm.index).trim();
  const nm = body.match(new RegExp('(^|\\s)(\\d{1,3}|' + Object.keys(TRACK_WORD_NUMS).join('|') + ')(\\s|$)'));
  if (!nm) return null;
  const target = /\d/.test(nm[2]) ? +nm[2] : TRACK_WORD_NUMS[nm[2]];
  if (!target || target < 1 || target > 500) return null;
  const label = body.replace(/\s+/g, ' ').trim();
  if (label.replace(/[^a-z]/g, '').length < 2) return null;
  return { label: label.charAt(0).toUpperCase() + label.slice(1), target, period };
}
function rolloverTrackers(now) {
  let changed = false;
  trackers.forEach(t => {
    const k = periodKey(t.period, now);
    if (t.periodKey !== k) {
      if (t.periodKey) t.last = { count: t.count, target: t.target, key: t.periodKey };
      t.count = 0; t.periodKey = k; changed = true;
    }
  });
  if (changed) saveTrackers();
}
function addTracker(label, target, period) {
  const t = { id: Date.now() + Math.random(), label, target: Math.max(1, Math.min(500, +target || 1)), period, count: 0, periodKey: periodKey(period), created: Date.now() };
  trackers.push(t); saveTrackers(); renderTrackers();
  return t;
}
const PERIOD_WORD = { day: 'today', week: 'this week', month: 'this month' };
function renderTrackers() {
  rolloverTrackers();
  const box = $('trackerList');
  if (!box) return;
  const panel = $('trackers');
  panel.classList.toggle('has-trackers', trackers.length > 0);
  box.innerHTML = trackers.map(t => {
    const pct = Math.min(100, Math.round(t.count / t.target * 100));
    const done = t.count >= t.target;
    return `<div class="tracker ${done ? 'done' : ''}" data-tid="${t.id}">
      <button type="button" class="tracker-tap" data-tid="${t.id}" aria-label="Check one off ${esc(t.label)}">
        <span class="tracker-label">${esc(t.label)}</span>
        <span class="tracker-count">${t.count}/${t.target}</span>
        <span class="tracker-bar"><span style="width:${pct}%"></span></span>
        <span class="tracker-sub">${done ? 'Done ' + PERIOD_WORD[t.period] + ' 🎉' : PERIOD_WORD[t.period]} · ${daysLeftText(t.period)}</span>
      </button>
      <button type="button" class="tracker-minus secondary" data-tid="${t.id}" title="Undo one">−</button>
      <button type="button" class="tracker-del secondary" data-tid="${t.id}" title="Remove tracker">✕</button>
    </div>`;
  }).join('');
}
function initTrackers() {
  const panel = $('trackers');
  if (!panel) return;
  $('trackerToggle').onclick = () => {
    const f = $('trackerForm');
    f.style.display = f.style.display === 'flex' ? 'none' : 'flex';
    if (f.style.display === 'flex') $('trackerText').focus();
  };
  const submit = () => {
    const text = $('trackerText').value.trim();
    const parsed = parseTrackerPhrase(text);
    let label = text, target = +$('trackerNum').value, period = $('trackerPeriod').value;
    if (parsed) { label = parsed.label; target = parsed.target; period = parsed.period; }
    if (!label) { $('trackerText').focus(); return; }
    addTracker(label.charAt(0).toUpperCase() + label.slice(1), target || 1, period);
    $('trackerText').value = ''; $('trackerNum').value = '4';
    $('trackerForm').style.display = 'none';
  };
  $('trackerAdd').onclick = submit;
  $('trackerText').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  $('trackerText').oninput = () => {
    const p = parseTrackerPhrase($('trackerText').value);
    if (p) { $('trackerNum').value = p.target; $('trackerPeriod').value = p.period; }
  };
  $('trackerList').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const t = trackers.find(x => x.id == b.dataset.tid);
    if (!t) return;
    if (b.classList.contains('tracker-tap')) { t.count += 1; t.lastTapAt = bdNow(); saveTrackers(); renderTrackers(); }
    else if (b.classList.contains('tracker-minus')) { t.count = Math.max(0, t.count - 1); saveTrackers(); renderTrackers(); }
    else if (b.classList.contains('tracker-del')) {
      askSheet({ title: 'Remove the “' + t.label + '” tracker?', ok: 'Remove', cancel: 'Keep it', danger: true }).then(yes => {
        if (yes) { trackers = trackers.filter(x => x !== t); saveTrackers(); renderTrackers(); }
      });
    }
  });
  renderTrackers();
  setInterval(renderTrackers, 60000); // daily/weekly/monthly reset while open
}
function offerTracker(it) {
  const hint = $('trackHint');
  if (!hint) return;
  const p = parseTrackerPhrase(it.text);
  if (!p) { hint.style.display = 'none'; return; }
  hint.innerHTML = `Track “${esc(p.label)}” as ${p.target} ${PERIOD_WORD[p.period]}? <button type="button" class="secondary" id="trackYes">Make tracker</button> <button type="button" class="secondary" id="trackNo">No thanks</button>`;
  hint.style.display = 'block';
  $('trackYes').onclick = () => { addTracker(p.label, p.target, p.period); hint.style.display = 'none'; setStatus('Tracker added'); };
  $('trackNo').onclick = () => { hint.style.display = 'none'; };
}
// ===== end PREVIEW =====

// ===== PREVIEW: Identity setup + nudge level =====
const PROFILE_KEY = 'bd-profile';
const BECOME_CHOICES = ['More present', 'Healthier', 'Less scattered', 'Better with money', 'Closer to family', 'Always learning', 'Calmer', 'Building something'];
const NUDGE_LEVELS = [
  { id: 'off', name: 'Off', desc: 'Just hold my stuff' },
  { id: 'light', name: 'Light touch', desc: 'A little check-in now and then' },
  { id: 'check', name: 'Check on me', desc: 'Keep me on track' },
  { id: 'stay', name: 'Stay on me', desc: "Don't let me drift" }
];
const THEME_KEY = 'bd-theme';
const LOOKS = [
  { id: 'warm', name: 'Warm', desc: 'A paper journal you want to write in', swatch: 'linear-gradient(90deg,#f4ead8,#e8b86d,#b5522a)' },
  { id: 'playful', name: 'Playful', desc: 'Soft cards, a little celebration', swatch: 'linear-gradient(90deg,#ff7eab,#b388ff,#5aa8ff)' },
  { id: 'calm', name: 'Calm', desc: 'Quiet dark, with a listening glow', swatch: 'linear-gradient(90deg,#0c1018,#5eead4,#07080d)' },
  { id: 'bold', name: 'Bold', desc: 'Big type, built for a quick glance', swatch: 'linear-gradient(90deg,#12110e,#f5c518,#1c1a15)' }
];
const THEME_META = {
  warm: {
    color: '#f4ead8',
    subtitle: "A little notebook for whatever's rattling around.",
    catPh: 'Name a new page...',
    itemPh: "What's rattling around up there?",
    empty: '<div class="empty"><div class="empty-emoji">✎</div><div class="empty-title">A blank page, just for you.</div><div class="empty-sub">Type or talk.</div></div>'
  },
  playful: {
    color: '#fff7fb',
    subtitle: "Spill it. We'll sort the rest together.",
    catPh: 'New pile...',
    itemPh: 'Spill it. No wrong answers.',
    empty: '<div class="empty"><div class="empty-emoji">🎈</div><div class="empty-title">Nothing in here yet — lucky you.</div><div class="empty-sub">Dump whatever\'s buzzing around. No wrong answers.</div></div>'
  },
  calm: {
    color: '#07080d',
    subtitle: 'Get it out. No pressure.',
    catPh: 'New category...',
    itemPh: "Say it. I'll hold it.",
    empty: '<div class="empty"><div class="empty-orb" aria-hidden="true"></div><div class="empty-title">Quiet for now.</div><div class="empty-sub">I\'m right here when you\'re ready.</div></div>'
  },
  bold: {
    color: '#12110e',
    subtitle: "Say it. It's down.",
    catPh: 'New category...',
    itemPh: "Dump it. We'll sort it later.",
    empty: '<div class="empty"><div class="empty-emoji">↑</div><div class="empty-title">Nothing in here.</div><div class="empty-sub">Hit the box up top and get it off your chest.</div></div>'
  }
};
function loadTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY) || 'warm';
    return LOOKS.some(l => l.id === t) ? t : 'warm';
  } catch (e) { return 'warm'; }
}
let currentTheme = loadTheme();
function applyTheme(name, persist) {
  if (!THEME_META[name]) name = 'warm';
  currentTheme = name;
  document.documentElement.setAttribute('data-theme', name);
  document.body.setAttribute('data-theme', name);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', THEME_META[name].color);
  const sub = document.querySelector('.subtitle');
  if (sub) sub.textContent = THEME_META[name].subtitle;
  if (typeof catInput !== 'undefined' && catInput) catInput.placeholder = THEME_META[name].catPh;
  if (typeof itemInput !== 'undefined' && itemInput) itemInput.placeholder = THEME_META[name].itemPh;
  if (persist !== false) {
    try { localStorage.setItem(THEME_KEY, name); } catch (e) {}
  }
  if (typeof window.__bdUpdatePageWhen === 'function') window.__bdUpdatePageWhen();
}
function emptyHTML() {
  const fallback = THEME_META[currentTheme].empty;
  if (currentTheme !== 'warm' || !uiHasCopy('emptyFrontTitle') || !uiHasCopy('emptyFrontSub')) return fallback;
  return '<div class="empty"><div class="empty-emoji">✎</div><div class="empty-title">' + uiCopy('emptyFrontTitle', null, '') + '</div><div class="empty-sub">' + uiCopy('emptyFrontSub', null, '') + '</div></div>';
}
function looksHTML(current, name) {
  return `<div class="ob-looks" role="radiogroup">` + LOOKS.map(l => `<label class="ob-look ${current === l.id ? 'on' : ''}">
    <input type="radio" name="${name}" value="${l.id}" ${current === l.id ? 'checked' : ''}>
    <span class="ob-look-swatch" style="background:${l.swatch}"></span>
    <span class="ob-look-name">${l.name}</span><span class="ob-look-desc">${l.desc}</span></label>`).join('') + `</div>`;
}
function wireLooks(root, onPick) {
  root.querySelectorAll('.ob-look input').forEach(inp => inp.onchange = () => {
    root.querySelectorAll('.ob-look').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    onPick(inp.value);
  });
}

function obEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function migrateProfile(p) {
  if (!p) return p;
  const map = { gentle: 'light', normal: 'check', push: 'stay' };
  if (p.nudge && map[p.nudge]) p.nudge = map[p.nudge];
  return p;
}
function loadProfile() {
  try {
    const p = migrateProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'));
    if (p && p.nudge) { try { localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (e) {} }
    return p;
  } catch (e) { return null; }
}
function saveProfile(p) { try { stampGoals(p); } catch (e) {} p.updatedAt = Date.now(); localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); }
let profile = loadProfile();
let draft = null;

function whyText(p) {
  if (!p) return '';
  const parts = [...(p.become || [])];
  if (p.becomeText) parts.push(p.becomeText);
  return parts.map(s => s.trim()).filter(Boolean).join(' · ');
}
function renderWhy() {
  const el = $('whyLine');
  const w = whyText(profile);
  if (!w) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  el.innerHTML = `<button type="button" id="whyEdit" title="Edit in Settings"><span class="why-label">Your why:</span> <span class="why-text">${obEsc(w)}</span></button>`;
  $('whyEdit').onclick = openSettings;
}

// Single-shot dictation into a field. Hidden when the browser has no speech recognition.
function attachDictation(btn, field) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.style.display = 'none'; return; }
  btn.onclick = () => {
    let wasListening = false;
    try { if (typeof recognition !== 'undefined' && recognition && (userWantsListening || listening)) { wasListening = true; micBtn.click(); } } catch (e) {}
    const r = new SR();
    r.lang = 'en-US'; r.interimResults = false; r.continuous = false;
    btn.classList.add('listening'); btn.textContent = '⏹';
    r.onresult = e => {
      const text = [...e.results].map(x => x[0].transcript).join(' ').trim();
      if (text) field.value = (field.value ? field.value.replace(/\s+$/, '') + ' ' : '') + text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const stop = () => { btn.classList.remove('listening'); btn.textContent = '🎤'; };
    r.onend = stop; r.onerror = stop;
    // Give the main mic a moment to let go (iPhone reports "mic not available" if both grab it at once).
    const go = () => { try { r.start(); } catch (e) { stop(); } };
    if (wasListening) setTimeout(go, 350); else go();
  };
}

function chipsHTML(selected) {
  return BECOME_CHOICES.map(c => `<button type="button" class="ob-chip ${selected.includes(c) ? 'on' : ''}" data-chip="${obEsc(c)}" aria-pressed="${selected.includes(c)}">${obEsc(c)}</button>`).join('');
}
function nudgeHTML(current, name) {
  return `<div class="ob-nudges" role="radiogroup">` + NUDGE_LEVELS.map(n => `<label class="ob-nudge ${current === n.id ? 'on' : ''}">
    <input type="radio" name="${name}" value="${n.id}" ${current === n.id ? 'checked' : ''}>
    <span class="ob-nudge-name">${n.name}</span><span class="ob-nudge-desc">${n.desc}</span></label>`).join('') + `</div>`;
}
function wireChips(root, list) {
  root.querySelectorAll('.ob-chip').forEach(b => b.onclick = () => {
    const c = b.dataset.chip;
    const i = list.indexOf(c);
    if (i >= 0) list.splice(i, 1); else list.push(c);
    b.classList.toggle('on', i < 0);
    b.setAttribute('aria-pressed', String(i < 0));
  });
}
function wireNudges(root, onPick) {
  root.querySelectorAll('.ob-nudge input').forEach(inp => inp.onchange = () => {
    root.querySelectorAll('.ob-nudge').forEach(l => l.classList.toggle('on', l.querySelector('input').checked));
    onPick(inp.value);
  });
}

// ---------- First-run card (inline, never blocks dumping) ----------
function renderWelcome(step) {
  const card = $('welcome');
  if (!card) return;
  if (step == null) {
    if (typeof introIsOpen === 'function' && introIsOpen()) { card.style.display = 'none'; return; }
    let justClosed = false;
    try { justClosed = sessionStorage.getItem('bd-intro-just-closed') === '1'; } catch (e) {}
    const show = !justClosed && (!profile || (!profile.setupDone && !profile.skipped));
    card.style.display = show ? 'block' : 'none';
    if (!show) return;
    card.innerHTML = `<div class="ob-title">Hey 👋 want this to fit you?</div>
      <div class="ob-sub">Two quick questions, about 30 seconds. You can dump stuff first and do this later.</div>
      <div class="ob-actions"><button type="button" id="obStart">Sure</button><button type="button" class="secondary" id="obLater">Not now</button></div>`;
    $('obStart').onclick = () => { draft = { become: [], becomeText: '', matters: '', nudge: 'light', look: currentTheme || 'warm' }; renderWelcome(1); };
    $('obLater').onclick = () => {
      profile = Object.assign(profile || {}, { skipped: true });
      saveProfile(profile);
      card.style.display = 'none';
      setStatus('No problem. It’s in Settings whenever you want it.');
    };
    return;
  }
  card.style.display = 'block';
  const dots = `<div class="ob-dots">${[1,2,3,4,5].map(i => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>`;
  if (step === 1) {
    card.innerHTML = dots + `<div class="ob-title">Who do you want to become?</div>
      <div class="ob-sub">Tap any that fit, or say it your way.</div>
      <div class="ob-chips">${chipsHTML(draft.become)}</div>
      <div class="ob-field"><input id="obBecome" placeholder="e.g. someone who follows through" value="${obEsc(draft.becomeText)}"><button type="button" class="ob-mic" id="obBecomeMic" aria-label="Say it">🎤</button></div>
      <div class="ob-actions"><button type="button" id="obNext1">Next</button><button type="button" class="secondary" id="obSkip1">Skip</button></div>`;
    wireChips(card, draft.become);
    attachDictation($('obBecomeMic'), $('obBecome'));
    const next = () => { draft.becomeText = $('obBecome').value.trim(); renderWelcome(2); };
    $('obNext1').onclick = next; $('obSkip1').onclick = () => renderWelcome(2);
    $('obBecome').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); next(); } };
  } else if (step === 2) {
    card.innerHTML = dots + `<div class="ob-title">What matters most to you right now?</div>
      <div class="ob-sub">Optional. A few words is plenty.</div>
      <div class="ob-field"><textarea id="obMatters" rows="2" placeholder="e.g. my kids, getting the business steady, sleep">${obEsc(draft.matters)}</textarea><button type="button" class="ob-mic" id="obMattersMic" aria-label="Say it">🎤</button></div>
      <div class="ob-actions"><button type="button" id="obNext2">Next</button><button type="button" class="secondary" id="obBack2">Back</button></div>`;
    attachDictation($('obMattersMic'), $('obMatters'));
    $('obNext2').onclick = () => { draft.matters = $('obMatters').value.trim(); renderWelcome(3); };
    $('obBack2').onclick = () => { draft.matters = $('obMatters').value.trim(); renderWelcome(1); };
  } else if (step === 3) {
    card.innerHTML = dots + `<div class="ob-title">How much should I nudge you?</div>
      <div class="ob-sub">You can change this anytime. These are friendly notes in the app for now — phone notifications come later.</div>
      ${nudgeHTML(draft.nudge, 'obNudge')}
      <div class="ob-actions"><button type="button" id="obNext3">Next</button><button type="button" class="secondary" id="obBack3">Back</button></div>`;
    wireNudges(card, v => draft.nudge = v);
    $('obNext3').onclick = () => renderWelcome(4);
    $('obBack3').onclick = () => renderWelcome(2);
  } else if (step === 4) {
    card.innerHTML = dots + `<div class="ob-title">Pick your look</div>
      <div class="ob-sub">Warm is the default. You can switch anytime in Settings.</div>
      ${looksHTML(draft.look || currentTheme || 'warm', 'obLook')}
      <div class="ob-actions"><button type="button" id="obFinish">Done</button><button type="button" class="secondary" id="obBack4">Back</button></div>`;
    wireLooks(card, v => { draft.look = v; applyTheme(v); });
    $('obFinish').onclick = () => {
      applyTheme(draft.look || currentTheme || 'warm');
      profile = Object.assign({}, draft, { setupDone: true, skipped: false });
      saveProfile(profile);
      renderWhy();
      const w = whyText(profile);
      card.innerHTML = `<div class="ob-dots">${[1,2,3,4,5].map(() => '<span class="on"></span>').join('')}</div><div class="ob-title">Got it ✨</div>
        <div class="ob-sub">${w ? 'I’ll keep “' + obEsc(w) + '” in mind.' : 'All set.'} Now get it out of your head.</div>
        <div class="set-label ob-voice-label">Last one (optional): how should I talk to you?</div>
        <div class="ob-sub ob-voice-sub">Real is the default: straight talk, a little annoying, always on your side (clean unless you turn cussing on). Tap another to hear how it sounds. You can change it anytime in Settings.</div>
        <div id="obVoice">${voiceStyleHTML('obVoice')}</div>
        <div class="ob-actions"><button type="button" id="obClose">Start dumping</button></div>`;
      wireVoiceStyle($('obVoice'));
      $('obClose').onclick = () => { card.style.display = 'none'; maybeShowNudge(); maybeShowFriend(); itemInput.focus(); };
    };
    $('obBack4').onclick = () => renderWelcome(3);
  }

}


// ---------- Settings panel ----------
function openSettings() {
  const panel = $('settings');
  const p = profile || {};
  const become = [...(p.become || [])];
  let nudge = p.nudge || 'light';
  panel.innerHTML = `<div class="set-head"><strong>Settings</strong><button type="button" class="secondary" id="setClose" aria-label="Close settings">✕</button></div>
    <div class="set-block-goals">
    <div class="set-label">Who you want to become</div>
    <div class="ob-chips">${chipsHTML(become)}</div>
    <div class="ob-field"><input id="setBecome" placeholder="In your own words" value="${obEsc(p.becomeText || '')}"><button type="button" class="ob-mic" id="setBecomeMic" aria-label="Say it">🎤</button></div>
    <div class="set-label">What matters most right now</div>
    <div class="ob-field"><textarea id="setMatters" rows="2">${obEsc(p.matters || '')}</textarea><button type="button" class="ob-mic" id="setMattersMic" aria-label="Say it">🎤</button></div>
    </div>
    <div class="set-block-looks">
    <div class="set-label">Your look</div>
    ${looksHTML(currentTheme || 'warm', 'setLook')}
    </div>
    <div class="set-block-friend">
    <div class="set-label">Nudges <span class="set-note">(friendly notes in the app for now; phone notifications come after sync)</span></div>
    ${nudgeHTML(nudge, 'setNudge')}
    ${friendSettingsHTML(p)}
    </div>
    <div class="ob-actions"><button type="button" id="setSave">Save</button><button type="button" class="secondary" id="setRerun">Run setup again</button><button type="button" class="secondary" id="setClear">Clear my why</button></div>`;
  panel.style.display = 'block';
  wireChips(panel, become);
  wireLooks(panel, v => applyTheme(v));
  wireNudges(panel, v => nudge = v);
  attachDictation($('setBecomeMic'), $('setBecome'));
  attachDictation($('setMattersMic'), $('setMatters'));
  wireFriendSettings(panel);
  $('setClose').onclick = closeSettings;
  $('setSave').onclick = () => {
    profile = Object.assign({}, profile || {}, { become, becomeText: $('setBecome').value.trim(), matters: $('setMatters').value.trim(), nudge, checkins: !!($('setCheckins') && $('setCheckins').checked), setupDone: true, skipped: false });
    saveProfile(profile); renderWhy(); closeSettings(); maybeShowNudge(); maybeShowFriend(); setStatus('Saved');
  };
  $('setRerun').onclick = () => { closeSettings(); draft = { become: [...become], becomeText: (profile && profile.becomeText) || '', matters: (profile && profile.matters) || '', nudge, look: currentTheme || 'warm' }; renderWelcome(1); $('welcome').scrollIntoView({ block: 'nearest' }); };
  $('setClear').onclick = () => {
    askSheet({ title: 'Clear your why and nudge setting?', body: 'You can set them up again any time.', ok: 'Clear', cancel: 'Keep them', danger: true }).then(yes => {
      if (!yes) return;
      profile = { skipped: true }; saveProfile(profile); renderWhy(); hideNudge(); closeSettings(); setStatus('Cleared');
    });
  };
  panel.scrollIntoView({ block: 'nearest' });
}
function closeSettings() { const p = $('settings'); p.style.display = 'none'; p.innerHTML = ''; }


function hideNudge() {
  const card = $('nudgeCard');
  if (card) { card.style.display = 'none'; card.innerHTML = ''; }
}
function maybeShowNudge() {
  const card = $('nudgeCard');
  if (!card) return;
  hideNudge();
  if (!profile || !profile.setupDone) return;
  const level = profile.nudge || 'off';
  if (level === 'off') return;
  const welcome = $('welcome');
  if (welcome && welcome.style.display === 'block') return;
  const now = new Date();
  const today = ymd(now);
  let seen = {};
  try { seen = JSON.parse(localStorage.getItem('bd-nudge-seen') || '{}'); } catch (e) { seen = {}; }
  let sessionSeen = false;
  try { sessionSeen = sessionStorage.getItem('bd-nudge-session') === today; } catch (e) {}
  const dueNow = items.filter(i => !i.deleted && !i.ghosted && i.due && dayDiff(i.due, now) <= 0);
  const unfinished = items.filter(i => !i.deleted && !i.ghosted);
  const shortTrackers = (typeof trackers !== 'undefined' ? trackers : []).filter(t => t.count < t.target);
  const shortDaily = shortTrackers.filter(t => t.period === 'day');
  let msg = '';
  const seed = today;
  const trList = arr => arr.map(t => t.label + ' ' + t.count + '/' + t.target).join(', ');
  const dueMsg = () => dueNow.length === 1
    ? friendLine('nudgeDueOne', { item: dueNow[0].text }, seed)
    : friendLine('nudgeDueMany', { n: dueNow.length }, seed);
  const openMsg = () => {
    const w = whyText(profile);
    return w ? friendLine('nudgeOpenWhy', { why: w, n: unfinished.length }, seed) : friendLine('nudgeOpen', { n: unfinished.length }, seed);
  };
  let clear = false;
  if (level === 'light') {
    if (seen.date === today) return;
    if (dueNow.length) msg = dueMsg();
    else if (shortDaily.length) msg = friendLine('nudgeTracker', { list: trList(shortDaily) }, seed);
    else return;
  } else {
    if (level === 'check' && seen.date === today) return;
    if (level === 'stay' && sessionSeen) return;
    if (dueNow.length) msg = dueMsg();
    else if (shortTrackers.length) msg = friendLine('nudgeTracker', { list: trList(shortTrackers) }, seed);
    else if (unfinished.length) msg = openMsg();
    else { msg = friendLine('nudgeClear', {}, seed); clear = true; }
  }
  if (!msg) return;
  if (!clear) msg += friendTail(seed);
  card.innerHTML = `<div class="ob-title">${friendLine('nudgeTitle', {}, seed)}</div>
    <div class="ob-sub">${msg}</div>
    <div class="ob-actions"><button type="button" id="nudgeOk">Got it</button></div>`;
  card.style.display = 'block';
  $('nudgeOk').onclick = () => {
    hideNudge();
    try {
      localStorage.setItem('bd-nudge-seen', JSON.stringify({ date: today, dismissed: true }));
      sessionStorage.setItem('bd-nudge-session', today);
    } catch (e) {}
  };
  try {
    if (level === 'stay') sessionStorage.setItem('bd-nudge-session', today);
    else localStorage.setItem('bd-nudge-seen', JSON.stringify({ date: today }));
  } catch (e) {}
}

function initProfileUI() {
  applyTheme(loadTheme());
  $('settingsBtn').onclick = () => ($('settings').style.display === 'block' ? closeSettings() : openSettings());
  renderWhy();
  renderWelcome();
  maybeShowNudge();
  maybeShowFriend();
}

// ===== Friend features (2026-11-18): why tags, weekly "How'd it go" card, goal check-ins, friend personality =====
// Uses var/function only: render() and maybeShowNudge() can run before this block finishes loading.
var FRIEND_COPY = /*FRIEND_COPY_START*/{
  gentle: {
    sample: ["No pressure at all. I'm here whenever you're ready, like a cozy sweater with opinions."],
    addAck: ["Got it. “{item}” is safe with me.", "Tucked away: “{item}”. One less thing to carry around in your head.", "Noted, gently. “{item}” is on the page now."],
    nudgeItem: ["Whenever you're ready, “{item}” is still here. It's very patient.", "Just a soft thought: “{item}” might feel lighter once it's done."],
    firstStep: ["If “{item}” feels like a lot, what's the tiniest first step? Two minutes totally counts.", "Not sure about “{item}” yet? That's okay. Tap Not sure and we'll look again in a few days."],
    weeklyBig: ["You finished {n} things this week. That's really lovely to see.", "{n} things done this week. Be proud of that, quietly or loudly.", "{n} things done. I'll be over here, quietly cheering."],
    weeklyMid: ["{n} things done this week. Every one of them counts.", "You got {n} things done. That's real progress, and it looks good on you.", "{n} done this week. Slow and steady has a pretty good track record."],
    weeklySmall: ["{n} {things} done this week, and that's okay. Small steps are still steps.", "You finished {n} this week. That counts, truly.", "{n} done. Some weeks are lighter. Those count too."],
    weeklyNone: ["Quiet week? That's okay. Rest counts too. Want to pick one small thing for this week?", "Nothing checked off this week, and that's alright. The list will keep, I promise.", "Some weeks are just for getting through. Want to choose one gentle thing to start with?"],
    weeklyLetGo: ["You also let go of {n}. Making space is kind to yourself.", "{n} let go. Your list can breathe a little now."],
    weeklyOpen: ["{n} still on the page, no rush.", "{n} still waiting, patiently. No rush."],
    weeklyAsk: ["Anything you'd like to carry into next week? Only if you want to.", "Is there anything you'd like to bring along into next week?"],
    weeklyGood: ["Lovely. See you next week.", "Sounds good. I'll be right here, being a notebook."],
    weeklyFocus: ["Got it. {n} gentle focus {things} for the week, marked with a ★.", "Starred {n} for this week. One at a time is plenty."],
    weeklyNotNow: ["That's okay. It's in Settings whenever you'd like it.", "No problem at all. I'll check in next week."],
    driftTitle: ["Just a soft thought", "A gentle check-in"],
    drift: ["You mentioned {said} matters to you, and I haven't seen {missing} this week. Is it still something you want, or would you like to adjust it?", "No pressure at all: {said} has been quiet for a week. Want to add one tiny thing for it, or let it rest for now?", "I noticed {said} hasn't come up lately. That's okay. Would it help to add something small?"],
    mute: ["Of course. I won't bring up {said} again. You can change that in Settings.", "That makes sense. I'll stop asking about {said}."],
    addFor: ["Okay. Whatever you add next will be tied to {goal}.", "Sounds good. Your next item will be for {goal}."],
    biggerTitle: ["Would a little help with something bigger be nice?"],
    biggerBody: ["If you'd like, tell me one thing you're working toward, and I'll gently keep it in view.", "Is there one thing you're hoping to grow toward? Share it if you like, and I'll quietly keep it in mind."],
    biggerSaved: ["Thank you for sharing that. I'll keep it in mind.", "That's a lovely thing to work toward. I'll hold onto it."],
    biggerNotNow: ["Of course. It's in Settings if you ever want it.", "That's perfectly fine. I won't ask again."],
    nudgeTitle: ["A little note", "Just a soft note"],
    nudgeDueOne: ["Just a soft reminder: “{item}” is due. No stress.", "Whenever you get a moment: “{item}” is due. It asked nicely."],
    nudgeDueMany: ["{n} things are due. Take them one at a time.", "There are {n} things due. No rush, one by one."],
    nudgeTracker: ["{list} so far. Every bit helps.", "Gentle tracker check: {list}."],
    nudgeOpenWhy: ["Still here for “{why}”. {n} {things} waiting, whenever you're ready.", "Holding onto “{why}” for you. {n} {things} on the page."],
    nudgeOpen: ["{n} {things} in the dump, whenever you're ready.", "I'm keeping {n} {things} safe for you. All cozy."],
    nudgeClear: ["All clear. Enjoy the quiet, you earned it.", "Nothing waiting. Enjoy the quiet."],
    tailLight: ["No pressure.", "Only if it feels right."],
    tailStay: ["Maybe one small thing today?", "Even one tiny step today would be lovely."]
  },
  warm: {
    sample: ["Look at you, 12 things done this week. Don't let it go to your head. Okay, maybe a little."],
    addAck: ["Got it! “{item}” is on the list. Out of your head, onto the page.", "Added “{item}”. See? That didn't hurt.", "“{item}”, noted. Your brain says thanks."],
    nudgeItem: ["Hey, “{item}” is still sitting there. Want to knock it out before it gets comfortable?", "Friendly nudge: “{item}”. Future you is already sending a thank-you card."],
    firstStep: ["Stuck on “{item}”? Just do the first five minutes. That's the whole trick.", "Not sure about “{item}”? Tap Not sure, no shame. I'll check back in a few days."],
    weeklyBig: ["Look at you, {n} things done this week. Don't let it go to your head. Okay, maybe a little.", "{n} things off your plate this week. Your list is a little scared of you now.", "Well, somebody showed up this week: {n} done. 🎉"],
    weeklyMid: ["{n} things done this week. Steady wins it, and you're steady.", "{n} done this week. That counts, seriously.", "You knocked out {n} things. Nice work. I'm telling everyone."],
    weeklySmall: ["{n} {things} done this week. Hey, it's a start, and starts count.", "{n} done. Small week, but you still showed up for it.", "You got {n} done. Not every week has to be a movie montage."],
    weeklyNone: ["Rough week? Happens to the best of us. Want to pick just one thing to start fresh with?", "Quiet week on the list. No judgment, life gets busy. Want to pick one thing for this week?", "Nothing checked off this week. The list missed you. Fresh page, fresh start?"],
    weeklyLetGo: ["You also let go of {n}. Honestly, that's a win too.", "Let go of {n}. Saying “nope” counts as progress."],
    weeklyOpen: ["{n} still hanging around, acting casual.", "{n} still open."],
    weeklyAsk: ["Anything to carry into next week?", "Anything you want to bring into next week?"],
    weeklyGood: ["Love it. See you next week.", "Nice. Onward."],
    weeklyFocus: ["Got it. ★ on {n} for this week.", "Starred {n}. That's your week, right there."],
    weeklyNotNow: ["No worries. It's in Settings if you want it later.", "All good. I'll pretend I didn't see that. Catch you next week."],
    driftTitle: ["Real talk", "Quick check-in", "Honest friend moment"],
    drift: ["Hey, real talk: we said {said} mattered, but I haven't seen {missing} this week. Still a goal, or should we rethink it?", "Noticed something: {said} has been quiet for a week. Life happens. Keep it, or change it up?", "Friend check: nothing for {said} in 7 days. Want to give it one small thing, or is it time to recalibrate?"],
    mute: ["Got it, I'll stop asking about {said}. You can undo that in Settings.", "Fair enough. No more check-ins about {said}."],
    addFor: ["Okay! Whatever you add next gets tied to {goal}.", "Nice. Your next item counts toward {goal}."],
    biggerTitle: ["Want me to help with something bigger?"],
    biggerBody: ["Tell me one thing you're working toward, and I'll help you keep it in view.", "What's one thing you're working toward? I'll help you stay on track with it."],
    biggerSaved: ["Love that. I'll keep an eye out for it.", "Got it. I'm in your corner on this one."],
    biggerNotNow: ["All good. If you ever want to, it's in Settings.", "No worries. I won't bug you about it again."],
    nudgeTitle: ["A note from me", "Hey, quick one"],
    nudgeDueOne: ["Heads up: “{item}” is due. It's been very patient with you.", "Just a nudge: “{item}” is due."],
    nudgeDueMany: ["Heads up: {n} things are due.", "{n} things are due. One at a time, you've got this."],
    nudgeTracker: ["Checking in: {list}.", "Quick tracker check: {list}."],
    nudgeOpenWhy: ["Still here for “{why}”. {n} {things} waiting when you're ready.", "Still heading toward “{why}”? {n} {things} in the dump."],
    nudgeOpen: ["I'm still here. {n} {things} in the dump, and they're getting chatty.", "{n} {things} waiting. Pick one when you're ready."],
    nudgeClear: ["Nice and clear. Suspiciously clear. I'm proud of you.", "Clean slate. Enjoy it."],
    tailLight: ["No pressure, just a thought.", "Totally your call."],
    tailStay: ["One small thing today? You've got this.", "Let's not let it slip. One thing today?"]
  },
  drill: {
    sample: ["On your feet, recruit! One thing, right now. The list does not do itself!"],
    addAck: ["“{item}”: logged! Congratulations, it's a mission now!", "Copy that! “{item}” is on the board. Do not keep it waiting!", "Received, recruit! “{item}” is officially your problem now!"],
    nudgeItem: ["“{item}” is still on the board, soldier! Did I stutter?!", "Eyes front! “{item}”! It is not going to handle itself!"],
    firstStep: ["“{item}” too big? Then break it down! First step, two minutes, GO!", "Unsure about “{item}”? Tap Not sure, then decide in three days. Indecision is not a strategy, recruit!"],
    weeklyBig: ["{n} done this week! Outstanding! Don't get comfortable, recruit!", "{n} things down! I'd shed a tear if I were allowed to. Same again next week!", "{n} completed. That's how it's done. Now drop and give me {n} more!"],
    weeklyMid: ["{n} done. Solid. Now push for more!", "{n} down this week. Decent. Next week we go harder!", "{n} complete. Respectable. Keep the pace, soldier!"],
    weeklySmall: ["{n} done. It's a start. Next week we go again!", "{n} on the board. That's a warm-up, not a workout!", "{n} done. Not bad. Not finished either!"],
    weeklyNone: ["Zero done this week?! Unacceptable! ...Fine. Pick one thing and start now.", "Rough week. Shake it off, soldier! Pick one target and go!", "Nothing checked off. Reset. One thing, today. Hup!"],
    weeklyLetGo: ["Dropped {n} dead weight. Good call!", "Cut {n}. Lighter pack, faster march!"],
    weeklyOpen: ["{n} still open. That will not do itself, recruit!", "{n} on the list. Eyes front!"],
    weeklyAsk: ["What's the mission for next week?!", "Pick your targets for next week, recruit!"],
    weeklyGood: ["Good. Dismissed!", "Copy that. Move out!"],
    weeklyFocus: ["{n} targets locked. ★ Execute!", "Locked in {n}. No excuses!"],
    weeklyNotNow: ["Fine. It's in Settings when you're ready to report.", "Noted. I'll be back next week. I always come back."],
    driftTitle: ["Attention!", "Status check!"],
    drift: ["You said {said} mattered! Seven days, and I haven't seen {missing}. Still a goal, or are we changing orders?", "Seven days quiet on {said}. You set this goal, soldier. Recommit or rethink it!", "Report: zero activity on {said} this week. Fix it or change the plan!"],
    mute: ["Understood. {said} is off the radar. Settings if you change your mind.", "Copy. No more reports on {said}."],
    addFor: ["Good. Next item goes to {goal}. Make it count!", "Next item is for {goal}. Go!"],
    biggerTitle: ["What's the mission?"],
    biggerBody: ["Name one thing you're working toward. I'll make sure you don't lose sight of it.", "Every soldier needs an objective. What's yours?"],
    biggerSaved: ["Mission logged. I'll be watching. Always watching.", "Objective set. Now we work!"],
    biggerNotNow: ["Fine. Settings, when you're ready.", "At ease. I won't ask again."],
    nudgeTitle: ["Listen up!", "Status check!"],
    nudgeDueOne: ["“{item}” is due. Handle it!", "Due now: “{item}”. Move, move, move!"],
    nudgeDueMany: ["{n} things due. Get after them!", "{n} items due. Knock them out!"],
    nudgeTracker: ["Status: {list}. Close the gap!", "Tracker report: {list}. Finish strong!"],
    nudgeOpenWhy: ["You're working toward “{why}”. {n} {things} on the list. Move!", "“{why}” doesn't happen by itself. {n} {things} waiting!"],
    nudgeOpen: ["{n} {things} on the list. Pick one. Go!", "{n} {things} open. Start with one. That's an order!"],
    nudgeClear: ["List is clear. Outstanding! Stay ready!", "All clear. I'm almost impressed. Almost."],
    tailLight: ["Your call, recruit.", "When you're ready. Be ready soon."],
    tailStay: ["Today. Let's go!", "No more waiting. Move!"],
    cuss: {
      sample: ["On your feet, recruit! One thing, right now. Let's fucking go!"],
      addAck: ["“{item}”: logged! Now get your ass on it!", "Copy that! “{item}” is on the damn board!"],
      nudgeItem: ["“{item}” is still sitting there, soldier! Get your ass on it!", "“{item}”! It is not going to handle its damn self!"],
      firstStep: ["“{item}” too big? Break that shit down! First step, two minutes, GO!"],
      weeklyBig: ["{n} done this week! Hell yes! Keep moving!", "{n} things down! Damn good work. Same again next week!"],
      weeklyNone: ["Zero done this week?! Shit happens. Once. Pick one thing and start now!", "Rough damn week. Shake it off! One target. Go!"],
      weeklyAsk: ["What's the damn mission for next week?!", "Pick your targets. We get shit done next week!"],
      drift: ["Seven days, nothing on {said}. Damn it, you set this goal. Recommit or rethink it!", "{said}: no movement in a week. Get your shit together on it or change the plan. Your call!"],
      nudgeOpen: ["{n} {things} on the list. Pick one. Let's fucking go!", "{n} {things} open. Get your ass moving on one!"],
      tailStay: ["Today. Let's fucking go!", "No more waiting. Get shit done!"]
    }
  },
  real: {
    sample: ["Hey. Yeah, I'm gonna be annoying, but you're going to get stuff done and be the person you want to be. So let's go."],
    addAck: ["Got it. “{item}” is on the list. Now it's my problem too.", "“{item}”, added. Yeah, I'm gonna bring this up again.", "Added “{item}”. Look at you, writing stuff down like an adult."],
    nudgeItem: ["So… “{item}”. Still on the list. Still yours. Ten minutes, let's go.", "Hey, “{item}” isn't going to do itself, and I'm definitely not doing it.", "Real talk: “{item}” has been sitting there long enough. Knock it out and come brag to me."],
    firstStep: ["“{item}” feels big? Cool. What's the first ten-minute piece? Do that. Done.", "Not sure about “{item}”? Tap Not sure. In three days you're deciding, though. I'll be there. Watching."],
    weeklyBig: ["{n} things done this week? Who even are you. Don't answer, keep going.", "{n} done. You actually did the thing. Proud of you, and I'm not even being nice.", "{n} things done. Okay, show-off. Same again next week."],
    weeklyMid: ["{n} done this week. Not bad. I see you.", "{n} things handled. That's real. Let's keep it rolling.", "{n} done. Solid. Not legendary, but solid."],
    weeklySmall: ["{n} done. Not your biggest week, but you showed up, and that matters.", "{n} {things} done. Hey, we take those.", "{n} done. Okay, okay. Next week we turn it up."],
    weeklyNone: ["Yeah, nothing got checked off this week. Bold strategy. Pick one thing and let's get you rolling again.", "Zero this week. I'm not gonna pretend that's the plan, but it's fine for now. One thing?", "Rough week, huh? I get it. The list didn't go anywhere, though. One thing?"],
    weeklyLetGo: ["Also let go of {n}. Honestly? Good. Not everything deserves your time.", "You let {n} go. Smart. Less noise."],
    weeklyOpen: ["{n} still sitting there, staring at you.", "{n} still open. Just saying."],
    weeklyAsk: ["So what are we actually carrying into next week?", "What's getting done next week? For real this time."],
    weeklyGood: ["Cool. Talk next week. I'll be annoying again then.", "Love it. I'll be here."],
    weeklyFocus: ["Okay, {n} starred. Those are happening. ★", "{n} locked in. I'm holding you to it. Like, a lot."],
    weeklyNotNow: ["Fine, fine. It's in Settings. I'll act like I'm not hurt.", "Okay, skipping it. I'll be back next week, though. I always come back."],
    driftTitle: ["Okay, real talk", "Yeah, I'm gonna say it"],
    drift: ["Hey, yeah, I'm gonna be annoying: you said {said} mattered, and I haven't seen {missing} all week. Still the goal, or are we changing it?", "Not judging, just noticing: {said} has been dead quiet for a week. You still want this? Because I think you do.", "Real talk, because I care: I haven't seen {missing} in 7 days. Want to throw one thing on the list for {said} right now?"],
    mute: ["Got it, I'll drop the {said} thing. Undo's in Settings if you miss me nagging.", "Fair. I'll stop bringing up {said}."],
    addFor: ["Yes. Next thing you add is for {goal}. Go.", "Love it. Whatever you add next counts for {goal}."],
    biggerTitle: ["Okay, what are we working toward?"],
    biggerBody: ["Tell me one thing you actually want. I'll be the friend who keeps bringing it up.", "What's the one thing you keep saying you'll do? Tell me, and I'll keep you honest."],
    biggerSaved: ["Love it. I'm gonna keep bugging you about it.", "Noted. You're stuck with me on this one."],
    biggerNotNow: ["Fine, I'll leave it. It's in Settings if you change your mind.", "Okay, okay. I won't ask again."],
    nudgeTitle: ["Hey you", "Real quick"],
    nudgeDueOne: ["“{item}” is due. Just saying. Loudly.", "So… “{item}” is due. You've got this. You also don't have a choice."],
    nudgeDueMany: ["{n} things are due. Let's knock one out.", "{n} things due. Pick the easiest and go. I won't tell."],
    nudgeTracker: ["{list}. You know you want to finish that.", "Tracker check: {list}. Close it out."],
    nudgeOpenWhy: ["Remember “{why}”? {n} {things} waiting. Let's go.", "You said “{why}”. {n} {things} on the list. I believe you."],
    nudgeOpen: ["{n} {things} in the dump. Pick one, let's go.", "{n} {things} waiting on you. Not getting any younger over there."],
    nudgeClear: ["List's clear. Look at you. Who are you right now?", "Nothing waiting. Weird flex, but okay."],
    tailLight: ["No big deal, just saying.", "Up to you. I'm just the friend who says it."],
    tailStay: ["Seriously, one thing today. Let's go.", "You told me to stay on you, so: today."],
    emptyFrontTitle: ["Oh, look at that. A blank page, just ready for you."],
    emptyFrontSub: ["Type or talk whenever you're ready."],
    emptyPage: ["Nothing on this page yet. Type or talk whenever you're ready."],
    emptySearch: ["Hmm, nothing in here matches “{q}”."],
    addedPageUncat: ["New items will go uncategorized until you assign them."],
    addedPageDest: ["New items will still go to {dest} until you assign them."],
    itemAdded: ["Got it — “{item}” is on the list."],
    capturedUnsorted: ["Tossed it in Unsorted."],
    cuss: {
      sample: ["Hey. Yeah, I'm gonna be annoying, but you're going to get shit done and be the person you want to be. So let's fucking go."],
      addAck: ["Got it. “{item}” is on the list. Now let's get shit done.", "“{item}”, added. Yeah, I'm gonna be annoying about this one. Damn right."],
      nudgeItem: ["So… “{item}”. Still sitting there. Get your shit together and knock it out.", "“{item}” isn't going to do itself, and I'm sure as hell not doing it."],
      firstStep: ["“{item}” feels big? Screw it, do the first ten minutes. That's it. Let's fucking go."],
      weeklyBig: ["{n} things done this week? Hell yes. Who even are you.", "Damn, {n} done. You're actually doing it."],
      weeklyNone: ["Yeah, kind of a shit week. It happens. Pick one thing and let's get you rolling again.", "Nothing checked off. Hell, we all have those. One thing?"],
      weeklyAsk: ["So what shit are we getting done next week?", "What's actually getting done next week? For real this time, damn it."],
      drift: ["Hey, yeah, I'm gonna be annoying: you said {said} mattered and I haven't seen {missing} all damn week. Still the goal, or are we changing it?", "Real talk: {said} has been dead quiet for 7 days. You want this. Let's get some shit done for it."],
      nudgeOpen: ["{n} {things} in the dump. Pick one. Let's fucking go.", "{n} {things} waiting. Get some shit done, you've got this."],
      tailStay: ["One thing today. Let's fucking go.", "Today. No bullshit, you've got this."]
    }
  }
}/*FRIEND_COPY_END*/;
var FRIEND_DAY = 86400000;
// 2026-11-19: Real (clean, cussing off) is the default for anyone who hasn't picked. A saved pick always wins.
var DEFAULT_VOICE_STYLE = 'real';
var VOICE_STYLES = [
  { id: 'gentle', name: 'Gentle', desc: 'Soft, a little playful' },
  { id: 'warm', name: 'Warm', desc: 'Friendly, light teasing' },
  { id: 'drill', name: 'Drill Sergeant', desc: 'Loud, tough love' },
  { id: 'real', name: 'Real', desc: 'Your best friend. Blunt, funny' }
];
var GOAL_INFO = {
  'More present': { said: 'being more present', missing: 'any unplugged time or real hangouts', kw: ['present', 'unplug', 'phone', 'dinner', 'date night', 'friend', 'hang', 'mindful', 'meditat', 'walk', 'kids', 'family'] },
  'Healthier': { said: 'getting healthier', missing: 'any workouts, walks, or water', kw: ['gym', 'workout', 'work out', 'exercise', 'run', 'walk', 'water', 'salad', 'veg', 'sleep', 'doctor', 'dentist', 'health', 'steps', 'yoga', 'lift', 'meal', 'protein', 'stretch', 'bike', 'swim'] },
  'Less scattered': { said: 'feeling less scattered', missing: 'any planning or tidying', kw: ['plan', 'organiz', 'organis', 'clean', 'tidy', 'declutter', 'schedule', 'calendar', 'inbox', 'file', 'sort', 'list'] },
  'Better with money': { said: 'getting better with money', missing: 'any budget or money stuff', kw: ['budget', 'money', 'save', 'saving', 'bill', 'bank', 'pay', 'invest', 'debt', 'spend', 'tax', 'insurance', 'bills'] },
  'Closer to family': { said: 'being closer to family', missing: 'any calls or time with family', kw: ['mom', 'dad', 'family', 'kids', 'son', 'daughter', 'wife', 'husband', 'brother', 'sister', 'grandma', 'grandpa', 'call', 'visit', 'birthday'] },
  'Always learning': { said: 'learning new stuff', missing: 'any reading or learning', kw: ['read', 'book', 'learn', 'course', 'class', 'study', 'podcast', 'practice', 'lesson', 'chapter', 'library', 'tutorial'] },
  'Calmer': { said: 'feeling calmer', missing: 'any downtime or breathers', kw: ['breath', 'meditat', 'journal', 'rest', 'nap', 'yoga', 'relax', 'calm', 'bath', 'walk', 'quiet', 'therapy'] },
  'Building something': { said: 'building something', missing: 'anything for your project', kw: ['build', 'business', 'project', 'side', 'launch', 'write', 'design', 'code', 'client', 'idea', 'website', 'app', 'pitch'] }
};
// Free-text goals ("be more studious") borrow keywords from the closest built-in goal.
var GOAL_SYNONYMS = [
  [/stud|read|learn|book|school|class|smart/, 'Always learning'],
  [/health|fit|gym|weight|run|strong|exercise|active/, 'Healthier'],
  [/money|budget|sav|debt|financ|rich/, 'Better with money'],
  [/family|kid|mom|dad|wife|husband|partner|parent/, 'Closer to family'],
  [/calm|stress|anx|peace|mindful|relax/, 'Calmer'],
  [/present|phone|attentive/, 'More present'],
  [/organi|scatter|clutter|tidy|focus|follow/, 'Less scattered'],
  [/business|build|project|launch|side|create|write/, 'Building something']
];
var GOAL_STOP = ['someone', 'who', 'more', 'less', 'better', 'being', 'become', 'want', 'through', 'really', 'things', 'stuff', 'person', 'with', 'that', 'this', 'about', 'always', 'just', 'like', 'have', 'from', 'into', 'some', 'more'];
var friendMem = {};
function friendPlain(h) { var d = document.createElement('div'); d.innerHTML = String(h || ''); return d.textContent; }
function fToast(msg, undoFn) { showVoiceToast(friendPlain(msg), undoFn); }
var pendingWhyGoal = null;

function friendPreviewMode() { return !!(typeof window !== 'undefined' && window.__bdFriendPreview); }
function fGet(k) {
  if (friendPreviewMode() && Object.prototype.hasOwnProperty.call(friendMem, k)) return friendMem[k];
  try { return localStorage.getItem(k); } catch (e) { return null; }
}
function fSet(k, v) {
  if (friendPreviewMode()) { friendMem[k] = v; return; }
  try { localStorage.setItem(k, v); } catch (e) {}
}
function voiceStyle() {
  var s = null;
  try { s = localStorage.getItem('bd-voice-style'); } catch (e) {}
  return VOICE_STYLES.some(function (v) { return v.id === s; }) ? s : DEFAULT_VOICE_STYLE;
}
function setVoiceStyle(s) { try { localStorage.setItem('bd-voice-style', s); } catch (e) {} }
function cussAllowed(style) { return style === 'drill' || style === 'real'; }
function cussOn() {
  var on = false;
  try { on = localStorage.getItem('bd-voice-cuss') === '1'; } catch (e) {}
  return on && cussAllowed(voiceStyle());
}
function friendHash(s) { var h = 7; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function friendPool(type, style, cuss) {
  style = style || voiceStyle();
  if (cuss == null) cuss = cussOn();
  var c = FRIEND_COPY[style] || FRIEND_COPY.warm;
  var pool = (cuss && c.cuss && c.cuss[type]) ? c.cuss[type] : c[type];
  if (!pool || !pool.length) pool = FRIEND_COPY.warm[type];
  return pool || [''];
}
// One line of friend copy, picked by a stable seed (same week/day = same wording), params HTML-escaped.
function friendLine(type, params, seed) { return friendLineAs(voiceStyle(), cussOn(), type, params, seed); }
function friendLineAs(style, cuss, type, params, seed) {
  if (!cussAllowed(style)) cuss = false;
  var pool = friendPool(type, style, !!cuss);
  var t = pool[friendHash(String(seed || '') + '|' + type + '|' + style) % pool.length];
  params = params || {};
  if (params.n != null && params.things == null) params.things = Number(params.n) === 1 ? 'thing' : 'things';
  var out = t.replace(/\{(\w+)\}/g, function (m, k) { return params[k] != null ? obEsc(params[k]) : m; });
  return out.charAt(0).toUpperCase() + out.slice(1);
}
// UI chrome wording from the current voice (never cussing). A voice without the line gets the caller's fallback, not Warm's.
function uiHasCopy(type) {
  var c = FRIEND_COPY[voiceStyle()];
  return !!(c && c[type] && c[type].length);
}
// For innerHTML: params come back HTML-escaped, so an HTML fallback must be escaped by the caller too.
function uiCopy(type, params, fallback) {
  return uiHasCopy(type) ? friendLineAs(voiceStyle(), false, type, params) : fallback;
}
// For textContent / setStatus: plain text, so names like "R&D" don't show as entities.
function uiCopyText(type, params, fallback) {
  return uiHasCopy(type) ? friendPlain(friendLineAs(voiceStyle(), false, type, params)) : fallback;
}
function friendLevel() {
  var n = profile && profile.nudge;
  return n || 'light'; // people who skipped setup never picked Off
}
function friendTail(seed) {
  var l = friendLevel();
  if (l === 'light') return ' ' + friendLine('tailLight', {}, seed);
  if (l === 'stay') return ' ' + friendLine('tailStay', {}, seed);
  return '';
}

// ---- Goals ----
function friendGoalsOf(p) {
  p = p || {};
  var g = (p.become || []).slice();
  if (p.becomeText && String(p.becomeText).trim()) g.push(String(p.becomeText).trim());
  return g.filter(Boolean);
}
function friendGoals() { return friendGoalsOf(profile); }
function stampGoals(p) {
  if (!p) return;
  // Goals saved before this feature have no dates: treat them as at least as old as the last profile save.
  var legacy = !p.goalAdded;
  p.goalAdded = p.goalAdded || {};
  friendGoalsOf(p).forEach(function (g) { if (!p.goalAdded[g]) p.goalAdded[g] = legacy ? (p.updatedAt || 1) : bdNow(); });
}
function goalSaid(g) { return GOAL_INFO[g] ? GOAL_INFO[g].said : '“' + g + '”'; }
function goalMissing(g) { return GOAL_INFO[g] ? GOAL_INFO[g].missing : 'anything for it'; }
function goalShort(g) { g = String(g || ''); return g.length > 28 ? g.slice(0, 26) + '…' : g; }
function goalKeywords(g) {
  var kws = GOAL_INFO[g] ? GOAL_INFO[g].kw.slice() : [];
  if (!GOAL_INFO[g]) {
    var low = String(g).toLowerCase();
    low.split(/[^a-z']+/).forEach(function (w) { if (w.length >= 4 && GOAL_STOP.indexOf(w) < 0) kws.push(w.replace(/(ing|ed|es|s)$/, '')); });
    GOAL_SYNONYMS.forEach(function (pair) { if (pair[0].test(low)) kws = kws.concat(GOAL_INFO[pair[1]].kw); });
  }
  return kws.filter(function (k) { return k && k.length >= 3; });
}
function kwMatch(text, kws) {
  text = ' ' + String(text || '').toLowerCase();
  return kws.some(function (k) { return text.indexOf(' ' + k) >= 0 || new RegExp('[^a-z]' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(text); });
}
function itemCreatedMs(it) {
  if (typeof it.createdAt === 'number') return it.createdAt;
  var id = Number(it.id);
  return id > 1e12 ? Math.floor(id) : 0;
}
function itemDoneMs(it) {
  if (typeof it.doneAt === 'number') return it.doneAt;
  if (it.ghosted && it.finishedAt) { var n = Date.parse(it.finishedAt); if (!isNaN(n)) return n; }
  return 0;
}
// Latest time anything touched this goal: a linked why, a keyword in an item/category/why, or a matching tracker.
function goalActivityMs(g) {
  var kws = goalKeywords(g);
  var latest = (profile && profile.goalAdded && profile.goalAdded[g]) || 0;
  items.forEach(function (it) {
    if (it.deleted) return;
    var path = it.category ? (typeof catPath === 'function' ? catPath(it.category) : it.category) : '';
    var linked = it.whyGoal === g || kwMatch((it.text || '') + ' ' + path + ' ' + (it.why || ''), kws);
    if (linked) latest = Math.max(latest, itemCreatedMs(it), itemDoneMs(it), it.whyAt || 0);
  });
  (typeof trackers !== 'undefined' ? trackers : []).forEach(function (t) {
    if (t.goal === g || kwMatch(t.label, kws)) latest = Math.max(latest, t.lastTapAt || 0, t.created || 0);
  });
  return latest;
}
function friendSinceMs() {
  var v = Number(fGet('bd-friend-since'));
  if (v) return v;
  var oldest = bdNow();
  items.forEach(function (it) { var c = itemCreatedMs(it); if (c && c < oldest) oldest = c; });
  fSet('bd-friend-since', String(oldest));
  return oldest;
}
function driftGoal(now) {
  now = now != null ? now : bdNow();
  var p = profile || {};
  if (!p.checkins) return null;
  if (friendLevel() === 'off') return null;
  var muted = p.mutedGoals || [];
  var goals = friendGoals().filter(function (g) { return muted.indexOf(g) < 0; });
  if (!goals.length) return null;
  if (now - friendSinceMs() < 7 * FRIEND_DAY) return null;
  for (var i = 0; i < goals.length; i++) if (now - goalActivityMs(goals[i]) >= 7 * FRIEND_DAY) return goals[i];
  return null;
}
function readCheckin() { try { return JSON.parse(fGet('bd-checkin') || 'null'); } catch (e) { return null; } }
// At most one check-in per 7 days. An unanswered one stays until answered, the goal gets activity, or the week passes.
function pickCheckin(now) {
  now = now != null ? now : bdNow();
  var p = profile || {};
  if (!p.checkins || friendLevel() === 'off') return null;
  var rec = readCheckin();
  if (rec && now - rec.at < 7 * FRIEND_DAY && now >= rec.at) {
    if (rec.done) return null;
    var ok = friendGoals().indexOf(rec.goal) >= 0 && (p.mutedGoals || []).indexOf(rec.goal) < 0 && goalActivityMs(rec.goal) < rec.at;
    return ok ? rec.goal : null;
  }
  var g = driftGoal(now);
  if (g) fSet('bd-checkin', JSON.stringify({ at: now, goal: g, done: false }));
  return g;
}
function finishCheckin() {
  var rec = readCheckin();
  if (rec) { rec.done = true; fSet('bd-checkin', JSON.stringify(rec)); }
}

// ---- Weekly card timing: the first open on/after Sunday 6 PM (or any later day that week) ----
function recapAnchor(now) {
  var s = new Date(now != null ? now : bdNow());
  var n = s.getTime();
  s.setHours(18, 0, 0, 0);
  s.setDate(s.getDate() - s.getDay());
  if (s.getTime() > n) s.setDate(s.getDate() - 7);
  return s;
}
function recapKey(now) { return ymd(recapAnchor(now)); }
function weeklyDue(now) {
  now = now != null ? now : bdNow();
  if (friendLevel() === 'off') return false;
  if (fGet('bd-weekly-seen') === recapKey(now)) return false;
  if (friendSinceMs() > recapAnchor(now).getTime()) return false; // wasn't around before this week closed
  return items.some(function (i) { return !i.deleted; });
}
function weeklyStats(now) {
  now = now != null ? now : bdNow();
  var from = now - 7 * FRIEND_DAY;
  var done = items.filter(function (i) { var d = itemDoneMs(i); return !i.deleted && i.ghosted && d >= from && d <= now; })
    .sort(function (a, b) { return itemDoneMs(b) - itemDoneMs(a); });
  var letGo = items.filter(function (i) { return i.letGo && !i.deleted && (i.letGoAt || 0) >= from; });
  var open = items.filter(function (i) { return !i.deleted && !i.letGo && !i.ghosted; });
  return { done: done, letGo: letGo, open: open };
}
function isFocusItem(it) { return !!(it && it.focusWeek && it.focusWeek === recapKey() && !it.ghosted && !it.deleted && !it.letGo); }

// ---- Item bits (used by render) ----
function whyLineHTML(it) {
  if (!it || (!it.why && !it.whyGoal)) return '';
  var parts = [];
  if (it.why) parts.push('<span class="why-text">' + esc(it.why) + '</span>');
  if (it.whyGoal) parts.push('<span class="why-goal">for ' + esc(goalShort(it.whyGoal)) + '</span>');
  return '<div class="item-why" title="Why this matters">↳ ' + parts.join(' · ') + '</div>';
}
function focusTagHTML(it) { return isFocusItem(it) ? '<span class="focus-tag" title="Focus this week">★</span>' : ''; }
function friendApplyPending(it) {
  if (!it || !pendingWhyGoal) return;
  it.whyGoal = pendingWhyGoal; it.whyAt = bdNow();
  pendingWhyGoal = null;
  renderPendingWhy();
}
function renderPendingWhy() {
  var el = document.getElementById('whyPending');
  if (!el) return;
  if (!pendingWhyGoal) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = '<span>Next item is for <strong>' + esc(goalShort(pendingWhyGoal)) + '</strong></span><button type="button" id="whyPendingX" aria-label="Cancel">✕</button>';
  document.getElementById('whyPendingX').onclick = function () { pendingWhyGoal = null; renderPendingWhy(); };
}

// ---- Why sheet (item ⋯ → Add a why) ----
function openWhySheet(id) {
  closeCatSheet(); closeKindSheet();
  var it = items.find(function (i) { return i.id == id; });
  if (!it || it.deleted || it.letGo) return;
  var goals = friendGoals();
  var pick = it.whyGoal || null;
  var div = document.createElement('div');
  div.className = 'cat-sheet why-sheet';
  var chips = goals.length ? '<div class="why-sub">Ties to one of your goals? (optional)</div><div class="why-chips">' + goals.map(function (g) {
    return '<button type="button" class="ob-chip why-chip ' + (pick === g ? 'on' : '') + '" data-goal="' + obEsc(g) + '" aria-pressed="' + (pick === g) + '">' + obEsc(goalShort(g)) + '</button>';
  }).join('') + '</div>' : '';
  div.innerHTML = '<div class="cat-sheet-title">Why does this one matter?</div>' +
    '<div class="why-item">“' + esc(it.text) + '”</div>' + chips +
    '<input id="whyInput" maxlength="80" placeholder="A few words, like “so mornings are calmer”" value="' + obEsc(it.why || '') + '" autocomplete="off">' +
    '<div class="why-actions"><button type="button" id="whySave">Save</button>' +
    ((it.why || it.whyGoal) ? '<button type="button" class="secondary" id="whyRemove">Remove why</button>' : '') +
    '<button type="button" class="secondary" id="whyCancel">Cancel</button></div>';
  document.body.appendChild(div);
  wireDismiss(div, closeCatSheet);
  div.querySelectorAll('.why-chip').forEach(function (b) {
    b.onclick = function () {
      pick = pick === b.dataset.goal ? null : b.dataset.goal;
      div.querySelectorAll('.why-chip').forEach(function (x) { var on = x.dataset.goal === pick; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    };
  });
  var saveWhy = function () {
    var text = div.querySelector('#whyInput').value.trim().slice(0, 80);
    if (!text && !pick) { delete it.why; delete it.whyGoal; delete it.whyAt; }
    else {
      if (text) it.why = text; else delete it.why;
      if (pick) it.whyGoal = pick; else delete it.whyGoal;
      it.whyAt = bdNow();
    }
    closeCatSheet(); save(); render();
    setStatus(it.why || it.whyGoal ? 'Why saved' : 'Why removed');
  };
  div.querySelector('#whySave').onclick = saveWhy;
  div.querySelector('#whyInput').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); saveWhy(); } };
  var rm = div.querySelector('#whyRemove');
  if (rm) rm.onclick = function () { delete it.why; delete it.whyGoal; delete it.whyAt; closeCatSheet(); save(); render(); setStatus('Why removed'); };
  div.querySelector('#whyCancel').onclick = closeCatSheet;
  try { if (!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)) div.querySelector('#whyInput').focus(); } catch (e) {}
}

// ---- Friend card (one at a time, above the list, never a popup) ----
function hideFriend() { var c = document.getElementById('friendCard'); if (c) { c.style.display = 'none'; c.innerHTML = ''; c.className = ''; } }
function friendCardShell(kind, inner) {
  var c = document.getElementById('friendCard');
  if (!c) return null;
  c.className = 'fc-' + kind;
  c.dataset.kind = kind;
  c.innerHTML = '<button type="button" class="fc-x" aria-label="Dismiss">✕</button>' + inner;
  c.style.display = 'block';
  return c;
}
function showWeekly(opts) {
  opts = opts || {};
  var now = bdNow(), key = recapKey(now), st = weeklyStats(now), n = st.done.length;
  var type = n >= 8 ? 'weeklyBig' : n >= 3 ? 'weeklyMid' : n >= 1 ? 'weeklySmall' : 'weeklyNone';
  var hl = st.done.slice(0, 3).map(function (i) { return '<li>✓ ' + esc(i.text) + '</li>'; }).join('');
  var more = n > 3 ? '<li class="fc-more">+ ' + (n - 3) + ' more</li>' : '';
  var lines = [];
  if (st.letGo.length) lines.push(friendLine('weeklyLetGo', { n: st.letGo.length }, key));
  if (st.open.length) lines.push(friendLine('weeklyOpen', { n: st.open.length }, key));
  var ask = n ? friendLine('weeklyAsk', {}, key) + (friendLevel() === 'stay' ? ' Pick up to 3.' : '') : '';
  var c = friendCardShell('weekly', '<div class="fc-kicker">How’d it go?</div>' +
    '<div class="fc-title">' + friendLine(type, { n: n }, key) + '</div>' +
    (hl ? '<ul class="fc-highlights">' + hl + more + '</ul>' : '') +
    (lines.length ? '<div class="fc-line">' + lines.join(' ') + '</div>' : '') +
    (ask ? '<div class="fc-ask">' + ask + '</div>' : '') +
    '<div class="ob-actions fc-actions"><button type="button" id="fcGood">Looks good</button>' +
    (st.open.length ? '<button type="button" class="secondary" id="fcFocus">Pick 1–3 focus items</button>' : '') +
    '<button type="button" class="secondary" id="fcNotNow">Not now</button></div>');
  if (!c) return;
  var seen = function () { fSet('bd-weekly-seen', key); };
  c.querySelector('#fcGood').onclick = function () { seen(); hideFriend(); fToast(friendLine('weeklyGood', {}, key)); };
  c.querySelector('#fcNotNow').onclick = c.querySelector('.fc-x').onclick = function () { seen(); hideFriend(); fToast(friendLine('weeklyNotNow', {}, key)); };
  var f = c.querySelector('#fcFocus');
  if (f) f.onclick = function () { showFocusPicker(key); };
  if (opts.scroll) try { c.scrollIntoView({ block: 'center' }); } catch (e) {}
}
function showFocusPicker(key) {
  var open = weeklyStats().open.slice().sort(function (a, b) {
    var fa = isFocusItem(a) ? 0 : 1, fb = isFocusItem(b) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    var da = a.due ? Date.parse(a.due) : Infinity, db = b.due ? Date.parse(b.due) : Infinity;
    if (da !== db) return da - db;
    return itemCreatedMs(b) - itemCreatedMs(a);
  }).slice(0, 10);
  var picked = open.filter(isFocusItem).map(function (i) { return String(i.id); }).slice(0, 3);
  var c = friendCardShell('weekly', '<div class="fc-kicker">This week’s focus</div>' +
    '<div class="fc-title">Pick up to 3. Just the ones that matter most.</div>' +
    '<div class="fc-pick">' + open.map(function (i) {
      var on = picked.indexOf(String(i.id)) >= 0;
      return '<button type="button" class="ob-chip fc-chip ' + (on ? 'on' : '') + '" data-id="' + i.id + '" aria-pressed="' + on + '">' + esc(i.text) + '</button>';
    }).join('') + '</div>' +
    '<div class="ob-actions fc-actions"><button type="button" id="fcFocusSave">Save focus</button><button type="button" class="secondary" id="fcFocusBack">Back</button></div>');
  if (!c) return;
  c.querySelectorAll('.fc-chip').forEach(function (b) {
    b.onclick = function () {
      var id = b.dataset.id, i = picked.indexOf(id);
      if (i >= 0) picked.splice(i, 1);
      else { if (picked.length >= 3) { setStatus('Three is plenty. Unstar one first.'); return; } picked.push(id); }
      c.querySelectorAll('.fc-chip').forEach(function (x) { var on = picked.indexOf(x.dataset.id) >= 0; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); });
    };
  });
  c.querySelector('#fcFocusBack').onclick = function () { showWeekly(); };
  c.querySelector('.fc-x').onclick = function () { fSet('bd-weekly-seen', key); hideFriend(); };
  c.querySelector('#fcFocusSave').onclick = function () {
    items.forEach(function (it) {
      if (picked.indexOf(String(it.id)) >= 0) it.focusWeek = key;
      else if (it.focusWeek === key) delete it.focusWeek;
    });
    fSet('bd-weekly-seen', key);
    save(); render(); hideFriend();
    if (picked.length) fToast(friendLine('weeklyFocus', { n: picked.length }, key));
    else fToast(friendLine('weeklyGood', {}, key));
  };
}
function showCheckin(goal, opts) {
  opts = opts || {};
  var seed = recapKey() + goal;
  var c = friendCardShell('checkin', '<div class="fc-kicker">' + friendLine('driftTitle', {}, seed) + '</div>' +
    '<div class="fc-msg">' + friendLine('drift', { said: goalSaid(goal), missing: goalMissing(goal) }, seed) + friendTail(seed) + '</div>' +
    '<div class="ob-actions fc-actions fc-stack"><button type="button" id="fcAddFor">Add something for it</button>' +
    '<button type="button" class="secondary" id="fcMute">I just don’t log that</button>' +
    '<button type="button" class="secondary" id="fcGoals">Change my goals</button></div>');
  if (!c) return;
  var done = function () { if (!opts.preview) finishCheckin(); hideFriend(); };
  c.querySelector('.fc-x').onclick = done;
  c.querySelector('#fcAddFor').onclick = function () {
    done();
    pendingWhyGoal = goal; renderPendingWhy();
    fToast(friendLine('addFor', { goal: goalShort(goal) }, seed));
    try { itemInput.focus(); itemInput.scrollIntoView({ block: 'center' }); } catch (e) {}
  };
  c.querySelector('#fcMute').onclick = function () {
    done();
    if (opts.preview) { fToast('Preview: this would stop check-ins about ' + goalShort(goal) + '.'); return; }
    profile = profile || {};
    profile.mutedGoals = (profile.mutedGoals || []).filter(function (g) { return g !== goal; }).concat([goal]);
    saveProfile(profile);
    fToast(friendLine('mute', { said: goalSaid(goal) }, seed), function () { unmuteGoal(goal); });
  };
  c.querySelector('#fcGoals').onclick = function () { done(); openSettings(); try { document.getElementById('settings').scrollIntoView({ block: 'start' }); } catch (e) {} };
  if (opts.scroll) try { c.scrollIntoView({ block: 'center' }); } catch (e) {}
}
function unmuteGoal(goal) {
  if (!profile) return;
  profile.mutedGoals = (profile.mutedGoals || []).filter(function (g) { return g !== goal; });
  saveProfile(profile);
}
function biggerDue(now) {
  now = now != null ? now : bdNow();
  if (!profile || profile.setupDone === undefined && !profile.skipped) return false;
  if (friendGoals().length) return false;
  if (fGet('bd-bigger-done')) return false;
  if (friendLevel() === 'off') return false;
  return now - friendSinceMs() >= 7 * FRIEND_DAY;
}
function showBigger(opts) {
  opts = opts || {};
  var seed = 'bigger';
  var c = friendCardShell('bigger', '<div class="fc-kicker">Something bigger?</div>' +
    '<div class="fc-title">' + friendLine('biggerTitle', {}, seed) + '</div>' +
    '<div class="fc-msg">' + friendLine('biggerBody', {}, seed) + '</div>' +
    '<div class="ob-field fc-field"><input id="fcBiggerInput" maxlength="80" placeholder="e.g. read more, get the business steady" autocomplete="off"></div>' +
    '<div class="ob-actions fc-actions"><button type="button" id="fcBiggerSave">Keep me on track</button><button type="button" class="secondary" id="fcBiggerNo">Not now</button></div>');
  if (!c) return;
  var close = function () { if (!opts.preview) fSet('bd-bigger-done', '1'); hideFriend(); };
  var no = function () { close(); fToast(friendLine('biggerNotNow', {}, seed)); };
  c.querySelector('.fc-x').onclick = no;
  c.querySelector('#fcBiggerNo').onclick = no;
  var saveB = function () {
    var v = c.querySelector('#fcBiggerInput').value.trim();
    if (!v) { c.querySelector('#fcBiggerInput').focus(); return; }
    close();
    if (opts.preview) { fToast('Preview: this would save “' + v + '” as your goal.'); return; }
    var chip = BECOME_CHOICES.find(function (b) { return b.toLowerCase() === v.toLowerCase(); });
    profile = Object.assign({}, profile || {}, chip ? { become: [chip] } : { becomeText: v }, { checkins: true });
    saveProfile(profile); renderWhy();
    fToast(friendLine('biggerSaved', {}, seed));
  };
  c.querySelector('#fcBiggerSave').onclick = saveB;
  c.querySelector('#fcBiggerInput').onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); saveB(); } };
  if (opts.scroll) try { c.scrollIntoView({ block: 'center' }); } catch (e) {}
}
var friendPreviewNoted = false;
function maybeShowFriend() {
  hideFriend();
  var w = document.getElementById('welcome');
  if (w && w.style.display === 'block') return;
  var now = bdNow();
  if (friendPreviewMode() && !friendPreviewNoted) {
    friendPreviewNoted = true;
    try { setStatus('Preview date: ' + new Date(now).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' (timing isn’t saved)'); } catch (e) {}
  }
  friendSinceMs();
  if (weeklyDue(now)) { showWeekly(); return; }
  var g = pickCheckin(now);
  if (g) { showCheckin(g); return; }
  if (biggerDue(now)) showBigger();
}

// ---- Personality picker (onboarding + Settings) ----
function voiceStyleHTML(name) {
  var cur = voiceStyle();
  return '<div class="vs-styles" role="radiogroup">' + VOICE_STYLES.map(function (v) {
    return '<label class="vs-style ' + (cur === v.id ? 'on' : '') + '"><input type="radio" name="' + name + '" value="' + v.id + '" ' + (cur === v.id ? 'checked' : '') + '>' +
      '<span class="vs-name">' + v.name + '</span><span class="vs-desc">' + v.desc + '</span></label>';
  }).join('') + '</div><div class="vs-sample" aria-live="polite"></div>' +
    '<label class="vs-cuss" hidden><input type="checkbox" class="vs-cuss-box"> <span>Allow cussing</span> <span class="set-note">(mild stuff, off by default)</span></label>';
}
function wireVoiceStyle(root) {
  var sample = root.querySelector('.vs-sample'), cussLbl = root.querySelector('.vs-cuss'), box = root.querySelector('.vs-cuss-box');
  var update = function () {
    var s = voiceStyle();
    root.querySelectorAll('.vs-style').forEach(function (l) { l.classList.toggle('on', l.querySelector('input').value === s); });
    if (cussLbl) cussLbl.hidden = !cussAllowed(s);
    if (box) try { box.checked = localStorage.getItem('bd-voice-cuss') === '1'; } catch (e) {}
    if (sample) sample.innerHTML = '“' + friendLine('sample', {}, 'sample') + '”';
  };
  root.querySelectorAll('.vs-style input').forEach(function (inp) {
    inp.onchange = function () { setVoiceStyle(inp.value); update(); };
  });
  if (box) box.onchange = function () { try { localStorage.setItem('bd-voice-cuss', box.checked ? '1' : '0'); } catch (e) {} update(); };
  update();
}
function friendSettingsHTML(p) {
  var muted = (p.mutedGoals || []).filter(function (g) { return friendGoals().indexOf(g) >= 0 || true; });
  var goals = friendGoalsOf(p);
  return '<div class="set-label">How I talk to you</div>' + voiceStyleHTML('setVoice') +
    '<div class="fc-prev"><button type="button" class="secondary" id="setCompare">Compare personalities</button></div>' +
    '<div class="set-label">Goal check-ins</div>' +
    '<label class="fc-toggle"><input type="checkbox" id="setCheckins" ' + (p.checkins ? 'checked' : '') + '> <span>Let me point out when things drift from your goals</span></label>' +
    '<div class="set-note fc-note">Off unless you turn it on. At most once a week, always a question.' + (goals.length ? '' : ' Add a goal above first.') + ((p.nudge || 'light') === 'off' ? ' Paused while nudges are Off.' : '') + '</div>' +
    (muted.length ? '<div class="fc-muted">' + muted.map(function (g) {
      return '<div class="fc-muted-row"><span>Not asking about ' + obEsc(goalShort(g)) + '</span><button type="button" class="secondary fc-unmute" data-goal="' + obEsc(g) + '">Ask again</button></div>';
    }).join('') + '</div>' : '') +
    '<div class="set-label">Weekly recap</div>' +
    '<div class="fc-prev"><button type="button" class="secondary" id="setShowWeekly">See this week’s recap</button>' +
    '<button type="button" class="secondary" id="setPrevCheckin">Preview a check-in</button>' +
    '<button type="button" class="secondary" id="setPrevBigger">Preview the “something bigger” card</button></div>';
}
function wireFriendSettings(panel) {
  wireVoiceStyle(panel);
  var cmp = panel.querySelector('#setCompare');
  if (cmp) cmp.onclick = function () { closeSettings(); openCompare({ scroll: true }); };
  panel.querySelectorAll('.fc-unmute').forEach(function (b) {
    b.onclick = function () { unmuteGoal(b.dataset.goal); var row = b.closest('.fc-muted-row'); if (row) row.remove(); setStatus('I’ll check in about that again'); };
  });
  var showAfter = function (fn) { closeSettings(); fn(); };
  panel.querySelector('#setShowWeekly').onclick = function () { showAfter(function () { showWeekly({ scroll: true }); }); };
  panel.querySelector('#setPrevCheckin').onclick = function () {
    showAfter(function () { var g = friendGoals()[0] || 'Always learning'; showCheckin(g, { preview: true, scroll: true }); });
  };
  panel.querySelector('#setPrevBigger').onclick = function () { showAfter(function () { showBigger({ preview: true, scroll: true }); }); };
}
// Every line of copy for one style, for review and the clean-language check.
function friendAllLines(style, cuss) {
  var out = [];
  Object.keys(FRIEND_COPY[style] || {}).forEach(function (t) { if (t !== 'cuss') friendPool(t, style, cuss).forEach(function (l) { out.push(l); }); });
  return out;
}
try { window.__friend = { maybeShowFriend: maybeShowFriend, showWeekly: showWeekly, showCheckin: showCheckin, showBigger: showBigger, driftGoal: driftGoal, weeklyDue: weeklyDue, recapKey: recapKey, goalActivityMs: goalActivityMs, friendLine: friendLine, allLines: friendAllLines, copy: function () { return FRIEND_COPY; }, pending: function () { return pendingWhyGoal; } }; } catch (e) {}
// ===== end Friend features =====
// ===== Compare personalities (2026-11-19) =====
// One app, four voices: type or say something in the normal dump box, it's added to your list ONCE,
// and each panel shows how Gentle / Warm / Drill Sergeant / Real would react. Panels are previews only:
// they read FRIEND_COPY through friendLineAs(), so every copy or logic edit shows up in all four.
// Open from Settings → Compare personalities, or with ?compare=1 in the link.
var compareState = null;
function compareIsOpen() { var el = document.getElementById('compareView'); return !!(el && !el.hidden); }
function compareTarget() {
  if (!compareState) return null;
  var it = compareState.itemId != null ? items.find(function (i) { return String(i.id) === String(compareState.itemId) && !i.deleted; }) : null;
  if (it) return it;
  // Nothing added yet while open: react to the newest open item on the list, if any.
  var open = items.filter(function (i) { return !i.deleted && !i.ghosted && !i.letGo; })
    .sort(function (a, b) { return itemCreatedMs(b) - itemCreatedMs(a); });
  return open[0] || null;
}
function compareTail(style, cuss, seed) {
  var l = friendLevel();
  if (l === 'light') return ' ' + friendLineAs(style, cuss, 'tailLight', {}, seed);
  if (l === 'stay') return ' ' + friendLineAs(style, cuss, 'tailStay', {}, seed);
  return '';
}
// Everything one personality would say right now (used by the panels and by the checks).
function compareLines(style, cuss, it) {
  var L = function (type, params, seed) { return friendLineAs(style, cuss, type, params, seed); };
  var out = {};
  if (it) {
    var seed = String(it.id);
    out.addAck = L('addAck', { item: it.text }, seed);
    out.nudgeItem = L('nudgeItem', { item: it.text }, seed);
    out.firstStep = L('firstStep', { item: it.text }, seed);
  }
  var now = bdNow(), key = recapKey(now), st = weeklyStats(now), n = st.done.length;
  var wType = n >= 8 ? 'weeklyBig' : n >= 3 ? 'weeklyMid' : n >= 1 ? 'weeklySmall' : 'weeklyNone';
  out.weeklyTitle = L(wType, { n: n }, key);
  var wl = [];
  if (st.letGo.length) wl.push(L('weeklyLetGo', { n: st.letGo.length }, key));
  if (st.open.length) wl.push(L('weeklyOpen', { n: st.open.length }, key));
  if (n) wl.push(L('weeklyAsk', {}, key));
  out.weeklyMore = wl.join(' ');
  var today = ymd(new Date(now));
  var dueNow = items.filter(function (i) { return !i.deleted && !i.ghosted && i.due && dayDiff(i.due, new Date(now)) <= 0; });
  var w = whyText(profile);
  out.checkinTitle = L('nudgeTitle', {}, today);
  var msg, clear = false;
  if (dueNow.length === 1) msg = L('nudgeDueOne', { item: dueNow[0].text }, today);
  else if (dueNow.length > 1) msg = L('nudgeDueMany', { n: dueNow.length }, today);
  else if (st.open.length) msg = w ? L('nudgeOpenWhy', { why: w, n: st.open.length }, today) : L('nudgeOpen', { n: st.open.length }, today);
  else { msg = L('nudgeClear', {}, today); clear = true; }
  out.checkin = msg + (clear ? '' : compareTail(style, cuss, today));
  return out;
}
function comparePanelHTML(v, it, using) {
  var cuss = !!(compareState.cuss[v.id]) && cussAllowed(v.id);
  var x = compareLines(v.id, cuss, it);
  var waiting = '<span class="cmp-wait">Type or say something above.</span>';
  var blk = function (kicker, kind, html) { return '<div class="cmp-block"><div class="cmp-kicker">' + kicker + '</div><div class="cmp-line" data-kind="' + kind + '">' + html + '</div></div>'; };
  return '<article class="cmp-panel' + (using ? ' cmp-using' : '') + '" data-style="' + v.id + '" id="cmp-' + v.id + '">' +
    '<header class="cmp-head"><div class="cmp-name">' + v.name + '</div><div class="cmp-desc">' + v.desc + '</div>' +
    (using ? '<span class="cmp-badge">In use</span>' : '') + '</header>' +
    (cussAllowed(v.id) ? '<label class="cmp-cuss"><input type="checkbox" class="cmp-cuss-box" data-style="' + v.id + '"' + (cuss ? ' checked' : '') + '> <span>Cussing</span></label>' : '<div class="cmp-cuss cmp-clean">Always clean</div>') +
    blk('When you add it', 'addAck', it ? x.addAck : waiting) +
    blk('Nudge about it', 'nudgeItem', it ? x.nudgeItem : waiting) +
    blk('First step / not sure', 'firstStep', it ? x.firstStep : waiting) +
    '<div class="cmp-block cmp-card" data-kind="weekly"><div class="cmp-kicker">Weekly card · How’d it go?</div><div class="cmp-title">' + x.weeklyTitle + '</div>' +
      (x.weeklyMore ? '<div class="cmp-more">' + x.weeklyMore + '</div>' : '') + '</div>' +
    '<div class="cmp-block cmp-card" data-kind="checkin"><div class="cmp-kicker">Check-in · ' + x.checkinTitle + '</div><div class="cmp-line">' + x.checkin + '</div></div>' +
    '<button type="button" class="secondary cmp-use" data-style="' + v.id + '"' + (using ? ' disabled' : '') + '>' + (using ? '✓ Using ' + v.name : 'Use ' + v.name) + '</button>' +
    '</article>';
}
function renderCompare() {
  var el = document.getElementById('compareView');
  if (!el || !compareState) return;
  var it = compareTarget();
  var cur = voiceStyle();
  var keepScroll = el.querySelector('.cmp-grid') ? el.querySelector('.cmp-grid').scrollLeft : 0;
  el.innerHTML = '<div class="cmp-wrap">' +
    '<div class="cmp-top"><div><div class="cmp-h">Compare personalities</div>' +
    '<div class="cmp-note">Type or say something in the box above. It goes on your list once, and all four show how they’d react. Previews only.</div></div>' +
    '<button type="button" class="secondary cmp-x" id="cmpClose" aria-label="Close compare">✕</button></div>' +
    '<div class="cmp-target">' + (it ? 'Reacting to: <strong>' + esc(it.text) + '</strong>' : 'Nothing on the list yet.') + '</div>' +
    '<div class="cmp-tabs" role="tablist">' + VOICE_STYLES.map(function (v) { return '<button type="button" class="cmp-tab' + (v.id === compareState.tab ? ' on' : '') + '" data-style="' + v.id + '">' + v.name.replace('Drill Sergeant', 'Drill') + '</button>'; }).join('') + '</div>' +
    '<div class="cmp-grid">' + VOICE_STYLES.map(function (v) { return comparePanelHTML(v, it, v.id === cur); }).join('') + '</div></div>';
  var grid = el.querySelector('.cmp-grid');
  grid.scrollLeft = keepScroll;
  el.querySelector('#cmpClose').onclick = closeCompare;
  el.querySelectorAll('.cmp-cuss-box').forEach(function (b) {
    b.onchange = function () { compareState.cuss[b.dataset.style] = b.checked; renderCompare(); };
  });
  el.querySelectorAll('.cmp-use').forEach(function (b) {
    b.onclick = function () {
      var s = b.dataset.style;
      setVoiceStyle(s);
      if (cussAllowed(s)) try { localStorage.setItem('bd-voice-cuss', compareState.cuss[s] ? '1' : '0'); } catch (e) {}
      renderCompare(); maybeShowNudge();
      var v = VOICE_STYLES.find(function (x) { return x.id === s; });
      setStatus('Your friend is now ' + (v ? v.name : s) + '.');
    };
  });
  el.querySelectorAll('.cmp-tab').forEach(function (t) {
    t.onclick = function () {
      compareState.tab = t.dataset.style;
      var p = el.querySelector('#cmp-' + t.dataset.style);
      if (p) grid.scrollTo({ left: p.offsetLeft - grid.offsetLeft - 4, behavior: 'smooth' });
      el.querySelectorAll('.cmp-tab').forEach(function (x) { x.classList.toggle('on', x === t); });
    };
  });
  grid.onscroll = function () {
    var best = null, bd = Infinity;
    grid.querySelectorAll('.cmp-panel').forEach(function (p) { var d = Math.abs(p.offsetLeft - grid.offsetLeft - grid.scrollLeft); if (d < bd) { bd = d; best = p; } });
    if (best && best.dataset.style !== compareState.tab) {
      compareState.tab = best.dataset.style;
      el.querySelectorAll('.cmp-tab').forEach(function (x) { x.classList.toggle('on', x.dataset.style === compareState.tab); });
    }
  };
}
function openCompare(opts) {
  opts = opts || {};
  var el = document.getElementById('compareView');
  if (!el) return;
  if (!compareState) compareState = { itemId: null, cuss: { drill: false, real: false }, tab: 'gentle' };
  el.hidden = false;
  renderCompare();
  if (opts.scroll) try { el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
}
function closeCompare() {
  var el = document.getElementById('compareView');
  if (el) { el.hidden = true; el.innerHTML = ''; }
}
window.__bdCompareOnAdd = function (it) {
  if (!compareState || !compareIsOpen()) return;
  compareState.itemId = it.id;
  renderCompare();
};
try { window.__bdCompare = { open: openCompare, close: closeCompare, render: renderCompare, lines: compareLines, isOpen: compareIsOpen, state: function () { return compareState; } }; } catch (e) {}
if (/[?&]compare=1(?:&|$)/.test(location.search || '')) setTimeout(function () { openCompare(); }, 0);
// ===== end Compare personalities =====

// ===== end PREVIEW =====

function attrName(name) { return String(name || '').replace(/"/g, ''); }
function kidsAnchoredTo(parentName, itemId) {
  return childrenOf(parentName).filter(c => c.afterItem != null && String(c.afterItem) === String(itemId));
}
function trailingKids(parentName, itemIds) {
  const ids = new Set((itemIds || []).map(String));
  return childrenOf(parentName).filter(c => c.afterItem == null || !ids.has(String(c.afterItem)));
}
function cleanupAfterItem() {
  categories.forEach(c => {
    if (c.afterItem == null) return;
    const it = items.find(i => String(i.id) === String(c.afterItem) && !i.deleted);
    if (!it || (it.category || '') !== (c.parent || '')) delete c.afterItem;
  });
}

let workingItemId = null;
let revealing = false;
let itemWasDragged = false;
let catWasDragged = false;
let catDragName = null;

function clearDropMarks() {
  document.querySelectorAll('.nb-drop-before, .nb-drop-after, .nb-dragging').forEach(el => {
    el.classList.remove('nb-drop-before', 'nb-drop-after', 'nb-dragging');
  });
}
function dropAfter(el, ev) {
  if (!el || !ev || typeof ev.clientY !== 'number' || !ev.clientY) return false;
  const r = el.getBoundingClientRect();
  return ev.clientY > r.top + r.height / 2;
}
function isReorderableHeader(el) {
  if (!el || !el.classList || !el.classList.contains('group-header')) return false;
  const page = document.documentElement.getAttribute('data-nb-page');
  if (page && page !== 'front') return false;
  const name = el.dataset.cat;
  if (el.dataset.depth && el.dataset.depth !== '1') return false;
  if (!name || ['Finished', 'Recently Deleted', 'Let go', 'Uncategorized', 'Unsorted'].includes(name) || isUnsortedName(name)) return false;
  return !!findCat(name) && !parentOf(name);
}
function parseDragPayload(raw) {
  raw = raw == null ? '' : String(raw);
  if (raw.slice(0, 4) === 'cat:') return { kind: 'cat', name: raw.slice(4) };
  if (raw) return { kind: 'item', id: raw };
  return null;
}
function reorderTopCats(moved, overName, after) {
  if (!moved || !findCat(moved) || parentOf(moved)) return false;
  const tops = topCatNames().filter(n => n !== moved);
  let i = overName ? tops.indexOf(overName) : tops.length;
  if (i < 0) i = tops.length;
  if (after) i += 1;
  tops.splice(i, 0, moved);
  applyTopCatOrder(tops);
  save();
  render();
  return true;
}
function placeItemAt(id, overId, after, zoneCat) {
  const it = items.find(i => String(i.id) === String(id));
  if (!it || it.deleted || it.letGo) return false;
  let target = overId != null ? items.find(i => String(i.id) === String(overId)) : null;
  if (target && String(target.id) === String(it.id)) target = null;
  if (zoneCat === 'Recently Deleted' || zoneCat === 'Let go') return false;
  if (zoneCat !== 'Finished') {
    let dest = zoneCat;
    if (dest === 'Uncategorized') dest = '';
    else if ((dest == null || dest === '') && target) dest = target.category || '';
    else if (dest == null) dest = it.category || '';
    it.category = dest || '';
    it.color = getColor(it.category);
    it.ghosted = false;
    it.finishedAt = null;
  } else {
    it.category = '';
    it.color = getColor('');
  }
  if (target && !!it.ghosted === !!target.ghosted) {
    const from = items.indexOf(it);
    if (from >= 0) items.splice(from, 1);
    let to = items.indexOf(target);
    if (to < 0) items.unshift(it);
    else items.splice(after ? to + 1 : to, 0, it);
  }
  save();
  render();
  return true;
}

function updateAddingTo() {
  const el = $('addingTo');
  if (!el) return;
  el.hidden = false;
  const name = currentCat || 'No category';
  el.textContent = 'Adding to: ' + name;
  el.setAttribute('aria-label', 'Adding to ' + name + '. Tap to clear or change.');
  el.title = 'Tap to clear, or use the dropdown to change';
}

function markWorkingSpot(opts) {
  opts = opts || {};
  if (workingItemId != null) {
    const it = items.find(i => String(i.id) === String(workingItemId) && !i.deleted && !i.ghosted);
    if (!it) workingItemId = null;
  }
  document.querySelectorAll('.working').forEach(el => el.classList.remove('working'));
  if (!workingItemId) {
    document.querySelectorAll('.item-add-sub').forEach(el => el.remove());
  }
  document.querySelectorAll('.group-header').forEach(h => {
    h.classList.toggle('current', !!(currentCat && h.dataset.cat === currentCat));
  });
  if (workingItemId && !selectMode) {
    const item = document.querySelector('.item[data-id="' + workingItemId + '"]');
    if (item) {
      item.classList.add('working');
      if (opts.scroll !== false) {
        try { item.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: opts.smooth ? 'smooth' : 'auto' }); } catch (e) {}
      }
    }
  } else if (currentCat) {
    const safe = attrName(currentCat);
    const h = document.querySelector('.group-header[data-cat="' + safe + '"]');
    const g = document.querySelector('.group-items[data-for="' + safe + '"]');
    if (h) h.classList.add('current', 'working');
    if (g) g.classList.add('working');
    if (opts.scroll !== false && h) {
      try { h.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: opts.smooth ? 'smooth' : 'auto' }); } catch (e) {}
    }
  }
  updateAddingTo();
}

function revealCurrentCat(opts) {
  opts = opts || {};
  let changed = false;
  if (currentCat) {
    [...ancestorsOf(currentCat).slice().reverse(), currentCat].forEach(n => {
      if (collapsed[n]) { collapsed[n] = false; changed = true; }
    });
  }
  if (changed && !revealing) {
    revealing = true;
    save();
    render();
    revealing = false;
  }
  markWorkingSpot(opts);
}

function setWorkingFromCat(cat) {
  workingItemId = null;
  currentCat = (!cat || cat === 'Uncategorized') ? '' : cat;
  save();
  updateSelect();
  markWorkingSpot({ scroll: true });
  setStatus(currentCat ? ('Adding to ' + currentCat) : 'Adding to No category');
}

function setWorkingFromItem(it) {
  if (!it || it.deleted || it.ghosted || it.letGo) return;
  if (workingItemId != null && String(workingItemId) === String(it.id)) {
    workingItemId = null;
  } else {
    workingItemId = it.id;
    currentCat = it.category || '';
  }
  save();
  render();
  revealCurrentCat({ scroll: true });
  setStatus(currentCat ? ('Adding to ' + currentCat) : 'Adding to No category');
}

function clearWorkingSpot() {
  workingItemId = null;
  currentCat = '';
  save();
  updateSelect();
  markWorkingSpot({ scroll: false });
  setStatus('');
}

// ---- Drag-to-nest: hold over an item ~1s while dragging, drop = that item becomes a sub-category ----
const NEST_HOLD_MS = 900;
let nestDragId = null, nestTargetId = null, nestTimer = null, nestReady = false;
function cancelNest() {
  if (nestTimer) { clearTimeout(nestTimer); nestTimer = null; }
  nestTargetId = null; nestReady = false;
  document.querySelectorAll('.item.nest-pending, .item.nest-target').forEach(el => el.classList.remove('nest-pending', 'nest-target'));
}
// Can item `tid` become a sub-category holding dragged item `did`? Returns { target, parent } or null.
function nestEligible(tid, did) {
  if (tid == null || did == null || String(tid) === String(did)) return null;
  const t = items.find(i => String(i.id) === String(tid));
  const d = items.find(i => String(i.id) === String(did));
  if (!t || !d || t.deleted || t.letGo || t.ghosted || d.deleted || d.letGo) return null;
  if (!subNameFromText(t.text)) return null;
  const parent = (t.category && findCat(t.category)) ? t.category : '';
  if (parent && depthOf(parent) >= MAX_DEPTH) return null; // would be more than 3 levels deep
  return { target: t, dragged: d, parent };
}
function subNameFromText(text) {
  let n = String(text || '').replace(/[›>]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[\s.,!?…]+$/g, '').trim();
  if (n.length > 60) n = n.slice(0, 60).trim();
  return n;
}
function uniqueCatName(base) {
  if (!findCatCI(base) && base.toLowerCase() !== 'uncategorized') return base;
  let k = 2;
  while (findCatCI(base + ' ' + k)) k++;
  return base + ' ' + k;
}
function trackNestHover(e) {
  if (nestDragId == null) return;
  const el = e.target && e.target.closest ? e.target.closest('.item[data-id]') : null;
  const zoneFor = el && el.closest('.group-items') ? el.closest('.group-items').dataset.for : '';
  const ok = el && zoneFor !== 'Finished' && zoneFor !== 'Recently Deleted' && zoneFor !== 'Let go' && nestEligible(el.dataset.id, nestDragId);
  if (!ok) { if (nestTargetId != null) cancelNest(); return; }
  if (String(nestTargetId) === String(el.dataset.id)) return; // still holding over the same item
  cancelNest();
  nestTargetId = el.dataset.id;
  el.classList.add('nest-pending');
  nestTimer = setTimeout(() => {
    nestTimer = null;
    const live = document.querySelector('.item.nest-pending[data-id="' + nestTargetId + '"]');
    if (!live) { cancelNest(); return; }
    nestReady = true;
    live.classList.remove('nest-pending');
    live.classList.add('nest-target');
    const z = live.closest('.group-items'); if (z) z.style.background = '';
  }, NEST_HOLD_MS);
}
// Turn item `tid` into a sub-category (same spot, same parent) and put item `did` inside it.
function makeSubFromItem(tid, did) {
  const ok = nestEligible(tid, did);
  if (!ok) return false;
  const t = ok.target, d = ok.dragged, parent = ok.parent;
  const name = uniqueCatName(subNameFromText(t.text));
  const tIndex = items.indexOf(t);
  const before = { d: { category: d.category, color: d.color, ghosted: d.ghosted, finishedAt: d.finishedAt }, kids: [] };
  // Sit where the item was: anchor to the item just above it in its group (or the group's end if it was first).
  let anchor = null;
  if (parent) {
    const groupItems = items.filter(i => !i.deleted && !i.letGo && (i.category || '') === parent);
    groupItems.sort((a, b) => (a.ghosted ? 1 : 0) - (b.ghosted ? 1 : 0));
    const pos = groupItems.indexOf(t);
    for (let k = pos - 1; k >= 0; k--) { if (groupItems[k] !== d) { anchor = groupItems[k].id; break; } }
  }
  const color = parent ? (findCat(parent).color || PALETTE[0]) : ((t.color && t.color !== '#ffffff' && t.color !== '#1e1e28') ? t.color : PALETTE[categories.length % PALETTE.length]);
  const cat = { name, color };
  if (parent) cat.parent = parent;
  if (anchor != null) cat.afterItem = anchor;
  // Subcategories that were tucked under the old item keep their spot (they follow the new sub-category's anchor).
  categories.forEach(c => {
    if (c.afterItem != null && String(c.afterItem) === String(t.id)) {
      before.kids.push({ name: c.name, afterItem: c.afterItem });
      if (anchor != null) c.afterItem = anchor; else delete c.afterItem;
    }
  });
  categories.push(cat);
  items.splice(tIndex, 1);
  d.category = name;
  d.color = color;
  d.ghosted = false;
  d.finishedAt = null;
  if (workingItemId != null && (String(workingItemId) === String(t.id))) workingItemId = null;
  if (collapsed[name]) collapsed[name] = false;
  if (parent && collapsed[parent]) collapsed[parent] = false;
  save();
  render();
  showVoiceToast('Made ' + shortQuote(name) + ' a sub-category', () => undoMakeSub(name, t, tIndex, d.id, before));
  return true;
}
function undoMakeSub(name, t, tIndex, did, before) {
  const cat = findCat(name);
  if (!cat) return;
  categories = categories.filter(c => c !== cat);
  // Anything put into the new sub-category since goes back where the old item was.
  const back = cat.parent || '';
  items.forEach(i => { if (i.category === name && String(i.id) !== String(did)) { i.category = back; i.color = back ? getColor(back) : '#ffffff'; } });
  categories.forEach(c => { if (c.parent === name) { if (back) c.parent = back; else delete c.parent; } });
  const d = items.find(i => String(i.id) === String(did));
  if (d && d.category === name) Object.assign(d, before.d);
  if (!items.includes(t)) items.splice(Math.min(tIndex, items.length), 0, t);
  before.kids.forEach(k => { const c = findCat(k.name); if (c) c.afterItem = k.afterItem; });
  if (currentCat === name) currentCat = back;
  delete collapsed[name];
  save();
  render();
}

function render() {
  if (addedCatDest !== undefined && currentCat !== addedCatDest) {
    addedCatDest = undefined;
    if (/New items will (still go to|go uncategorized)/.test(micStatus.textContent || '')) setStatus('');
  }
  updateSelect();
  cleanupAfterItem();
  const allVisible = items.filter(i => !i.deleted && !i.letGo);
  const q = (searchQuery || '').trim().toLowerCase();
  const visible = q ? allVisible.filter(i => matchesSearch(i, q)) : allVisible;
  const deletedItems = q ? items.filter(i => i.deleted && matchesSearch(i, q)) : items.filter(i => i.deleted);
  const letGoItems = q ? items.filter(i => i.letGo && !i.deleted && matchesSearch(i, q)) : items.filter(i => i.letGo && !i.deleted);
  const sc = $('searchCount'), sx = $('searchClear');
  if (sc) sc.textContent = (q && visible.length) ? (visible.length + ' found') : '';
  if (sx) sx.style.display = q ? 'inline-block' : 'none';
  if (q && !visible.length && !deletedItems.length && !letGoItems.length) {
    listEl.innerHTML = '<div class="empty">' + uiCopy('emptySearch', { q: searchQuery.trim() }, 'Nothing in here matches “' + esc(searchQuery.trim()) + '”.') + '</div>';
    toolbar.style.display = 'none';
    return;
  }
  if (!allVisible.length && !categories.length && !deletedItems.length && !letGoItems.length) {
    listEl.innerHTML = emptyHTML();
    toolbar.style.display = 'none';
    return;
  }
  toolbar.style.display = (selectMode && items.some(i => i.selected)) ? 'flex' : 'none';

  const groups = {};
  categories.forEach(c => groups[c.name] = []);
  groups['Uncategorized'] = [];
  visible.forEach(it => {
    const k = it.category || 'Uncategorized';
    if (!groups[k]) groups[k] = [];
    groups[k].push(it);
  });

  const shouldShowCat = name => {
    const arr = groups[name] || [];
    if (q && !arr.length && !(findCat(name) && descendantsOf(name).some(d => (groups[d] || []).length))) return false;
    return true;
  };

  const decidingUnsure = (!selectMode && !q) ? nextUnsureDecide() : null;

  function itemHTML(it) {
    const due = dueTagHTML(it);
    const fin = it.finishedAt ? `<span class="meta" style="color:#166534;background:rgba(255,255,255,0.85);padding:1px 5px;border-radius:4px;">done ${formatFinishedAt(it.finishedAt)}</span>` : '';
    const yet = (it.notYet && !it.ghosted) ? `<span class="not-yet-tag">not yet</span>` : '';
    const ask = (it.unsure && !it.ghosted) ? `<span class="unsure-tag" title="Not sure yet">?</span>` : '';
    const parent = it.category || '';
    const isSpot = !selectMode && !q && workingItemId != null && String(workingItemId) === String(it.id) && !it.ghosted && !it.deleted && !it.letGo;
    const canSub = isSpot && parent && findCat(parent) && depthOf(parent) < MAX_DEPTH;
    const subBtn = canSub ? `<button type="button" class="item-add-sub" data-id="${it.id}">+ sub</button>` : '';
    const isDecide = !!(decidingUnsure && String(decidingUnsure.id) === String(it.id));
    const showHint = !isDecide && !it.ghosted && !selectMode && (it.notDoneCount || 0) >= 3 && nudgeFollowsUp();
    const hint = showHint ? `<button type="button" class="slide-hint" data-id="${it.id}">This keeps sliding. Still want it, or let it go?</button>` : '';
    const decide = isDecide ? `<div class="unsure-decide" data-id="${it.id}">
        <div class="unsure-decide-msg">Still unsure about “${esc(it.text)}”? Time to decide.</div>
        <div class="unsure-decide-actions">
          <button type="button" class="unsure-doit" data-id="${it.id}">Do it</button>
          <button type="button" class="unsure-letgo" data-id="${it.id}">Let it go</button>
        </div>
      </div>` : '';
    const menu = !selectMode ? `<button type="button" class="item-menu" data-id="${it.id}" aria-label="Item actions">⋯</button>` : '';
    return `<div class="item ${it.selected?'selected':''} ${it.ghosted?'ghosted':''} ${isSpot?'working':''}" draggable="true" data-id="${it.id}" style="background:${it.color||'#1e1e28'};color:#111;">
        <div class="item-text"><span class="main">${esc(it.text)}</span> ${due}${yet}${ask}${focusTagHTML(it)}${fin}${whyLineHTML(it)}${hint}${decide}</div>
        ${subBtn}
        ${menu}
        ${!it.ghosted ? `<button type="button" class="done" data-id="${it.id}" aria-label="Mark done" style="background:#22c55e;border:none;color:#fff;border-radius:50%;width:28px;height:28px;">✓</button>` : ''}
      </div>`;
  }

  function itemsOnlyHTML(name) {
    const arr = (groups[name] || []).slice();
    arr.sort((a,b) => (a.ghosted?1:0) - (b.ghosted?1:0));
    return arr.map(itemHTML).join('');
  }

  function catInnerHTML(name, depth) {
    const arr = (groups[name] || []).slice();
    arr.sort((a,b) => (a.ghosted?1:0) - (b.ghosted?1:0));
    const itemIds = arr.map(it => it.id);
    let inner = '';
    arr.forEach(it => {
      inner += itemHTML(it);
      kidsAnchoredTo(name, it.id).forEach(k => {
        if (shouldShowCat(k.name)) inner += catBlockHTML(k.name, depth + 1);
      });
    });
    if (name !== 'Uncategorized' && !isUnsortedName(name)) {
      trailingKids(name, itemIds).forEach(k => {
        if (shouldShowCat(k.name)) inner += catBlockHTML(k.name, depth + 1);
      });
    }
    return inner;
  }

  function treeItems(name) {
    const names = new Set([name].concat(typeof descendantsOf === 'function' ? descendantsOf(name) : []));
    return visible.filter(i => names.has(i.category));
  }

  function catCountHTML(arr, name) {
    const list = (name && name !== 'Uncategorized' && name !== 'Finished' && name !== 'Recently Deleted' && name !== 'Let go')
      ? treeItems(name)
      : (arr || []);
    const total = list.length;
    const doneN = list.filter(i => i.ghosted).length;
    const allDone = total > 0 && doneN === total;
    return `<span class="cat-count${allDone ? ' all-done' : ''}" title="${doneN} of ${total} done">${doneN}/${total}</span>`;
  }

  function catBlockHTML(name, depth) {
    const arr = groups[name] || [];
    const isCollapsed = collapsed[name] && !q;
    const col = (name === 'Uncategorized' || isUnsortedName(name)) ? (isUnsortedName(name) ? getColor(UNSORTED) : '#666') : getColor(name);
    const isCat = !!findCat(name);
    const subCls = depth > 1 ? 'sub' : '';
    const indent = depth > 1 ? `margin-left:${(depth - 1) * 16}px;` : '';
    const desc = isCat ? descendantsOf(name) : [];
    const hiddenSubCount = isCollapsed && desc.length ? visible.filter(i => desc.includes(i.category)).length : 0;
    const subHint = isCollapsed && desc.length ? `<span class="sub-hint">+${desc.length} sub${desc.length === 1 ? '' : 's'}${hiddenSubCount ? ', ' + hiddenSubCount + ' more' : ''}</span>` : '';
    const addSub = isCat && depth < MAX_DEPTH && !isUnsortedName(name) ? `<button type="button" class="add-sub" data-cat="${attrName(name)}" title="Add a subcategory inside ${attrName(name)}" aria-label="Add a subcategory inside ${attrName(name)}">+ sub</button>` : '';
    const onFront = !document.documentElement.getAttribute('data-nb-page') || document.documentElement.getAttribute('data-nb-page') === 'front';
    const dragCat = onFront && depth === 1 && isCat && !isUnsortedName(name) ? ' draggable="true" data-drag="cat"' : '';
    const bullet = depth > 1 ? `<span class="cat-dot nb-bullet" data-cat="${attrName(name)}" style="color:${col}" title="Change color">•</span>` : '';
    const colorDot = depth > 1 ? '' : `<span class="cat-dot" data-cat="${attrName(name)}" style="width:16px;height:16px;border-radius:50%;background:${col};display:inline-block;margin-left:8px;cursor:pointer;"></span>`;
    let block = `<div class="group-header ${subCls} ${name === currentCat ? 'current' : ''}" data-cat="${attrName(name)}" data-depth="${depth}"${dragCat} style="${indent}">
      <span class="arrow" data-cat="${attrName(name)}" title="Double-click to collapse" role="button" aria-label="${isCollapsed ? 'Expand' : 'Collapse'} ${attrName(name)}">${isCollapsed ? '▶' : '▼'}</span>
      ${bullet}
      <span class="cat-name" data-cat="${attrName(name)}" title="${isUnsortedName(name) ? '' : 'Click to rename'}">${name}</span>
      ${catCountHTML(arr, name)}${subHint}
      ${colorDot}
      ${addSub}
      ${(name === 'Uncategorized' || isUnsortedName(name)) ? '' : `<button class="del-cat" data-cat="${attrName(name)}" title="Delete category" style="background:#ef4444;border:none;color:white;border-radius:50%;width:20px;height:20px;font-size:11px;margin-left:6px;cursor:pointer;padding:0;">✕</button><button type="button" class="cat-menu" data-cat="${attrName(name)}" aria-label="Category options">⋯</button>`}
    </div>
      <div class="group-items ${subCls} ${isCollapsed ? 'collapsed' : ''}" data-for="${attrName(name)}" style="${indent}">`;
    block += isCollapsed ? itemsOnlyHTML(name) : catInnerHTML(name, depth);
    block += '</div>';
    return block;
  }

  let html = '';
  const tree = orderedCats(Object.keys(groups));
  const uIdx = tree.findIndex(o => o && isUnsortedName(o.name));
  if (uIdx > 0) {
    const u = tree.splice(uIdx, 1)[0];
    tree.unshift(u);
  }
  tree.push({ name: 'Uncategorized', depth: 1 });
  tree.forEach(({ name, depth }) => {
    const arr = groups[name] || [];
    if (name !== 'Uncategorized' && !isUnsortedName(name) && parentOf(name)) return;
    if (name === 'Uncategorized' && !arr.length && !categories.length) return;
    if ((name === 'Uncategorized' || isUnsortedName(name)) && !arr.length) return;
    if (name !== 'Uncategorized' && !isUnsortedName(name) && !q && ancestorsOf(name).some(a => collapsed[a])) return;
    if (!shouldShowCat(name) && name !== 'Uncategorized' && !isUnsortedName(name)) return;
    html += catBlockHTML(name, (name === 'Uncategorized' || isUnsortedName(name)) ? 1 : depthOf(name));
  });

  const ghosted = visible.filter(i => i.ghosted);
  if (ghosted.length) {
    html += `<div class="group-header" data-cat="Finished" style="opacity:.7;margin-top:28px;"><span class="arrow" data-cat="Finished">▼</span> Finished (${ghosted.length})</div><div class="group-items" data-for="Finished">`;
    ghosted.forEach(it => {
      const fin = it.finishedAt ? `<span class="meta" style="color:#166534;background:rgba(255,255,255,0.85);padding:1px 5px;border-radius:4px;">done ${formatFinishedAt(it.finishedAt)}</span>` : '';
      html += `<div class="item ghosted" draggable="true" data-id="${it.id}" style="background:${it.color||'#1e1e28'};color:#111;opacity:0.75;">
        <div class="item-text"><span class="main">${esc(it.text)}</span> ${fin}</div>
        ${!selectMode ? `<button type="button" class="item-menu" data-id="${it.id}" aria-label="Item actions">⋯</button>` : ''}
        <button type="button" class="undo" data-id="${it.id}" title="Mark not done" aria-label="Mark not done" style="background:#3b82f6;border:none;color:white;border-radius:50%;width:26px;height:26px;font-size:14px;">↩</button>
      </div>`;
    });
    html += '</div>';
  }

  const deleted = deletedItems;
  if (deleted.length) {
    html += `<div class="group-header" data-cat="Recently Deleted" style="opacity:.65;margin-top:28px;">Recently Deleted (${deleted.length})</div><div class="group-items" data-for="Recently Deleted">`;
    deleted.forEach(it => {
      html += `<div class="item" data-id="${it.id}" style="opacity:.65;"><div class="item-text">${esc(it.text)}</div>
        <button class="restore" data-id="${it.id}" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:4px 8px;">Restore</button></div>`;
    });
    html += '</div>';
  }
  if (letGoItems.length) {
    html += `<div class="group-header" data-cat="Let go" style="opacity:.75;margin-top:28px;">Let go (${letGoItems.length})</div><div class="group-items" data-for="Let go">`;
    html += `<div class="letgo-note">Set down for now. You can bring them back anytime.</div>`;
    letGoItems.forEach(it => {
      html += `<div class="item" data-id="${it.id}" style="opacity:.75;"><div class="item-text">${esc(it.text)}</div>
        <button class="bring-back" data-id="${it.id}" style="background:#3b82f6;color:#fff;border:none;border-radius:6px;padding:4px 8px;">Bring back</button></div>`;
    });
    html += '</div>';
  }
  listEl.innerHTML = html;

  document.querySelectorAll('.item[draggable]').forEach(el => {
    el.ondragstart = e => {
      itemWasDragged = true;
      catDragName = null;
      nestDragId = el.dataset.id;
      cancelNest();
      clearDropMarks();
      el.classList.add('nb-dragging');
      e.dataTransfer.setData('text/plain', el.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
    };
    el.ondragend = () => { cancelNest(); nestDragId = null; clearDropMarks(); setTimeout(() => { itemWasDragged = false; }, 0); };
  });
  document.querySelectorAll('.group-header[data-drag="cat"]').forEach(el => {
    el.ondragstart = e => {
      e.stopPropagation();
      catWasDragged = true;
      catDragName = el.dataset.cat;
      nestDragId = null;
      cancelNest();
      clearDropMarks();
      el.classList.add('nb-dragging');
      e.dataTransfer.setData('text/plain', 'cat:' + el.dataset.cat);
      e.dataTransfer.effectAllowed = 'move';
    };
    el.ondragend = () => { catDragName = null; clearDropMarks(); setTimeout(() => { catWasDragged = false; }, 0); };
  });
  document.querySelectorAll('.group-header, .group-items').forEach(zone => {
    zone.ondragover = e => {
      e.preventDefault(); e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const payload = parseDragPayload((catDragName ? 'cat:' + catDragName : '') || nestDragId);
      const overItem = e.target && e.target.closest ? e.target.closest('.item[data-id]') : null;
      const overHead = e.target && e.target.closest ? e.target.closest('.group-header') : null;
      if (payload && payload.kind === 'cat') {
        clearDropMarks();
        if (isReorderableHeader(overHead) && overHead.dataset.cat !== payload.name) {
          overHead.classList.add(dropAfter(overHead, e) ? 'nb-drop-after' : 'nb-drop-before');
        }
        zone.style.background = '';
        return;
      }
      trackNestHover(e);
      document.querySelectorAll('.nb-drop-before, .nb-drop-after').forEach(n => n.classList.remove('nb-drop-before', 'nb-drop-after'));
      if (overItem && !nestReady && String(overItem.dataset.id) !== String(nestDragId)) {
        overItem.classList.add(dropAfter(overItem, e) ? 'nb-drop-after' : 'nb-drop-before');
      }
      // While the "make sub" highlight shows, keep the group tint off so the two looks never mix.
      zone.style.background = (nestReady && zone.contains(document.querySelector('.item.nest-target'))) ? '' : 'rgba(96,165,250,0.1)';
    };
    zone.ondragleave = e => {
      zone.style.background = '';
      if (!e.relatedTarget || !zone.contains(e.relatedTarget)) {
        const t = document.querySelector('.item.nest-pending, .item.nest-target');
        if (t && zone.contains(t) && !(e.relatedTarget && t.contains(e.relatedTarget))) cancelNest();
        document.querySelectorAll('.nb-drop-before, .nb-drop-after').forEach(n => n.classList.remove('nb-drop-before', 'nb-drop-after'));
      }
    };
    zone.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      zone.style.background = '';
      const raw = (e.dataTransfer && e.dataTransfer.getData('text/plain')) || (catDragName ? 'cat:' + catDragName : '') || nestDragId;
      const payload = parseDragPayload(raw);
      const overItem = e.target && e.target.closest ? e.target.closest('.item[data-id]') : null;
      const overHead = e.target && e.target.closest ? e.target.closest('.group-header') : null;
      if (payload && payload.kind === 'cat') {
        cancelNest();
        catDragName = null;
        const target = isReorderableHeader(overHead) ? overHead : (isReorderableHeader(zone) ? zone : null);
        if (target && target.dataset.cat !== payload.name) reorderTopCats(payload.name, target.dataset.cat, dropAfter(target, e));
        else clearDropMarks();
        return;
      }
      const id = payload && payload.id;
      if (nestReady && nestTargetId != null && overItem && String(overItem.dataset.id) === String(nestTargetId)) {
        const tid = nestTargetId;
        cancelNest();
        nestDragId = null;
        clearDropMarks();
        if (makeSubFromItem(tid, id)) return;
      }
      cancelNest();
      clearDropMarks();
      let cat = zone.dataset.for || zone.dataset.cat;
      if (!cat || cat === 'Recently Deleted' || cat === 'Let go') return;
      if (overItem) {
        placeItemAt(id, overItem.dataset.id, dropAfter(overItem, e), cat);
        return;
      }
      const it = items.find(i => i.id == id);
      if (it) {
        it.category = (cat === 'Uncategorized' || cat === 'Finished') ? '' : cat;
        it.color = getColor(it.category);
        if (cat !== 'Finished') {
          it.ghosted = false;
          it.finishedAt = null;
        }
        save();
        render();
      }
    };
  });

  markWorkingSpot({ scroll: false });
  if (decidingUnsure) {
    if (String(lastUnsurePromptId) !== String(decidingUnsure.id)) {
      lastUnsurePromptId = decidingUnsure.id;
      const panel = document.querySelector('.unsure-decide');
      if (panel) {
        try { (panel.closest('.item') || panel).scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) {}
      }
    }
  } else {
    lastUnsurePromptId = null;
  }
}

function closeColorPicker() {
  document.querySelectorAll('.color-picker').forEach(p => p.remove());
  document.removeEventListener('pointerdown', _cpOutside, true);
  document.removeEventListener('keydown', _cpEsc, true);
}
let _cpOutside = null, _cpEsc = null;
function showColorPicker(catName) {
  closeColorPicker();
  const div = document.createElement('div');
  div.className = 'color-picker';
  div.setAttribute('role', 'dialog');
  div.setAttribute('aria-label', 'Change color for ' + catName);
  div.innerHTML = `<div class="cp-title">Color for “${esc(catName)}”</div>`;
  PALETTE.forEach(col => {
    const s = document.createElement('div');
    s.className = 'swatch';
    s.style.background = col;
    s.onclick = () => {
      let c = categories.find(x => x.name === catName);
      const oldCol = c ? c.color : null;
      if (!c) { c = {name: catName, color: col}; categories.push(c); }
      else c.color = col;
      const branch = [...ancestorsOf(catName), ...descendantsOf(catName)];
      descendantsOf(catName).forEach(n => {
        const d = findCat(n);
        if (d && oldCol && d.color === oldCol) {
          d.color = col;
          items.forEach(it => { if (it.category === n) it.color = col; });
        }
      });
      const conflict = categories.find(x => x.color === col && x.name !== catName && !branch.includes(x.name));
      items.forEach(it => { if (it.category === catName) it.color = col; });
      save(); render();
      if (conflict) {
        const title = div.querySelector('.cp-title') || div.querySelector('div');
        title.textContent = `${conflict.name} uses this color — pick another?`;
        title.style.color = '#f59e0b';
      } else closeColorPicker();
    };
    div.appendChild(s);
  });
  const skip = document.createElement('button');
  skip.textContent = 'Done';
  skip.className = 'secondary';
  skip.style.marginTop = '10px';
  skip.onclick = () => closeColorPicker();
  div.appendChild(document.createElement('br'));
  div.appendChild(skip);
  document.body.appendChild(div);
  _cpOutside = ev => {
    if (!div.isConnected) { closeColorPicker(); return; }
    if (div.contains(ev.target)) return;
    closeColorPicker();
  };
  _cpEsc = ev => { if (ev.key === 'Escape') { ev.preventDefault(); closeColorPicker(); } };
  setTimeout(() => {
    document.addEventListener('pointerdown', _cpOutside, true);
    document.addEventListener('keydown', _cpEsc, true);
  }, 0);
}

var addedCatDest; // destination named in the "still go to" line, so it can clear once untrue
function addedCatStatus(added, name) {
  addedCatDest = undefined;
  if (currentCat === name) return added + '. New items will go there.';
  addedCatDest = currentCat;
  if (!currentCat) return added + '. ' + uiCopyText('addedPageUncat', null, 'New items will go uncategorized until you assign them.');
  return added + '. ' + uiCopyText('addedPageDest', { dest: currentCat }, 'New items will still go to ' + currentCat + ' until you assign them.');
}

addCatBtn.onclick = () => {
  const name = catInput.value.trim();
  if (!name) return;
  if (typeof isUnsortedName === 'function' && isUnsortedName(name)) {
    catInput.value = '';
    setStatus('Unsorted is a built-in page for quick captures.');
    return;
  }
  const segs = name.split('>').map(x => x.trim()).filter(Boolean);
  if (name.includes('>') && segs.length >= 2) {
    // "AccuLynx > Estimates > White's Estimate": first part is used as-is, the rest nest under it.
    let parent = '';
    let last = null, problem = '', movedNote = '';
    for (let i = 0; i < segs.length; i++) {
      let r;
      if (i === 0) {
        const existing = findCatCI(segs[0]);
        r = existing ? { cat: existing } : placeCategory(segs[0], '');
      } else {
        r = placeCategory(segs[i], parent);
      }
      if (r.error) { problem = r.error; break; }
      if (r.moved) movedNote = ' (moved “' + r.cat.name + '” here)';
      last = r.cat;
      parent = r.cat.name;
    }
    catInput.value = '';
    workingItemId = null;
    save();
    render();
    if (last) showColorPicker(last.name);
    setStatus(problem ? problem : addedCatStatus('Added “' + catPath(last.name) + '”' + movedNote, last.name));
    return;
  }
  if (!categories.find(c => c.name === name)) categories.push({ name, color: PALETTE[categories.length % PALETTE.length] });
  workingItemId = null;
  catInput.value = '';
  save();
  render();
  if (lastPointerType !== 'mouse' || matchMedia('(pointer: coarse)').matches) catInput.blur();
  showColorPicker(name);
  setStatus(addedCatStatus('Added “' + name + '”', name));
};
catInput.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addCatBtn.click(); } else if (e.key === 'Escape') { e.preventDefault(); hideCatInput(); } };

// v33: Add Category is button-only on the Front page — the name field stays hidden until the button is tapped.
function revealCatInput() {
  catInput.hidden = false;
  const cancel = $('cancelCatBtn'); if (cancel) cancel.hidden = false;
  try { catInput.focus(); } catch (e) {}
}
function hideCatInput() {
  catInput.value = '';
  catInput.hidden = true;
  const cancel = $('cancelCatBtn'); if (cancel) cancel.hidden = true;
}
(function () {
  const originalAddCat = addCatBtn.onclick;
  addCatBtn.onclick = () => {
    if (!catInput.value.trim()) {
      if (catInput.hidden) revealCatInput(); else hideCatInput();
      return;
    }
    originalAddCat();
    hideCatInput();
  };
  const cancel = $('cancelCatBtn'); if (cancel) cancel.onclick = () => hideCatInput();
})();
catSelect.onchange = () => { workingItemId = null; currentCat = catSelect.value; save(); render(); revealCurrentCat({ scroll: true }); };
if ($('addingTo')) $('addingTo').onclick = () => {
  if (!currentCat && !workingItemId) { catSelect.focus(); return; }
  clearWorkingSpot();
};

// Typed and voiced adds always create a new item, even if another item already
// has the same text (“invoice”, “estimate”). Never pull or move an existing
// item from here. Moving is by drag, or the explicit voice command “move X to Y”.
// Exception: a due-date phrase attaches the date to an existing item only when
// the leftover name is an exact match (case/whitespace-insensitive). Partial
// matches like “invoice for Blank due tomorrow” vs “invoice” create a new item.
function addItem(text, opts) {
  opts = opts || {};
  text = (text || itemInput.value).trim();
  if (!text) return;
  const cat = opts.category !== undefined ? opts.category : currentCat;
  const looksLikeTracker = !!parseTrackerPhrase(text);
  const parsedDue = looksLikeTracker ? { text, due: null } : parseDuePhrase(text, new Date());
  if (parsedDue.due && typeof findItemByExactText === 'function') {
    const existing = findItemByExactText(parsedDue.text);
    if (existing) {
      existing.due = parsedDue.due.toISOString();
      existing.dueText = parsedDue.phrase;
      lastAddedId = existing.id;
      if (!opts.keepInput) { itemInput.value = ''; autoGrowInput(); }
      save(); render();
      revealCurrentCat({ scroll: true });
      setStatus('Due set · ' + dueLabel(existing.due) + ' (tap the tag to change)');
      return existing;
    }
  }
  const it = {
    id: Date.now() + Math.random(),
    text: parsedDue.due ? parsedDue.text : text,
    category: cat,
    color: cat ? (isUnsortedName(cat) ? '#ffffff' : getColor(cat)) : '#ffffff',
    ghosted: false, finishedAt: null, due: parsedDue.due ? parsedDue.due.toISOString() : null, deleted: false, selected: false,
    createdAt: bdNow()
  };
  if (parsedDue.due) it.dueText = parsedDue.phrase;
  friendApplyPending(it);
  if (opts.place === 'end') items.push(it);
  else items.unshift(it);
  lastAddedId = it.id;
  if (typeof window.__bdCompareOnAdd === 'function') { try { window.__bdCompareOnAdd(it); } catch (e) {} }
  if (!opts.keepInput) { itemInput.value = ''; autoGrowInput(); }
  save(); render();
  revealCurrentCat({ scroll: true });
  if (parsedDue.due) setStatus('Added · ' + dueLabel(it.due) + ' (tap the tag to change)');
  if (looksLikeTracker) offerTracker({ text });
  else { const h = $('trackHint'); if (h) h.style.display = 'none'; }
  return it;
}
let addKeepsFocus = false;
addItemBtn.addEventListener('pointerdown', () => { addKeepsFocus = document.activeElement === itemInput; });
addItemBtn.addEventListener('mousedown', e => { if (document.activeElement === itemInput) e.preventDefault(); });
// Mobile fix 8: after a typed add, a quiet "✓ Added: …" line right under the box (unless something else was just said there)
function addTypedItem() {
  const raw = (itemInput.value || '').trim();
  if (raw && typeof parseAddToDest === 'function') {
    const parsed = parseAddToDest(raw, { allowBareTo: false });
    if (parsed && parsed.explicit && parsed.text) {
      itemInput.value = '';
      if (typeof autoGrowInput === 'function') autoGrowInput();
      return fileCapturedItem(parsed.text, parsed.dest, { allowCreate: true, explicit: true });
    }
  }
  const before = micStatus.textContent;
  const it = addItem();
  if (it && micStatus.textContent === before) setStatus(uiCopyText('itemAdded', { item: shortQuote(it.text).slice(1, -1) }, '✓ Added: ' + shortQuote(it.text)));
  return it;
}
addItemBtn.onclick = () => { addTypedItem(); if (addKeepsFocus) itemInput.focus(); addKeepsFocus = false; };
itemInput.setAttribute('enterkeyhint', 'enter');
itemInput.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addTypedItem(); } };
// Mobile fix 13: the dump box grows with what you type (no resize handle on phones)
function autoGrowInput() {
  if (!itemInput) return;
  itemInput.style.height = '';
  if (!itemInput.value) return;
  const max = 168;
  const want = Math.min(itemInput.scrollHeight + 2, max);
  if (want > itemInput.offsetHeight) itemInput.style.height = want + 'px';
  itemInput.style.overflowY = itemInput.scrollHeight + 2 > max ? 'auto' : '';
}
itemInput.addEventListener('input', autoGrowInput);
itemInput.addEventListener('focus', () => revealCurrentCat({ scroll: true, smooth: true }));
itemInput.addEventListener('input', () => revealCurrentCat({ scroll: true }));

// Event delegation for the whole list
listEl.addEventListener('click', e => {
  const t = e.target;
  const itemEl = t.closest('.item');
  const header = t.closest('.group-header');

  const tipBubble = t.closest('.hint-bubble');
  if (tipBubble) {
    e.stopPropagation();
    if (!selectMode) openTipSheet(tipBubble.dataset.id);
    return;
  }
  const slideHint = t.closest('.slide-hint');
  if (slideHint) {
    e.stopPropagation();
    const it = items.find(i => i.id == slideHint.dataset.id);
    if (it && !selectMode) openKindSheet(it);
    return;
  }
  const doItBtn = t.closest('.unsure-doit');
  if (doItBtn) {
    e.stopPropagation();
    const it = items.find(i => i.id == doItBtn.dataset.id);
    if (it) doUnsureItem(it);
    return;
  }
  const letGoBtn = t.closest('.unsure-letgo');
  if (letGoBtn) {
    e.stopPropagation();
    const it = items.find(i => i.id == letGoBtn.dataset.id);
    if (it) letGoItem(it);
    return;
  }
  const itemAddSub = t.closest('.item-add-sub');
  if (itemAddSub) {
    e.stopPropagation();
    const it = items.find(i => i.id == itemAddSub.dataset.id);
    if (it && it.category && !selectMode) openSubInput(it.category, it.id);
    return;
  }
  const itemMenu = t.closest('.item-menu');
  if (itemMenu) {
    e.stopPropagation();
    if (!selectMode) openItemSheet(itemMenu.dataset.id);
    return;
  }

  // Done button
  if (t.classList.contains('done') && itemEl) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (!it) return;
    it.ghosted = true;
    it.finishedAt = new Date(bdNow()).toISOString();
    it.doneAt = bdNow();
    clearUnsure(it);
    save(); render();
    return;
  }
  // Undo finished (uncheck) — only via the button
  if (t.classList.contains('undo') && itemEl) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it) {
      it.ghosted = false;
      it.finishedAt = null;
      delete it.doneAt;
      save();
      render();
    }
    return;
  }

  // Delete item
  if (t.classList.contains('del') && itemEl) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it) { deleteItem(it); save(); render(); }
    return;
  }
  // Bring back from Let go
  if (t.classList.contains('bring-back') && itemEl) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it) bringBackItem(it);
    return;
  }
  // Restore
  if (t.classList.contains('restore') && itemEl) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it) {
      // If its category was deleted, bring the category back (under its old parent if that still exists).
      if (it.category && !findCat(it.category)) {
        const info = it.deletedCat || {};
        const nc = { name: it.category, color: info.color || it.color || PALETTE[categories.length % PALETTE.length] };
        if (info.parent && findCat(info.parent) && depthOf(info.parent) < MAX_DEPTH) nc.parent = info.parent;
        categories.push(nc);
      }
      it.deleted = false;
      delete it.deletedCat;
      save(); render();
    }
    return;
  }
  // Delete category: its items go to Recently Deleted; its subcategories move up one level (nothing is lost)
  if (t.classList.contains('del-cat')) {
    const cat = t.dataset.cat;
    const c = findCat(cat);
    const parentName = c ? (c.parent || '') : '';
    const kids = c ? childrenOf(cat).map(k => k.name) : [];
    const own = items.filter(i => !i.deleted && (i.category || 'Uncategorized') === cat);
    let msg = '';
    if (own.length) msg += 'Its ' + own.length + ' item' + (own.length === 1 ? '' : 's') + ' will go to Recently Deleted (you can restore for 48 hours).';
    if (kids.length) msg += (msg ? '\n\n' : '') + 'Its subcategories (' + kids.join(', ') + ') and their items move up to ' + (parentName ? '“' + parentName + '”' : 'the top level') + '.';
    askSheet({ title: 'Delete category “' + cat + '”?', body: msg, ok: 'Delete', cancel: 'Keep it', danger: true }).then(yes => {
    if (yes) {
      const now = Date.now();
      own.forEach(i => {
        i.deleted = true; i.deletedAt = now; i.selected = false;
        if (cat !== 'Uncategorized') i.deletedCat = { name: cat, color: c ? c.color : i.color, parent: parentName };
      });
      kids.forEach(k => { const kc = findCat(k); if (!kc) return; if (parentName) kc.parent = parentName; else delete kc.parent; delete kc.afterItem; });
      categories = categories.filter(x => x.name !== cat);
      delete collapsed[cat];
      if (currentCat === cat) currentCat = parentName;
      save(); render();
    }
    });
    return;
  }
  // + sub: inline box to add a subcategory
  if (t.classList.contains('add-sub')) {
    e.stopPropagation();
    openSubInput(t.dataset.cat);
    return;
  }
  // Color dot
  if (t.classList.contains('cat-dot')) {
    showColorPicker(t.dataset.cat);
    return;
  }
  // Select mode toggle on item
  if (selectMode && itemEl && !t.closest('button')) {
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it && !it.deleted) { it.selected = !it.selected; save(); render(); }
    return;
  }
  // Single-tap an item = working spot (not on finish/delete/⋯/+ sub, not after a drag, not in Finished/Recently Deleted)
  if (itemEl && !t.closest('button') && !t.closest('.due-tag') && !searchQuery) {
    if (itemWasDragged) { itemWasDragged = false; return; }
    const group = itemEl.closest('.group-items');
    const groupFor = group && group.dataset.for;
    if (groupFor === 'Finished' || groupFor === 'Let go' || groupFor === 'Recently Deleted' || (group && !groupFor)) return;
    const it = items.find(i => i.id == itemEl.dataset.id);
    if (it && !it.deleted && !it.ghosted) {
      setWorkingFromItem(it);
      return;
    }
  }
  // Rename: click on category name
  if (t.classList.contains('cat-name')) {
    e.stopPropagation();
    e.preventDefault();
    const oldName = t.dataset.cat;
    if (!oldName || ['Uncategorized','Finished','Recently Deleted','Let go','Unsorted'].includes(oldName) || isUnsortedName(oldName)) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.style.cssText = 'font-weight:700;font-size:15px;width:160px;padding:3px 8px;border-radius:6px;border:2px solid #3b82f6;background:#0f0f12;color:#fff;cursor:text;';
    t.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finishRename = () => {
      if (done) return;
      done = true;
      applyRename(oldName, input.value);
      render();
    };
    input.addEventListener('blur', finishRename);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); finishRename(); }
      if (ev.key === 'Escape') { done = true; render(); }
    });
    return;
  }

  // Single click header = working category (ignore arrow, buttons, name, dot). No full re-render so double-click still works.
  if (header && !t.closest('button') && !t.classList.contains('cat-dot') && !t.classList.contains('arrow') && !t.classList.contains('cat-name') && !t.classList.contains('nb-bullet')) {
    if (catWasDragged) { catWasDragged = false; return; }
    const cat = header.dataset.cat;
    if (cat && cat !== 'Recently Deleted' && cat !== 'Finished' && cat !== 'Let go') {
      setWorkingFromCat(cat);
    }
  }
});

// Reliable collapse on arrow double-click + rename on name double-click
listEl.addEventListener('dblclick', function(e) {
  const arrow = e.target.closest('.arrow');
  const catNameSpan = e.target.closest('.cat-name');

  if (arrow) {
    e.preventDefault();
    const header = arrow.closest('.group-header');
    if (!header) return;
    const itemsDiv = header.nextElementSibling;
    if (itemsDiv && itemsDiv.classList.contains('group-items')) {
      itemsDiv.classList.toggle('collapsed');
      const cat = header.dataset.cat;
      if (cat) {
        collapsed[cat] = itemsDiv.classList.contains('collapsed');
        save();
      }
      arrow.textContent = itemsDiv.classList.contains('collapsed') ? '▶' : '▼';
      if (cat && findCat(cat) && childrenOf(cat).length) render();
    }
    e.stopPropagation();
    return;
  }

  if (catNameSpan) {
    const oldName = catNameSpan.dataset.cat;
    if (!oldName || oldName === 'Uncategorized' || oldName === 'Finished' || oldName === 'Recently Deleted' || oldName === 'Let go' || isUnsortedName(oldName)) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.style.cssText = 'font-weight:700; font-size:15px; width:160px; padding:2px 8px; border-radius:6px; border:2px solid #3b82f6; background:#111; color:white;';
    catNameSpan.style.display = 'none';
    catNameSpan.parentNode.insertBefore(input, catNameSpan);
    input.focus();
    input.select();

    const saveRename = () => {
      applyRename(oldName, input.value);
      render();
    };
    input.addEventListener('blur', saveRename);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); saveRename(); }
      if (ev.key === 'Escape') render();
    });
    e.stopPropagation();
    return;
  }

  const itemMain = e.target.closest('.item .main') || e.target.closest('.item .item-text');
  if (itemMain) {
    const itemEl = itemMain.closest('.item');
    const it = itemEl && items.find(i => String(i.id) === String(itemEl.dataset.id));
    if (it && !it.deleted && !it.letGo) {
      e.preventDefault();
      e.stopPropagation();
      startItemEdit(it);
    }
  }
});

function openSubInput(parentName, afterItem) {
  document.querySelectorAll('.sub-input-row').forEach(r => r.remove());
  const header = [...document.querySelectorAll('.group-header')].find(h => h.dataset.cat === parentName);
  const row = document.createElement('div');
  row.className = 'sub-input-row';
  row.style.marginLeft = (depthOf(parentName) * 16) + 'px';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = afterItem != null ? 'Name a subcategory under this item…' : ('New subcategory in ' + parentName + '…');
  row.appendChild(input);
  const anchor = afterItem != null ? document.querySelector('.item[data-id="' + afterItem + '"]') : null;
  if (anchor) {
    anchor.after(row);
  } else if (header) {
    const after = header.nextElementSibling && header.nextElementSibling.classList.contains('group-items') ? header.nextElementSibling : header;
    after.after(row);
  } else {
    return;
  }
  input.focus();
  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    const val = input.value.trim();
    if (!commit || !val) { row.remove(); return; }
    const r = placeCategory(val, parentName, afterItem);
    if (r.error) { row.remove(); setStatus(r.error); return; }
    if (collapsed[parentName]) collapsed[parentName] = false;
    currentCat = r.cat.name;
    workingItemId = null;
    save(); render();
    setStatus('Adding to ' + catPath(r.cat.name) + (r.moved ? ' (moved it here)' : ''));
    revealCurrentCat({ scroll: true });
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}
function deleteItem(it) {
  if (!it) return;
  it.deleted = true;
  it.deletedAt = Date.now();
  it.selected = false;
  if (it.letGo) { it.letGo = false; delete it.letGoAt; }
  if (workingItemId != null && String(workingItemId) === String(it.id)) workingItemId = null;
}
function bringBackItem(it) {
  if (!it) return;
  if (it.category && !findCat(it.category)) {
    const info = it.deletedCat || {};
    const nc = { name: it.category, color: info.color || it.color || PALETTE[categories.length % PALETTE.length] };
    if (info.parent && findCat(info.parent) && depthOf(info.parent) < MAX_DEPTH) nc.parent = info.parent;
    categories.push(nc);
  }
  it.letGo = false;
  delete it.letGoAt;
  it.deleted = false;
  delete it.deletedCat;
  save(); render();
}
function nudgeFollowsUp() {
  const n = (profile && profile.nudge) || 'off';
  return n === 'stay' || n === 'check';
}
const UNSURE_DECIDE_MS = 3 * 24 * 60 * 60 * 1000;
let lastUnsurePromptId = null;
function bdNow() {
  return (typeof window !== 'undefined' && typeof window.__bdNow === 'number') ? window.__bdNow : Date.now();
}
function formatFinishedAt(val) {
  if (val == null || val === '') return '';
  let n = typeof val === 'number' ? val : Date.parse(val);
  if (isNaN(n)) return String(val);
  const d = new Date(n);
  const now = new Date(bdNow());
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\u202f/g, ' ').replace(/\s+/g, ' ').trim();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startToday - startThat) / 86400000);
  if (days === 0) return 'today ' + time;
  if (days > 0 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function unsureSinceMs(it) {
  if (!it || it.unsureSince == null || it.unsureSince === '') return 0;
  if (typeof it.unsureSince === 'number') return it.unsureSince;
  const n = Date.parse(it.unsureSince);
  return isNaN(n) ? 0 : n;
}
function isUnsureDue(it, now) {
  if (!it || !it.unsure || it.deleted || it.letGo || it.ghosted) return false;
  const since = unsureSinceMs(it);
  if (!since) return false;
  return (now != null ? now : bdNow()) - since >= UNSURE_DECIDE_MS;
}
function nextUnsureDecide(now) {
  const due = items.filter(i => isUnsureDue(i, now)).slice().sort((a, b) => unsureSinceMs(a) - unsureSinceMs(b));
  return due[0] || null;
}
function clearUnsure(it) {
  if (!it) return;
  it.unsure = false;
  delete it.unsureSince;
}
function markUnsure(it) {
  if (!it || it.deleted || it.letGo) return;
  it.unsure = true;
  if (!it.unsureSince) it.unsureSince = new Date(bdNow()).toISOString();
  save(); render();
  setStatus('Marked not sure — we’ll ask you to decide in a few days');
}
function doUnsureItem(it) {
  if (!it) return;
  clearUnsure(it);
  save(); render();
  setStatus('Got it — add a date if you want');
  openDueSheet(it, { prompt: 'Want to add a date? (optional)' });
}
try { window.UNSURE_DECIDE_MS = UNSURE_DECIDE_MS; } catch (e) {}
function canItemSub(it) {
  const parent = it && it.category;
  return !!(it && !it.deleted && !it.letGo && !it.ghosted && parent && findCat(parent) && depthOf(parent) < MAX_DEPTH);
}
function keepItem(it) {
  if (!it) return;
  const hadDue = !!it.due;
  it.notYet = true;
  it.notDoneCount = (it.notDoneCount || 0) + 1;
  it.notYetAt = Date.now();
  clearUnsure(it);
  save(); render();
  setStatus('Kept — not yet');
  if (hadDue) openDueSheet(it, { prompt: 'Want to pick a new date?' });
}
function letGoItem(it) {
  if (!it) return;
  it.letGo = true;
  it.letGoAt = bdNow();
  it.selected = false;
  it.ghosted = false;
  it.finishedAt = null;
  if (workingItemId != null && String(workingItemId) === String(it.id)) workingItemId = null;
  clearUnsure(it);
  save(); render();
  setStatus('Set down in Let go');
}
function openKindSheet(it) {
  closeKindSheet();
  closeCatSheet();
  if (!it || it.deleted || it.letGo) return;
  const div = document.createElement('div');
  div.className = 'kind-sheet';
  div.innerHTML = `<div class="kind-title">Not done with this?</div>
    <div class="kind-item">“${esc(it.text)}”</div>
    <button type="button" class="secondary" data-act="keep">Keep it</button>
    <button type="button" class="secondary" data-act="letgo">Let it go</button>
    <button type="button" class="secondary" data-act="unsure">Not sure</button>`;
  div.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    closeKindSheet();
    if (act === 'keep') keepItem(it);
    else if (act === 'letgo') letGoItem(it);
    else if (act === 'unsure') markUnsure(it);
  });
  document.body.appendChild(div);
  wireDismiss(div, closeKindSheet);
}
function closeKindSheet() { unwireDismiss('.kind-sheet'); }

function openItemSheet(id) {
  closeCatSheet();
  closeKindSheet();
  const it = items.find(i => i.id == id);
  if (!it || it.deleted || it.letGo) return;
  const canSub = canItemSub(it);
  const div = document.createElement('div');
  div.className = 'cat-sheet item-sheet';
  const setDownBtn = !it.ghosted ? `<button type="button" class="secondary" data-act="notdone">Set this down</button>` : '';
  const uncheckBtn = it.ghosted ? `<button type="button" class="secondary" data-act="uncheck">Not done</button>` : '';
  const subBtn = canSub ? `<button type="button" class="secondary" data-act="sub">+ sub</button>` : '';
  div.innerHTML = `<div class="cat-sheet-title">“${esc(it.text)}”</div>
    <button type="button" class="secondary" data-act="edit">Edit</button>
    <div class="sheet-row"><button type="button" class="secondary" data-act="move">Move to…</button>${subBtn}</div>
    <div class="sheet-row"><button type="button" class="secondary" data-act="due">Due date</button><button type="button" class="secondary" data-act="why">${(it.why || it.whyGoal) ? 'Edit the why' : 'Add a why'}</button></div>
    ${setDownBtn}${uncheckBtn}
    <button type="button" class="secondary" data-act="close">Close</button>
    <button type="button" class="sheet-delete" data-act="delete">Delete</button>`;
  div.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    const act = b.dataset.act;
    closeCatSheet();
    if (act === 'sub' && canItemSub(it)) openSubInput(it.category, it.id);
    else if (act === 'delete') {
      deleteItem(it); save(); render();
      showVoiceToast('Deleted ' + shortQuote(it.text), () => { it.deleted = false; delete it.deletedAt; save(); render(); });
    }
    else if (act === 'due') openDueSheet(it);
    else if (act === 'notdone') openKindSheet(it);
    else if (act === 'uncheck') {
      it.ghosted = false; it.finishedAt = null; delete it.doneAt; save(); render();
      setStatus('Marked not done');
    }
    else if (act === 'why') openWhySheet(it.id);
    else if (act === 'move') openMoveSheet(it.id);
    else if (act === 'edit') startItemEdit(it);
  });
  document.body.appendChild(div);
  wireDismiss(div, closeCatSheet);
}

function startItemEdit(it) {
  if (!it || it.deleted || it.letGo) return;
  const itemEl = document.querySelector('.item[data-id="' + it.id + '"]');
  const main = itemEl && itemEl.querySelector('.main');
  if (!main) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = it.text;
  input.setAttribute('aria-label', 'Edit item');
  input.style.cssText = 'font: inherit; color: inherit; width: 100%; min-width: 0; padding: 2px 6px; border-radius: 6px; border: 2px solid #b5522a; background: rgba(255,250,241,0.95);';
  main.style.display = 'none';
  main.parentNode.insertBefore(input, main);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      const val = input.value.trim();
      if (val && val !== it.text) { it.text = val; save(); }
    }
    render();
  };
  input.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

// Mobile fix 6: fingers can't always drag, so an item's ⋯ → Move to… lists every category (same result as a drag-drop).
function moveTargets() {
  const out = [];
  const walk = (parent, depth) => {
    categories.filter(c => (c.parent || '') === parent).forEach(c => { out.push({ name: c.name, depth }); walk(c.name, depth + 1); });
  };
  walk('', 0);
  // anything whose parent is missing still shows up
  categories.forEach(c => { if (!out.some(o => o.name === c.name)) out.push({ name: c.name, depth: 0 }); });
  return out;
}
function moveItemTo(id, cat) {
  const it = items.find(i => i.id == id);
  if (!it) return false;
  const prev = { category: it.category, color: it.color, ghosted: it.ghosted, finishedAt: it.finishedAt };
  it.category = cat === 'Uncategorized' ? '' : cat;
  it.color = getColor(it.category);
  it.ghosted = false;
  it.finishedAt = null;
  save(); render();
  showVoiceToast('Moved to ' + (it.category || 'No category'), () => { Object.assign(it, prev); save(); render(); });
  return true;
}
function openMoveSheet(id) {
  closeCatSheet();
  const it = items.find(i => i.id == id);
  if (!it || it.deleted || it.letGo) return;
  const here = it.category || '';
  const div = document.createElement('div');
  div.className = 'cat-sheet move-sheet';
  const rows = moveTargets().map(t => `<button type="button" class="secondary${t.name === here ? ' here' : ''}" data-move="${esc(t.name)}" style="padding-left:${14 + t.depth * 18}px"${t.name === here ? ' disabled' : ''}>${t.depth ? '↳ ' : ''}${esc(t.name)}${t.name === here ? ' · here now' : ''}</button>`).join('');
  div.innerHTML = `<div class="cat-sheet-title">Move “${esc(it.text)}” to…</div>
    <div class="move-list">${rows}<button type="button" class="secondary${!here ? ' here' : ''}" data-move="Uncategorized"${!here ? ' disabled' : ''}>No category${!here ? ' · here now' : ''}</button></div>
    <button type="button" class="secondary" data-act="close">Cancel</button>`;
  div.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b || b.disabled) return;
    closeCatSheet();
    if (b.dataset.move != null) moveItemTo(id, b.dataset.move);
  });
  document.body.appendChild(div);
  wireDismiss(div, closeCatSheet);
}

// Select mode actions
$('deleteSelected').onclick = () => {
  items.forEach(it => { if (it.selected) { it.deleted = true; it.deletedAt = Date.now(); it.selected = false; } });
  selectMode = false; selectBtn.textContent = 'Select';
  save(); render();
};
$('undoSelected').onclick = () => {
  items.forEach(it => { if (it.selected && it.ghosted) { it.ghosted = false; it.finishedAt = null; it.selected = false; } });
  selectMode = false; selectBtn.textContent = 'Select';
  save(); render();
};
$('moveSelectedTo').onchange = () => {
  const target = $('moveSelectedTo').value;
  if (!target) return;
  items.forEach(it => {
    if (it.selected) {
      it.category = target === 'Uncategorized' ? '' : target;
      it.color = getColor(it.category);
      it.ghosted = false;
      it.finishedAt = null;
      it.selected = false;
    }
  });
  selectMode = false; selectBtn.textContent = 'Select';
  $('moveSelectedTo').value = '';
  save(); render();
};

// Color toolbar
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.onclick = () => {
    const col = btn.dataset.color;
    const selected = items.filter(it => it.selected && !it.deleted);
    if (!selected.length) return;

    // Check if this color is already linked to a category
    const linked = categories.find(c => c.color === col);

    if (linked) {
      // Move selected items into the existing category
      selected.forEach(it => {
        it.color = col;
        it.category = linked.name;
        it.selected = false;
      });
      selectMode = false;
      selectBtn.textContent = 'Select';
      save();
      render();
      setStatus('Moved to ' + linked.name);
      return;
    }

    // Color not linked — ask (in-app sheet) for a name to create a category
    askSheet({ title: 'New category for this color?', body: 'This color isn’t linked to a category yet. Name one, or skip to just color the items.', input: true, placeholder: 'e.g. Errands', ok: 'Create', cancel: 'Just color' }).then(name => {
    if (name && name.trim()) {
      const catName = name.trim();
      categories.push({ name: catName, color: col });
      selected.forEach(it => {
        it.color = col;
        it.category = catName;
        it.selected = false;
      });
      if (!currentCat) currentCat = catName;
      selectMode = false;
      selectBtn.textContent = 'Select';
      save();
      render();
      setStatus('Created “' + catName + '” and moved items');
    } else {
      // Just color them, no category
      selected.forEach(it => { it.color = col; it.selected = false; });
      selectMode = false;
      selectBtn.textContent = 'Select';
      save();
      render();
    }
    });
  };
});

function backupStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function downloadBlob(name, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} }, 1000);
}
function exportJSONBackup() {
  const payload = { app: 'Brain Dump', exportedAt: new Date().toISOString(), items: items, categories: categories };
  downloadBlob('brain-dump-backup-' + backupStamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
  if (typeof markBackupSaved === 'function') markBackupSaved();
  setStatus('Backup saved');
}
function exportPlainText() {
  function lineFor(it, indent) {
    const pad = indent || '';
    let s = pad + (it.ghosted ? '✓ ' : '• ') + (it.text || '');
    if (it.due) {
      try { s += '  (due ' + (typeof dueLabel === 'function' ? dueLabel(it.due) : it.due) + ')'; } catch (e) { s += '  (due)'; }
    }
    if (it.ghosted) s += '  — done ' + formatFinishedAt(it.finishedAt || it.doneAt);
    return s;
  }
  const seen = new Set();
  const lines = [];
  const when = new Date().toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  lines.push('Brain Dump — readable copy');
  lines.push(when);
  lines.push('');
  const walk = (parent, depth) => {
    const kids = categories.filter(c => (c.parent || '') === parent);
    kids.forEach(c => {
      const indent = '  '.repeat(depth);
      const under = c.parent ? '  (under ' + c.parent + ')' : '';
      lines.push(indent + c.name + under);
      const mine = items.filter(it => !it.deleted && !it.letGo && it.category === c.name);
      mine.forEach(it => { seen.add(it.id); lines.push(lineFor(it, indent + '  ')); });
      walk(c.name, depth + 1);
      lines.push('');
    });
  };
  walk('', 0);
  const loose = items.filter(it => !it.deleted && !it.letGo && !it.category && !seen.has(it.id));
  if (loose.length) {
    lines.push('No category');
    loose.forEach(it => { seen.add(it.id); lines.push(lineFor(it, '  ')); });
    lines.push('');
  }
  const unsorted = items.filter(it => !it.deleted && !it.letGo && isUnsortedName(it.category) && !seen.has(it.id));
  if (unsorted.length) {
    lines.push('Unsorted');
    unsorted.forEach(it => { seen.add(it.id); lines.push(lineFor(it, '  ')); });
    lines.push('');
  }
  const letgo = items.filter(it => it.letGo && !it.deleted);
  if (letgo.length) {
    lines.push('Let go');
    letgo.forEach(it => lines.push(lineFor(it, '  ')));
    lines.push('');
  }
  downloadBlob('brain-dump-' + backupStamp() + '.txt', lines.join('\n'), 'text/plain');
  setStatus('Readable copy saved');
}
function itemStamp(it) {
  return Number(it && (it.updatedAt || it.createdAt || it.doneAt || it.deletedAt) || 0);
}
function parseBackup(text) {
  const data = JSON.parse(text);
  const its = Array.isArray(data) ? data : (data.items || []);
  const cats = Array.isArray(data) ? [] : (data.categories || data.cats || []);
  if (!Array.isArray(its)) throw new Error('no items');
  return { items: its, categories: Array.isArray(cats) ? cats : [] };
}
function mergeBackup(incoming) {
  const byId = new Map();
  items.forEach(it => byId.set(String(it.id), it));
  (incoming.items || []).forEach(it => {
    if (!it || it.id == null) {
      it = Object.assign({}, it, { id: Date.now() + Math.random() });
    }
    const key = String(it.id);
    const cur = byId.get(key);
    if (!cur || itemStamp(it) >= itemStamp(cur)) byId.set(key, it);
  });
  items = [...byId.values()];
  const byName = new Map();
  categories.forEach(c => byName.set(String(c.name).toLowerCase(), c));
  (incoming.categories || []).forEach(c => {
    if (!c || !c.name) return;
    const k = String(c.name).toLowerCase();
    if (!byName.has(k)) { categories.push(c); byName.set(k, c); }
  });
  save(); render();
}
function replaceBackup(incoming) {
  items = (incoming.items || []).slice();
  categories = (incoming.categories || []).slice();
  save(); render();
}
function offerImportFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let incoming;
    try { incoming = parseBackup(String(reader.result || '')); }
    catch (e) { setStatus("That file doesn't look like a Brain Dump backup."); return; }
    document.querySelectorAll('.import-sheet').forEach(s => s.remove());
    const div = document.createElement('div');
    div.className = 'kind-sheet ask-sheet import-sheet';
    div.setAttribute('role', 'dialog');
    const n = (incoming.items || []).length;
    div.innerHTML = '<div class="kind-title">Add these notes?</div>' +
      '<div class="ask-body">' + n + ' item' + (n === 1 ? '' : 's') + ' in this file. Merge keeps what’s already on this device and skips duplicates. Replace throws out the current list and uses the file — that can’t be undone.</div>' +
      '<div class="ask-actions">' +
      '<button type="button" data-act="merge">Merge</button>' +
      '<button type="button" class="secondary" data-act="replace">Replace</button>' +
      '<button type="button" class="secondary" data-act="cancel">Cancel</button>' +
      '</div>';
    const finish = act => {
      div.remove();
      if (div._sheetDismiss) try { div._sheetDismiss(); } catch (e) {}
      if (act === 'merge') { mergeBackup(incoming); setStatus('Merged the backup into this notebook.'); }
      else if (act === 'replace') { replaceBackup(incoming); setStatus('Replaced this notebook with the backup.'); }
    };
    div.addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      finish(b.dataset.act);
    });
    document.body.appendChild(div);
    if (typeof wireDismiss === 'function') wireDismiss(div, () => finish('cancel'));
  };
  reader.readAsText(file);
}
if ($('exportBtn')) $('exportBtn').onclick = () => exportJSONBackup();
if ($('importFile')) $('importFile').onchange = ev => {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  offerImportFile(f);
};


function closeFeedbackSheet() {
  document.querySelectorAll('.feedback-sheet').forEach(s => {
    if (s._sheetDismiss) try { s._sheetDismiss(); } catch (e) {}
    s.remove();
  });
}
function feedbackBasicInfo() {
  const w = window.innerWidth || 0, h = window.innerHeight || 0;
  const sw = (screen && screen.width) || 0, sh = (screen && screen.height) || 0;
  let browser = (navigator.userAgent || 'unknown');
  try {
    const ua = navigator.userAgent || '';
    const isIOS = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
    const isAndroid = /Android/i.test(ua);
    const isMac = /Macintosh/.test(ua) && !isIOS;
    const isWin = /Windows/i.test(ua);
    let engine = 'browser';
    if (/Edg\//.test(ua)) engine = 'Edge';
    else if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) engine = 'Chrome';
    else if (/Safari\//.test(ua) && !/Chrome\//.test(ua)) engine = 'Safari';
    else if (/Firefox\//.test(ua)) engine = 'Firefox';
    const device = isIOS ? 'iPhone/iPad' : isAndroid ? 'Android' : isMac ? 'Mac' : isWin ? 'Windows' : 'device';
    browser = engine + ' on ' + device;
  } catch (e) {}
  const standalone = (typeof isStandaloneApp === 'function') ? isStandaloneApp() : false;
  return [
    'App: Brain Dump ' + (typeof APP_VERSION === 'string' ? APP_VERSION : 'v30') + (/\btest\b/i.test(location.pathname || '') ? ' TEST' : ''),
    'Browser: ' + browser,
    'Screen: ' + w + '×' + h + (sw && sh ? ' (device ' + sw + '×' + sh + ')' : ''),
    standalone ? 'Opened from Home Screen' : 'Opened in a browser tab'
  ].join('\n');
}
function feedbackTypeLabel(id) {
  return id === 'broke' ? 'Something broke' : id === 'idea' ? 'Idea' : 'Other';
}
function buildFeedbackMessage(type, text, includeInfo) {
  const lines = [];
  lines.push('Kind: ' + feedbackTypeLabel(type));
  lines.push('');
  lines.push((text || '').trim() || '(no message)');
  if (includeInfo) {
    lines.push('');
    lines.push('--');
    lines.push(feedbackBasicInfo());
  }
  return lines.join('\n');
}
function openFeedbackMailto(type, text, includeInfo) {
  const sub = 'Brain Dump feedback: ' + feedbackTypeLabel(type);
  const body = buildFeedbackMessage(type, text, includeInfo);
  const href = 'mailto:' + FEEDBACK_EMAIL +
    '?subject=' + encodeURIComponent(sub) +
    '&body=' + encodeURIComponent(body);
  return { href: href, subject: sub, body: body };
}
function copyFeedbackText(text) {
  const done = () => { if (typeof showVoiceToast === 'function') showVoiceToast('Copied. Paste it into an email if you need to.'); else setStatus('Copied'); };
  const fail = () => { if (typeof setStatus === 'function') setStatus("Couldn't copy — long-press and copy the text if you need to."); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(done).catch(fail);
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) done(); else fail();
  } catch (e) { fail(); }
}
function openFeedbackSheet() {
  closeFeedbackSheet();
  if (typeof closeHowTo === 'function') try { closeHowTo(); } catch (e) {}
  const div = document.createElement('div');
  div.className = 'kind-sheet ask-sheet feedback-sheet';
  div.setAttribute('role', 'dialog');
  div.setAttribute('aria-label', 'Send feedback');
  div.innerHTML =
    '<div class="kind-title">Tell us how it’s going</div>' +
    '<p class="fb-reachout">Your brain is yours, and we respect that. We can’t see anything you write in Brain Dump. We only see the feedback you send, along with your email so we can reach out. Just like you’re trying to learn and grow, so are we.</p>' +
    '<div class="fb-types" role="group" aria-label="What kind of note is this?">' +
      '<button type="button" class="secondary is-on" data-type="broke">Something broke</button>' +
      '<button type="button" class="secondary" data-type="idea">Idea</button>' +
      '<button type="button" class="secondary" data-type="other">Other</button>' +
    '</div>' +
    '<textarea id="fbText" placeholder="What’s on your mind?" maxlength="4000"></textarea>' +
    '<label class="fb-include"><input type="checkbox" id="fbInclude" checked> Include basic info (app version, this phone or computer, and screen size). Never your notes.</label>' +
    '<div class="ask-actions">' +
      '<button type="button" data-act="send">Send email</button>' +
      '<button type="button" class="secondary" data-act="copy">Copy</button>' +
      '<button type="button" class="secondary" data-act="cancel">Cancel</button>' +
    '</div>';
  let kind = 'broke';
  const setKind = (id) => {
    kind = id;
    div.querySelectorAll('.fb-types button').forEach(b => b.classList.toggle('is-on', b.dataset.type === id));
  };
  const finish = (act) => {
    const text = ((div.querySelector('#fbText') || {}).value || '');
    const include = !!(div.querySelector('#fbInclude') && div.querySelector('#fbInclude').checked);
    if (act === 'cancel') { closeFeedbackSheet(); return; }
    const packed = openFeedbackMailto(kind, text, include);
    if (act === 'copy') { copyFeedbackText(packed.body); return; }
    if (act === 'send') {
      try { window.location.href = packed.href; } catch (e) {}
      if (typeof showVoiceToast === 'function') showVoiceToast('If an email didn’t open, tap Copy and paste it.');
      closeFeedbackSheet();
    }
  };
  div.addEventListener('click', ev => {
    const typeBtn = ev.target.closest('.fb-types button');
    if (typeBtn) { ev.preventDefault(); setKind(typeBtn.dataset.type); return; }
    const b = ev.target.closest('.ask-actions button');
    if (b) { ev.preventDefault(); finish(b.dataset.act); }
  });
  document.body.appendChild(div);
  if (typeof wireDismiss === 'function') wireDismiss(div, closeFeedbackSheet);
  const ta = div.querySelector('#fbText');
  if (ta) setTimeout(() => ta.focus(), 50);
  return div;
}
try {
  window.__bdFeedback = {
    open: openFeedbackSheet,
    close: closeFeedbackSheet,
    build: buildFeedbackMessage,
    mailto: openFeedbackMailto,
    email: function () { return FEEDBACK_EMAIL; },
    info: feedbackBasicInfo
  };
} catch (e) {}

(function wireMoreMenu() {
  const btn = $('moreActions');
  const menu = $('moreMenu');
  if (!btn || !menu) return;
  const close = () => { menu.classList.remove('open'); menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const open = () => { menu.hidden = false; menu.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); };
  btn.addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation();
    if (menu.classList.contains('open')) close(); else open();
  });
  document.addEventListener('pointerdown', ev => {
    if (!menu.classList.contains('open')) return;
    if (menu.contains(ev.target) || btn.contains(ev.target)) return;
    close();
  });
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && menu.classList.contains('open')) close(); });
  if ($('howToToggle')) $('howToToggle').addEventListener('click', close);
  if ($('exportBtn')) $('exportBtn').addEventListener('click', close);
  if ($('feedbackBtn')) $('feedbackBtn').addEventListener('click', ev => { ev.preventDefault(); close(); openFeedbackSheet(); });
})();
if ($('footerFeedback')) $('footerFeedback').onclick = ev => { ev.preventDefault(); openFeedbackSheet(); };
if ($('howToFeedback')) $('howToFeedback').onclick = ev => { ev.preventDefault(); openFeedbackSheet(); };
if ($('howToWelcome')) $('howToWelcome').onclick = ev => { ev.preventDefault(); openIntro({ fromHowTo: true }); };


const INSTALL_TIP_KEY = 'bd-install-tip';
function isStandaloneApp() {
  try {
    return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
  } catch (e) { return false; }
}
function installTipDue() {
  if (isStandaloneApp()) return false;
  try {
    const last = +localStorage.getItem(INSTALL_TIP_KEY) || 0;
    if (!last) return true;
    return (Date.now() - last) >= 7 * 24 * 60 * 60 * 1000;
  } catch (e) { return true; }
}
function dismissInstallTip() {
  try { localStorage.setItem(INSTALL_TIP_KEY, String(Date.now())); } catch (e) {}
  const el = $('installTip');
  if (el) { el.classList.remove('is-on'); el.innerHTML = ''; }
}
function renderInstallTip() {
  const el = $('installTip');
  if (!el) return;
  if (!installTipDue()) { el.classList.remove('is-on'); el.innerHTML = ''; return; }
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (/Macintosh/.test(navigator.userAgent || '') && (navigator.maxTouchPoints || 0) > 1);
  const text = ios
    ? 'Add Brain Dump to your Home Screen so it opens like an app. On iPhone: tap Share, then Add to Home Screen.'
    : 'Add Brain Dump to your Home Screen so it opens like an app. Your browser’s menu usually has an “Add to Home Screen” or “Install” option.';
  el.innerHTML = '<div class="install-tip-text">' + text + '</div><button type="button" class="install-tip-dismiss" aria-label="Dismiss tip">✕</button>';
  el.classList.add('is-on');
  const d = el.querySelector('.install-tip-dismiss');
  if (d) d.onclick = dismissInstallTip;
}

try { renderInstallTip(); } catch (e) {}

// v29: first-time welcome (brand-new notebooks only) + backup reminder
const INTRO_SEEN_KEY = 'bd-intro-seen';
const BACKUP_AT_KEY = 'bd-backup-at';
const BACKUP_NUDGE_KEY = 'bd-backup-nudge';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
function bdNow() {
  if (typeof window.__bdNow === 'number' && isFinite(window.__bdNow)) return window.__bdNow;
  return Date.now();
}
function isCaptureMode() {
  try {
    const q = new URLSearchParams(location.search || '');
    if (q.get('capture') === '1') return true;
    if (typeof isCaptureUrl === 'function' && isCaptureUrl()) return true;
    const cap = document.getElementById('bdCapture');
    if (cap && cap.offsetParent !== null) return true;
  } catch (e) {}
  return false;
}
function notebookHasData() {
  try {
    if ((items || []).some(it => !it.deleted)) return true;
    if ((categories || []).length) return true;
  } catch (e) {}
  return false;
}
function introWasSeen() {
  try { return localStorage.getItem(INTRO_SEEN_KEY) === '1'; } catch (e) { return false; }
}
function markIntroSeen() {
  try { localStorage.setItem(INTRO_SEEN_KEY, '1'); } catch (e) {}
}
function introIsOpen() { return !!document.querySelector('.bd-intro-sheet'); }
function introDue() {
  if (introWasSeen()) return false;
  if (notebookHasData()) return false;
  if (isCaptureMode()) return false;
  return true;
}
function closeIntro() {
  document.querySelectorAll('.bd-intro-sheet').forEach(s => {
    if (s._sheetDismiss) try { s._sheetDismiss(); } catch (e) {}
    s.remove();
  });
  try { syncTipBubbles(); } catch (e) {}
}
function introHomeScreenCopy() {
  const ua = navigator.userAgent || '';
  const ios = /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  if (ios) return 'Add Brain Dump to your Home Screen so it opens like an app. On iPhone: tap Share, then Add to Home Screen.';
  return 'Add Brain Dump to your Home Screen so it opens like an app. In your browser menu, tap Install app or Add to Home Screen.';
}
const INTRO_STEPS = [
  { title: 'Dump anything here', body: 'Type a thought and tap Add, or tap the mic and say it out loud. Just get it out.' },
  { title: 'Put it where it belongs', body: 'Type or say “add milk to Ideas” and it’ll land on that page (we’ll make the page if it’s new). If you don’t name a page, it goes to Unsorted.' },
  { title: 'Add it to your Home Screen', body: introHomeScreenCopy() + ' During the trial, your notes are saved on your phone.' }
];
function openIntro(opts) {
  opts = opts || {};
  if (!opts.fromHowTo && isCaptureMode()) return null;
  closeIntro();
  if (typeof closeHowTo === 'function') try { closeHowTo(); } catch (e) {}
  if (typeof closeFeedbackSheet === 'function') try { closeFeedbackSheet(); } catch (e) {}
  let step = 0;
  const wrap = document.createElement('div');
  wrap.className = 'kind-sheet ask-sheet bd-intro-sheet';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-label', 'Welcome');
  const finish = (mark) => {
    if (mark) markIntroSeen();
    try { sessionStorage.setItem('bd-intro-just-closed', '1'); } catch (e) {}
    closeIntro();
    if (typeof renderInstallTip === 'function') try { renderInstallTip(); } catch (e) {}
  };
  const paint = () => {
    const s = INTRO_STEPS[step];
    const last = step === INTRO_STEPS.length - 1;
    const dots = '<div class="bd-intro-dots" aria-hidden="true">' + INTRO_STEPS.map((_, i) => '<span class="' + (i === step ? 'on' : '') + '"></span>').join('') + '</div>';
    wrap.innerHTML =
      dots +
      '<div class="kind-title">' + s.title + '</div>' +
      '<div class="bd-intro-body">' + s.body + '</div>' +
      '<div class="ask-actions">' +
        (last ? '<button type="button" data-act="done">Got it</button>' : '<button type="button" data-act="next">Next</button>') +
        '<button type="button" class="secondary" data-act="skip">Skip</button>' +
      '</div>';
  };
  wrap.addEventListener('click', ev => {
    const b = ev.target.closest('.ask-actions button');
    if (!b) return;
    ev.preventDefault();
    const act = b.dataset.act;
    if (act === 'next') { step = Math.min(step + 1, INTRO_STEPS.length - 1); paint(); return; }
    finish(true);
  });
  document.body.appendChild(wrap);
  if (opts.fromHowTo && typeof wireDismiss === 'function') wireDismiss(wrap, () => finish(false));
  paint();
  try { syncTipBubbles(); } catch (e) {}
  return wrap;
}
function maybeShowIntro() {
  if (!introDue()) return;
  openIntro();
}

// v32 Smart-starts: a thought bubble on things that have sat a couple of days.
var TIP_WAIT_MS = 2 * 24 * 60 * 60 * 1000;
var TIP_MAX_BUBBLES = 2;
var TIP_CALM_AFTER = 3;
var TIP_STATS_KEY = 'bd-tips-stats';
var TIP_INTRO_KEY = 'bd-tips-intro-seen';
var TIP_BUBBLE_SVG = '<svg viewBox="0 0 54 44" fill="none" aria-hidden="true"><path d="M13 16.5 C10.5 8.2, 21 3.4, 28 6.2 C32.5 2.0, 45.5 4.4, 46.5 13 C52.5 14.2, 53.2 24.2, 46.2 27.2 C43.4 33.6, 30.5 34.8, 24.2 30 C17.6 33.6, 8.6 27.8, 13 16.5 Z" fill="#fffaf1" stroke="#5a3a18" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="18.2" cy="33.6" rx="3.0" ry="2.5" fill="#fffaf1" stroke="#5a3a18" stroke-width="1.2"/><ellipse cx="12.4" cy="40.2" rx="2.0" ry="1.7" fill="#fffaf1" stroke="#5a3a18" stroke-width="1.1"/></svg><span class="bubble-label">idea?</span>';
var tipIntroId = null;   // the item showing the one-time line this session
var tipPopUntil = 0;     // render() can run twice on load, so the first bounce gets a short window
var tipPopId = null;

function tipStats() {
  try {
    const s = JSON.parse(localStorage.getItem(TIP_STATS_KEY) || '{}');
    return { opens: +s.opens || 0, dismisses: +s.dismisses || 0 };
  } catch (e) { return { opens: 0, dismisses: 0 }; }
}
function bumpTipStat(name) {
  const s = tipStats();
  s[name] += 1;
  try { localStorage.setItem(TIP_STATS_KEY, JSON.stringify(s)); } catch (e) {}
}
function tipsAreCalm() {
  const s = tipStats();
  return s.opens >= TIP_CALM_AFTER || s.dismisses >= TIP_CALM_AFTER;
}
function tipIntroSeen() {
  try { return localStorage.getItem(TIP_INTRO_KEY) === '1'; } catch (e) { return true; }
}
function itemCanHaveTip(it) {
  if (!it || it.ghosted || it.deleted || it.letGo || it.tipStepsAdded) return false;
  if (typeof it.createdAt !== 'number' || !isFinite(it.createdAt)) return false;
  return bdNow() - it.createdAt >= TIP_WAIT_MS;
}
function syncTipBubbles() {
  if (typeof listEl === 'undefined' || !listEl) return;
  listEl.querySelectorAll('.hint-bubble, .hint-intro').forEach(n => n.remove());
  listEl.querySelectorAll('.has-hint, .has-hint-intro').forEach(n => n.classList.remove('has-hint', 'has-hint-intro'));
  listEl.querySelectorAll('.has-hint-group').forEach(n => n.classList.remove('has-hint-group'));
  if (selectMode || isCaptureMode() || introIsOpen()) return;

  const picks = [];
  listEl.querySelectorAll('.item[data-id]').forEach(row => {
    if (row.classList.contains('ghosted') || row.querySelector('.unsure-decide')) return;
    const it = items.find(i => String(i.id) === row.dataset.id);
    if (!itemCanHaveTip(it) || !row.querySelector('.done') || !row.offsetParent) return;
    picks.push({ row, it });
  });
  picks.sort((a, b) => a.it.createdAt - b.it.createdAt);
  const chosen = picks.slice(0, TIP_MAX_BUBBLES);
  const calm = tipsAreCalm();

  if (!chosen.some(p => String(p.it.id) === tipIntroId)) tipIntroId = null;
  if (chosen.length && !calm && !tipIntroSeen()) {
    tipIntroId = String(chosen[0].it.id);
    tipPopId = tipIntroId;
    tipPopUntil = performance.now() + 500;
    try { localStorage.setItem(TIP_INTRO_KEY, '1'); } catch (e) {}
  }

  chosen.forEach(({ row, it }) => {
    const id = String(it.id);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hint-bubble' + (calm ? ' is-calm' : '') + (!calm && id === tipPopId && performance.now() < tipPopUntil ? ' is-pop' : '');
    btn.dataset.id = id;
    btn.setAttribute('aria-label', 'An idea for this item');
    btn.innerHTML = TIP_BUBBLE_SVG;
    row.insertBefore(btn, row.querySelector('.item-menu') || row.querySelector('.done'));
    row.classList.add('has-hint');
    for (let g = row.closest('.group-items'); g; g = g.parentElement && g.parentElement.closest('.group-items')) g.classList.add('has-hint-group');
    if (id === tipIntroId && !calm) {
      const line = document.createElement('span');
      line.className = 'hint-intro';
      line.textContent = 'I’ve got an idea for this one.';
      row.appendChild(line);
      row.classList.add('has-hint-intro');
    }
  });
}
function tipFor(text) {
  const t = String(text || '').toLowerCase();
  const has = re => re.test(t);
  if (has(/\b(clean|tidy|organi[sz]e|declutter|garage|closet|basement|attic)\b/)) return { title: 'Just one corner.', steps: ['Start with one corner', 'Sort it: keep, sell, donate, or toss', 'Stop after 20 minutes and call it a win'] };
  if (has(/\bcall\b/)) return { title: 'Let’s make this call easy.', steps: ['Find a quiet minute', 'Jot down what you want to say', 'Make the call'] };
  if (has(/\b(email|e-mail|reply|respond|text|message|write)\b/)) return { title: 'A rough one counts.', steps: ['Jot down the one thing you need to say', 'Write a rough version', 'Send it'] };
  if (has(/\b(buy|shop|shopping|groceries|order)\b/)) return { title: 'Let’s get this one handled.', steps: ['Write down exactly what you need', 'Pick when you’ll get it', 'Cross it off when you have it'] };
  if (has(/\b(fix|repair|replace)\b/)) return { title: 'One look at it first.', steps: ['Take a look and write down what’s wrong', 'Gather what you need', 'Set a time to fix it'] };
  if (has(/\b(pay|bill|bills|taxes|budget)\b/)) return { title: 'Ten minutes, tops.', steps: ['Find the paperwork', 'Set aside ten minutes', 'Take care of it and cross it off'] };
  return { title: 'Let’s make this one smaller.', steps: ['Pick the smallest first step', 'Set a time to do it', 'Cross it off when it’s done'] };
}
function closeTipSheet() { unwireDismiss('.smart-sheet'); }
function openTipSheet(id) {
  closeTipSheet();
  const it = items.find(i => String(i.id) === String(id));
  if (!itemCanHaveTip(it)) return;
  bumpTipStat('opens');
  tipIntroId = null;
  const tip = tipFor(it.text);
  const div = document.createElement('div');
  div.id = 'bdTipSheet';
  div.className = 'smart-sheet';
  div.setAttribute('role', 'dialog');
  div.setAttribute('aria-modal', 'true');
  div.setAttribute('aria-labelledby', 'bdTipTitle');
  div.innerHTML = `<div class="tip-kicker">Your friend</div>
    <div class="tip-title" id="bdTipTitle">${esc(tip.title)}</div>
    <div class="tip-item">“${esc(it.text)}”</div>
    <ol class="tip-steps">${tip.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <button type="button" data-act="add">Add these as steps</button>
    <button type="button" class="secondary" data-act="later">Not now</button>`;
  const leave = () => {
    closeTipSheet();
    syncTipBubbles();
    const back = listEl.querySelector(`.hint-bubble[data-id="${String(it.id).replace(/"/g, '')}"]`);
    if (back) back.focus({ preventScroll: true });
  };
  const dismiss = () => { bumpTipStat('dismisses'); leave(); };
  div.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]');
    if (!b) return;
    if (b.dataset.act === 'later') { dismiss(); return; }
    closeTipSheet();
    addTipSteps(it, tip.steps);
  });
  document.body.appendChild(div);
  wireDismiss(div, dismiss);
  syncTipBubbles();
  const primary = div.querySelector('[data-act="add"]');
  if (primary) primary.focus({ preventScroll: true });
}
// Added directly so the steps stay in this item's category and the dump dropdown is left alone.
function addTipSteps(it, steps) {
  const same = i => !i.deleted && !i.letGo && (i.category || '') === (it.category || '');
  const fresh = steps.filter(s => !items.some(i => same(i) && i.text === s));
  const at = items.indexOf(it);
  const now = bdNow();
  const rows = fresh.map(text => ({
    id: Date.now() + Math.random(),
    text,
    category: it.category,
    color: it.color,
    ghosted: false, finishedAt: null, due: null, deleted: false, selected: false,
    createdAt: now
  }));
  items.splice(at + 1, 0, ...rows);
  it.tipStepsAdded = true;
  save(); render();
  setStatus(rows.length ? 'Added ' + rows.length + (rows.length === 1 ? ' step' : ' steps') : 'Those steps are already here');
}

function notesForBackup() {
  try { return (items || []).some(it => !it.deleted); } catch (e) { return false; }
}
function firstNoteAt() {
  try {
    const times = (items || []).filter(it => !it.deleted).map(it => +it.createdAt || 0).filter(n => n > 0);
    return times.length ? Math.min.apply(null, times) : 0;
  } catch (e) { return 0; }
}
function lastBackupAt() {
  try { return +localStorage.getItem(BACKUP_AT_KEY) || 0; } catch (e) { return 0; }
}
function backupNudgeAt() {
  try { return +localStorage.getItem(BACKUP_NUDGE_KEY) || 0; } catch (e) { return 0; }
}
function backupReminderDue() {
  if (isCaptureMode()) return false;
  if (introIsOpen()) return false;
  if (!notesForBackup()) return false;
  const now = bdNow();
  if (backupNudgeAt() && (now - backupNudgeAt()) < THREE_DAYS_MS) return false;
  const last = lastBackupAt();
  const anchor = last || firstNoteAt() || now;
  return (now - anchor) >= THREE_DAYS_MS;
}
function markBackupSaved() {
  try { localStorage.setItem(BACKUP_AT_KEY, String(bdNow())); } catch (e) {}
  try { localStorage.removeItem(BACKUP_NUDGE_KEY); } catch (e) {}
  hideBackupReminder();
}
function backupLastLabel() {
  const last = lastBackupAt();
  if (!last) return 'No copy saved yet.';
  const days = Math.floor((bdNow() - last) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'Last saved copy: today.';
  if (days === 1) return 'Last saved copy: yesterday.';
  return 'Last saved copy: ' + days + ' days ago.';
}
function hideBackupReminder() {
  const el = $('bdBackupCard');
  if (!el) return;
  el.classList.remove('is-on');
  el.hidden = true;
  el.innerHTML = '';
  if (typeof renderInstallTip === 'function') try { renderInstallTip(); } catch (e) {}
}
function snoozeBackupReminder() {
  try { localStorage.setItem(BACKUP_NUDGE_KEY, String(bdNow())); } catch (e) {}
  hideBackupReminder();
}
function showBackupReminder() {
  const el = $('bdBackupCard');
  if (!el) return;
  const tip = $('installTip');
  if (tip) { tip.classList.remove('is-on'); tip.innerHTML = ''; }
  el.innerHTML =
    '<div class="bd-backup-text">Save a copy of your notes so nothing gets lost.</div>' +
    '<div class="bd-backup-actions">' +
      '<button type="button" data-act="save">Save backup</button>' +
      '<button type="button" class="secondary" data-act="later">Later</button>' +
    '</div>';
  el.hidden = false;
  el.classList.add('is-on');
  el.onclick = ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    ev.preventDefault();
    if (b.dataset.act === 'later') snoozeBackupReminder();
    if (b.dataset.act === 'save') {
      if (typeof exportJSONBackup === 'function') exportJSONBackup();
    }
  };
}
function maybeShowBackupReminder() {
  if (backupReminderDue()) showBackupReminder();
  else hideBackupReminder();
}
try {
  window.__bdIntro = { open: openIntro, close: closeIntro, due: introDue, isOpen: introIsOpen, seenKey: INTRO_SEEN_KEY };
  window.__bdBackup = { due: backupReminderDue, show: showBackupReminder, hide: hideBackupReminder, snooze: snoozeBackupReminder, mark: markBackupSaved, lastLabel: backupLastLabel, keyAt: BACKUP_AT_KEY, keyNudge: BACKUP_NUDGE_KEY };
} catch (e) {}
try { maybeShowIntro(); } catch (e) {}
try { if (!introIsOpen()) maybeShowBackupReminder(); } catch (e) {}


// Voice
let recognition = null;
let userWantsListening = false;
let listening = false;
let fatalVoiceError = false;
let networkVoiceErrors = 0;
let voiceRestartTimer = null;
let voiceBuffer = '';
let voiceBufferTimer = null;
const DEFAULT_VOICE_PAUSE_MS = 1500;
// iPhone/iPad (incl. iPadOS that reports as Mac). On iOS each recognition.start() can re-ask for the mic,
// so we run ONE session per mic tap and never auto-restart there.
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent || '') || (/Macintosh/.test(navigator.userAgent || '') && (navigator.maxTouchPoints || 0) > 1);
const IS_STANDALONE = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);
let voiceSessionStart = 0;
let quickEnds = 0;            // consecutive sessions that ended almost immediately (non-iOS restart guard)
const MAX_QUICK_ENDS = 5;
let voiceDone = new Set();    // result indexes already turned into items in this session
let voicePending = null;      // latest interim text not yet finalized { idx, text }
let voiceErrorShown = false;  // an error message is on screen; don't overwrite it on end

const VOICE_COLORS = {red:'#ff8a80',blue:'#82b1ff',green:'#b9f6ca',yellow:'#ffff8d',purple:'#ea80fc',orange:'#ffd180'};
const UNSUPPORTED_VOICE_MSG = 'Voice isn’t available in this browser. Try Safari or Chrome, then tap the mic.';

function resetMicUI(clearStatus) {
  listening = false;
  micBtn.textContent = '🎤';
  micBtn.setAttribute('aria-label', 'Start voice capture');
  micBtn.classList.remove('listening');
  if (clearStatus) setStatus('');
  if (typeof syncCaptureMicUI === 'function') try { syncCaptureMicUI(); } catch (e) {}
}

// Friendly, non-blocking messages for speech errors (no popups).
function voiceErrorInfo(err) {
  switch (err) {
    case 'no-speech': return { msg: IS_IOS ? "Didn't catch that. Tap the mic to try again." : '', stop: false };
    case 'aborted': return { msg: '', stop: false };
    case 'not-allowed':
      return { stop: true, msg: IS_IOS
        ? (IS_STANDALONE ? 'The mic is blocked. Tap the mic and choose Allow.'
                         : 'The mic is blocked. Allow the microphone, then tap the mic again.')
        : 'The mic is blocked. Allow the microphone, then tap the mic again.' };
    case 'service-not-allowed':
      return { stop: true, msg: IS_IOS
        ? 'iPhone speech is off. Turn on Settings → General → Keyboard → Enable Dictation, then tap the mic.'
        : 'Speech is not allowed in this browser right now. Tap the mic to try again.' };
    case 'audio-capture':
      return { stop: true, msg: 'The mic is busy or not available. Close anything else using it (a call, Voice Memos, keyboard dictation) and tap the mic again.' };
    case 'language-not-supported':
      return { stop: true, msg: "Voice isn't available for English on this device." };
    default:
      return { stop: false, msg: 'Voice hiccup. Tap the mic to try again.' };
  }
}

// Small, non-blocking toast with an optional Undo button.
let voiceToastTimer = null;
function showVoiceToast(msg, undoFn, ms) {
  let el = document.getElementById('voiceToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voiceToast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:9999;width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;white-space:normal;background:rgba(40,32,24,.92);color:#fff;border-radius:12px;padding:10px 14px;font-size:15px;line-height:1.4;display:none;align-items:center;gap:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
    document.body.appendChild(el);
  }
  el.innerHTML = '';
  const span = document.createElement('span'); span.className = 'vt-msg'; span.textContent = msg; span.title = msg;
  span.style.cssText = 'min-width:0;overflow:hidden;white-space:normal;overflow-wrap:break-word;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;'; el.appendChild(span);
  if (undoFn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'vt-undo'; b.textContent = 'Undo';
    b.style.cssText = 'flex:0 0 auto;background:none;border:1px solid rgba(255,255,255,.6);color:#fff;border-radius:8px;padding:6px 12px;font-size:15px;min-height:36px;cursor:pointer;';
    b.onclick = () => { hideVoiceToast(); try { undoFn(); } catch (e) {} };
    el.appendChild(b);
  }
  el.style.display = 'flex';
  if (voiceToastTimer) clearTimeout(voiceToastTimer);
  voiceToastTimer = setTimeout(hideVoiceToast, ms || 6000);
}
function hideVoiceToast() {
  const el = document.getElementById('voiceToast');
  if (el) el.style.display = 'none';
  if (voiceToastTimer) { clearTimeout(voiceToastTimer); voiceToastTimer = null; }
}
function shortQuote(t) { t = String(t || ''); return '“' + (t.length > 40 ? t.slice(0, 38) + '…' : t) + '”'; }

// Normalize what speech gave us: lowercase, no punctuation, single spaces.
function voiceNorm(t) {
  return String(t || '').toLowerCase().replace(/[“”"'’.,!?…:;]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// A bare "remove the last thing" command: scratch that / delete / delete that / never mind / remove that …
function isBareScratch(t) {
  const s = stripVoiceWrap(voiceNorm(t));
  return /^(?:scratch that|scratch this|scratch it|delete|delete that|delete this|delete it|delete that one|never ?mind|remove that|remove it|remove this)$/.test(s);
}
// "buy milk scratch that" / "buy milk. Scratch that. call mom" → drop the phrase said right before it.
// Returns null when there's nothing to do here.
function splitScratch(raw) {
  const re = /\b(?:scratch that|delete that)\b[\s.,!?…]*/gi;
  let m, last = null;
  while ((m = re.exec(raw))) last = { idx: m.index, end: m.index + m[0].length };
  if (!last) return null;
  const before = raw.slice(0, last.idx).replace(/[\s.,!?…]+$/g, '').trim();
  const after = raw.slice(last.end).replace(/^[\s.,!?…]+/g, '').trim();
  if (!before) {
    if (!after || /^move it to\b/i.test(after)) return null; // existing commands handle these
    return { keep: [], dropped: null, after, leading: true };
  }
  const sentences = before.split(/[.!?…]+\s+/).map(s => s.trim()).filter(Boolean);
  const lastSentence = sentences.pop() || '';
  const bits = splitVoiceParts(lastSentence);
  const dropped = bits.pop() || lastSentence;
  const keep = sentences.concat(bits);
  return { keep, dropped, after, leading: false };
}

function getLastAdded() {
  if (lastAddedId != null) {
    const it = items.find(i => i.id === lastAddedId && !i.deleted);
    if (it) return it;
  }
  return items.find(i => !i.deleted) || null;
}

function refreshLastAdded() {
  const it = items.find(i => !i.deleted);
  lastAddedId = it ? it.id : null;
}

function cleanTranscript(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/\b(um+|uh+|erm+|er+|hmm+|ah+|huh+)\b/gi, ' ');
  s = s.replace(/(^|[,;]\s*)like\s*(?=[,;]|$)/gi, '$1');
  s = s.replace(/^\s*like\s+/i, '');
  s = s.replace(/[\s.,!?…]+$/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return { raw: s, t: s.toLowerCase() };
}

const WORD_NUMS = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};

// Longest first so "i have to" wins over a bare "have to".
const INTENT_SRC = "(?:i['’]?ve\\s+got\\s+to|i\\s+have\\s+got\\s+to|i['’]?m\\s+going\\s+to|i\\s+am\\s+going\\s+to|i['’]?m\\s+gonna|i\\s+am\\s+gonna|i\\s+have\\s+to|i\\s+need\\s+to|i\\s+want\\s+to|i\\s+got\\s+to|i\\s+gotta|i\\s+should(?!n)|i\\s+must|don['’]?t\\s+forget\\s+to|remember\\s+to|have\\s+to|need\\s+to)";

function splitVoiceParts(cleanedRaw) {
  const parts = [];
  cleanedRaw.split(/\s*\bnext\b\s*/i).forEach(chunk => {
    chunk.split(/\s*,\s*/).forEach(bit => {
      const p = bit.trim().replace(/[\s.,!?…]+$/g, '').trim();
      if (p) parts.push(p);
    });
  });
  return parts;
}

function toActionText(s) {
  s = String(s || '').trim().replace(/[\s.,!?…]+$/g, '').trim();
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function splitIntentPhrases(text) {
  const re = new RegExp('(?:^|\\s+)(' + INTENT_SRC + ')(?:\\s+|$)', 'gi');
  const parts = [];
  let lastIndex = 0;
  let found = false;
  let m;
  const src = String(text || '');
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    found = true;
    const before = src.slice(lastIndex, m.index).trim();
    if (before) parts.push(toActionText(before));
    lastIndex = m.index + m[0].length;
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  const rest = src.slice(lastIndex).trim();
  if (rest) parts.push(toActionText(rest));
  if (!found) return null;
  return parts.filter(Boolean);
}

function looksIncomplete(text) {
  const t = String(text || '').toLowerCase().trim().replace(/[\s.,!?…]+$/g, '');
  if (!t) return true;
  if (new RegExp('(?:' + INTENT_SRC + ')$', 'i').test(t)) return true;
  if (/\b(?:to|and|or|the|a|an|my|our|your|for|with|of|in|on|at)\s*$/i.test(t)) return true;
  const stripped = t.replace(new RegExp('^(?:' + INTENT_SRC + ')\\s*', 'i'), '');
  if (stripped !== t) {
    const words = stripped.split(/\s+/).filter(Boolean);
    if (words.length <= 2) return true;
  }
  return false;
}

function getVoicePauseMs() {
  const el = $('voicePause');
  if (!el) return DEFAULT_VOICE_PAUSE_MS;
  const v = parseInt(el.value, 10);
  return Number.isFinite(v) ? v : DEFAULT_VOICE_PAUSE_MS;
}

function flushVoiceBuffer() {
  if (voiceBufferTimer) { clearTimeout(voiceBufferTimer); voiceBufferTimer = null; }
  const text = voiceBuffer.trim();
  voiceBuffer = '';
  if (text) handleVoice(text);
}

function queueFinalTranscript(text) {
  text = String(text || '').trim();
  if (!text) return;
  const pause = getVoicePauseMs();
  if (!pause) { handleVoice(text); return; }
  if (voiceBuffer && isBareScratch(text)) {
    // The thing to scratch hasn't been saved yet: drop it instead of saving then deleting.
    const pending = voiceBuffer;
    voiceBuffer = '';
    if (voiceBufferTimer) { clearTimeout(voiceBufferTimer); voiceBufferTimer = null; }
    handleVoice(pending + ' scratch that');
    return;
  }
  if (voiceBuffer && !looksIncomplete(voiceBuffer)) {
    const prev = voiceBuffer;
    voiceBuffer = '';
    handleVoice(prev);
  }
  voiceBuffer = voiceBuffer ? (voiceBuffer + ' ' + text).replace(/\s+/g, ' ').trim() : text;
  if (voiceBufferTimer) clearTimeout(voiceBufferTimer);
  voiceBufferTimer = setTimeout(() => {
    voiceBufferTimer = null;
    flushVoiceBuffer();
  }, pause);
  if (userWantsListening) setStatus('Listening… ' + voiceBuffer);
}

function stripVoiceWrap(t) {
  return String(t || '')
    .replace(/[\s.,!?…]+$/g, '')
    .replace(/^(?:(?:please|okay|ok|alright|all right|hey|so|just|can you|could you|would you|will you|go ahead and)[,\s]+)+/i, '')
    .replace(/\s+(?:please|thanks|thank you)$/i, '')
    .trim();
}

function parseDeleteCount(t) {
  let s = String(t || '').toLowerCase().replace(/[\s.,!?…]+$/g, '').replace(/\s+(?:please|thanks|thank you)$/i, '').trim();
  const last = s.match(/\bdelete(?:\s+the)?\s+last(?:\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+))?(?:\s+(?:items?|things?|ones?))?$/);
  if (last) {
    if (!last[1]) return 1;
    if (WORD_NUMS[last[1]] != null) return WORD_NUMS[last[1]];
    const n = parseInt(last[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  s = stripVoiceWrap(s);
  if (/^delete(?:\s+that|\s+it)(?:\s+one)?$/.test(s)) return 1;
  if (/^(?:scratch that|never mind)$/.test(s)) return 1;
  if (isBareScratch(s)) return 1;
  return null;
}

function deleteLastItems(n) {
  n = Math.max(0, n | 0);
  const live = items.filter(i => !i.deleted);
  let cut;
  if (n === 1) { const t = getLastAdded(); cut = t ? [t] : []; }
  else cut = live.slice(0, n);
  cut.forEach(it => { it.deleted = true; it.deletedAt = Date.now(); });
  refreshLastAdded();
  if (cut.length) { save(); render(); }
  const msg = cut.length ? (cut.length === 1 ? 'Removed ' + shortQuote(cut[0].text) : 'Removed ' + cut.length + ' items') : 'No items to delete';
  setStatus(cut.length ? ('Removed ' + cut.length + ' item' + (cut.length === 1 ? '' : 's')) : 'No items to delete');
  if (cut.length) {
    showVoiceToast(msg, () => {
      cut.forEach(it => { it.deleted = false; delete it.deletedAt; });
      lastAddedId = cut[0].id;
      save(); render();
      setStatus('Brought back');
    });
  }
  return cut.length;
}


function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[\s.,!?…]+$/g, '').replace(/[.,!?…]/g, '').replace(/\s+/g, ' ').trim();
}

function ensureCategory(name, color) {
  name = String(name || '').trim().replace(/[\s.,!?…]+$/g, '').trim();
  if (!name) return null;
  let c = categories.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    c = { name, color: color || PALETTE[categories.length % PALETTE.length] };
    categories.push(c);
  } else if (color) {
    c.color = color;
    items.forEach(it => {
      if ((it.category || '').toLowerCase() === c.name.toLowerCase()) it.color = color;
    });
  }
  return c;
}

// Used only by explicit voice commands (move X to Y). Do not use this to hijack
// a typed or voiced add, and do not use it to attach due dates (those need an
// exact leftover-name match — see findItemByExactText).
function findItemByText(q) {
  const n = normalizeName(q);
  if (!n) return null;
  const live = items.filter(i => !i.deleted);
  const exact = live.find(i => normalizeName(i.text) === n);
  if (exact) return exact;
  const cands = live.filter(i => {
    const t = normalizeName(i.text);
    return t.includes(n) || n.includes(t);
  });
  if (!cands.length) return null;
  const last = getLastAdded();
  if (last && cands.includes(last)) return last;
  cands.sort((a, b) => Math.abs(normalizeName(a.text).length - n.length) - Math.abs(normalizeName(b.text).length - n.length));
  return cands[0];
}

// Due-date phrases attach to an existing item only on an exact name match
// (case/whitespace-insensitive). No fuzzy or partial matching.
function findItemByExactText(q) {
  const n = normalizeName(q);
  if (!n) return null;
  const live = items.filter(i => !i.deleted && normalizeName(i.text) === n);
  if (!live.length) return null;
  const last = typeof getLastAdded === 'function' ? getLastAdded() : null;
  if (last && live.includes(last)) return last;
  live.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return live[0];
}

function setItemDue(item, days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  item.due = d.toISOString();
}


// ---- Quick capture routing ----
let captureOpen = false;
let lastDestName = '';
try { lastDestName = localStorage.getItem('bd-last-dest') || ''; } catch (e) {}

function destMatches(name) {
  const n = typeof normalizeName === 'function' ? normalizeName(name) : String(name || '').toLowerCase().trim();
  if (!n) return [];
  const out = categories.filter(c => (typeof normalizeName === 'function' ? normalizeName(c.name) : String(c.name).toLowerCase()) === n);
  if (n === 'unsorted' && !out.some(c => isUnsortedName(c.name))) out.push(getUnsortedCat());
  return out;
}

function pickRecentDest(matches) {
  if (!matches || !matches.length) return null;
  if (lastDestName) {
    const hit = matches.find(c => c.name === lastDestName);
    if (hit) return hit;
  }
  let best = matches[0], bestT = -1;
  matches.forEach(c => {
    (items || []).forEach(it => {
      if (it.deleted || it.letGo) return;
      if (it.category === c.name) {
        const t = it.createdAt || 0;
        if (t >= bestT) { bestT = t; best = c; }
      }
    });
  });
  return best;
}

// Look up dest across top-level categories AND sub-categories (exact, case-insensitive).
// Unique match wins. Multiple: prefer a top-level; else most recently used.
// allowCreate: only when nothing matches anywhere, make a new top-level page.
function resolveCaptureDest(name, allowCreate) {
  const matches = destMatches(name);
  if (matches.length === 1) return { cat: matches[0], how: 'unique' };
  if (matches.length > 1) {
    const tops = matches.filter(c => !c.parent);
    if (tops.length === 1) return { cat: tops[0], how: 'toplevel' };
    if (tops.length > 1) return { cat: pickRecentDest(tops), how: 'recent' };
    return { cat: pickRecentDest(matches), how: 'recent' };
  }
  if (allowCreate && String(name || '').trim()) {
    const r = placeCategory(String(name).trim(), '');
    if (r && r.cat) return { cat: r.cat, how: 'created' };
  }
  return { cat: getUnsortedCat(), how: 'unsorted' };
}

function parseAddToDest(raw, opts) {
  opts = opts || {};
  const t = String(raw || '').trim();
  if (!t) return null;
  let m = t.match(/^(?:please[, ]+)?(?:add|put)\s+(.+?)\s+(?:to|in|into)\s+(.+)$/i);
  if (m) return { text: m[1].trim(), dest: m[2].trim().replace(/[\s.,!?…]+$/g, ''), explicit: true };
  if (opts.allowBareTo) {
    m = t.match(/^(.+?)\s+to\s+(.+)$/i);
    if (m) {
      const dest = m[2].trim().replace(/[\s.,!?…]+$/g, '');
      if (dest && destMatches(dest).length) return { text: m[1].trim(), dest, explicit: false };
    }
  }
  return null;
}

function rememberDest(name) {
  if (!name || isUnsortedName(name)) return;
  lastDestName = name;
  try { localStorage.setItem('bd-last-dest', name); } catch (e) {}
}

function captureToast(dest, how) {
  dest = dest || getUnsortedCat();
  const parent = dest && dest.name && typeof parentOf === 'function' ? parentOf(dest.name) : '';
  let msg;
  if (!dest || isUnsortedName(dest.name)) {
    msg = uiCopyText('capturedUnsorted', null, 'Tossed it in Unsorted.');
  } else if (parent) {
    msg = 'Got it — in ' + dest.name + ' (under ' + parent + ').';
    if (how === 'recent') msg = 'Got it — in ' + dest.name + ' (under ' + parent + '). That’s the one you used last.';
  } else {
    msg = 'Got it — in ' + dest.name + '.';
    if (how === 'toplevel') msg = 'Got it — in ' + dest.name + ' (the main page).';
    else if (how === 'created') msg = 'Got it — in ' + dest.name + '. I made that page.';
    else if (how === 'recent') msg = 'Got it — in ' + dest.name + '. That’s the one you used last.';
  }
  showVoiceToast(msg, null, 4500);
  setStatus(msg);
  const cap = $('bdCapStatus');
  if (cap) cap.textContent = msg;
  return msg;
}

function fileCapturedItem(text, destName, opts) {
  opts = opts || {};
  text = String(text || '').trim();
  if (!text) return null;
  let dest = null, how = 'unsorted';
  if (destName) {
    const r = resolveCaptureDest(destName, opts.allowCreate !== false && opts.explicit !== false);
    dest = r.cat;
    how = r.how;
    if (opts.allowCreate === false && how === 'created') {
      dest = getUnsortedCat();
      how = 'unsorted';
    }
  } else {
    dest = getUnsortedCat();
    how = 'unsorted';
  }
  const catName = dest && dest.name ? dest.name : UNSORTED;
  const it = addItem(text, { category: catName });
  if (it) rememberDest(catName);
  captureToast(dest, how);
  return it;
}

function handleCaptureText(raw) {
  const parsed = parseAddToDest(raw, { allowBareTo: true });
  if (parsed && parsed.text) {
    return fileCapturedItem(parsed.text, parsed.dest, { allowCreate: !!parsed.explicit, explicit: parsed.explicit });
  }
  let text = String(raw || '').trim();
  text = text.replace(/^(?:please[, ]+)?(?:add|put)\s+/i, '').trim() || text;
  return fileCapturedItem(text, null, { allowCreate: false });
}

function applyCommand(cleanedRaw) {
  const t = cleanedRaw.toLowerCase().replace(/[\s.,!?…]+$/g, '').trim();
  if (!t) return true;

  let m;

  m = t.match(/^scratch that(?:,)?\s+move it to\s+(.+)$/) || stripVoiceWrap(t).match(/^scratch that(?:,)?\s+move it to\s+(.+)$/);
  if (m) {
    const cat = ensureCategory(m[1]);
    const target = getLastAdded();
    if (cat && target) {
      target.category = cat.name;
      target.color = cat.color;
      save(); render();
      setStatus('Moved to ' + cat.name);
    } else {
      setStatus(target ? 'No category name' : 'No item to move');
    }
    return true;
  }

  // "delete the last 2/two/two items", "delete last two", "delete that", "scratch that"
  if (!/^correction\b/.test(t) && !/^make category\b/.test(t) && !/^category\s+/.test(t) && !/^sub[\s-]?category\b/.test(t) && !/^move\s+/.test(t) && !/^give\s+/.test(t) && !/^set\s+a\s+deadline\b/.test(t) && t !== 'due tomorrow' && !/\s+due tomorrow$/.test(t)) {
    const delN = parseDeleteCount(t);
    if (delN != null) {
      deleteLastItems(delN);
      return true;
    }
  }

  m = t.match(/^correction\s*[.:,-]?\s*(.*)$/) || stripVoiceWrap(t).match(/^correction\s*[.:,-]?\s*(.*)$/);
  if (m && /^(?:please[, ]+)?correction\b/.test(t)) {
    const replacement = (m[1] || '').trim().replace(/[\s.,!?…]+$/g, '').trim();
    const target = getLastAdded();
    if (replacement) {
      if (target) {
        target.text = (cleanedRaw.replace(/^(?:please[, ]+)?correction\s*[.:,-]?\s*/i, '').trim() || replacement).replace(/[\s.,!?…]+$/g, '').trim();
        save(); render();
        setStatus('Corrected');
      } else {
        addItem(cleanedRaw.replace(/^(?:please[, ]+)?correction\s*[.:,-]?\s*/i, '').trim());
      }
      pendingCorrection = false;
    } else if (target) {
      pendingCorrection = true;
      setStatus('Say the correction');
    } else {
      pendingCorrection = false;
      setStatus('No item to correct');
    }
    return true;
  }

  m = t.match(/^make category\s+(.+)\s+(red|blue|green|yellow|purple|orange)$/) || stripVoiceWrap(t).match(/^make category\s+(.+)\s+(red|blue|green|yellow|purple|orange)$/);
  if (m) {
    const colName = m[2];
    const col = VOICE_COLORS[colName];
    const c = ensureCategory(m[1], col);
    if (c) {
      currentCat = c.name;
      save(); render();
      setStatus(c.name + ' → ' + colName);
    }
    return true;
  }

  // "subcategory estimates" (inside the current category) or "subcategory estimates under acculynx"
  m = t.match(/^sub[\s-]?category\s+(.+?)(?:\s+under\s+(.+))?$/) || stripVoiceWrap(t).match(/^sub[\s-]?category\s+(.+?)(?:\s+under\s+(.+))?$/);
  if (m) {
    let parent = m[2] ? (findCatCI(m[2]) || ensureCategory(m[2])) : (currentCat ? findCat(currentCat) : null);
    if (!parent) { setStatus('Pick a category first, then say “subcategory …”'); return true; }
    const r = placeCategory(m[1], parent.name);
    if (r.error) { setStatus(r.error); return true; }
    if (collapsed[parent.name]) collapsed[parent.name] = false;
    currentCat = r.cat.name;
    save(); render();
    setStatus('Subcategory ' + catPath(r.cat.name));
    return true;
  }

  m = t.match(/^category\s+(.+)$/) || stripVoiceWrap(t).match(/^category\s+(.+)$/);
  if (m) {
    const c = ensureCategory(m[1]);
    if (c) {
      currentCat = c.name;
      save(); render();
      setStatus('Category ' + c.name);
    }
    return true;
  }

  m = t.match(/^move\s+(.+?)\s+to\s+(.+)$/) || stripVoiceWrap(t).match(/^move\s+(.+?)\s+to\s+(.+)$/);
  if (m) {
    const cat = ensureCategory(m[2]);
    const target = findItemByText(m[1]);
    if (cat && target) {
      target.category = cat.name;
      target.color = cat.color;
      save(); render();
      setStatus('Moved to ' + cat.name);
    } else {
      setStatus(target ? 'No category name' : 'No matching item to move');
    }
    return true;
  }

  m = t.match(/^give\s+(.+?)\s+a\s+deadline\s+of\s+(\d+)\s+days?$/) || stripVoiceWrap(t).match(/^give\s+(.+?)\s+a\s+deadline\s+of\s+(\d+)\s+days?$/);
  if (m) {
    const days = +m[2];
    let target = findItemByExactText(m[1]);
    if (!target) {
      const nameMatch = cleanedRaw.match(/give\s+(.+?)\s+a\s+deadline\s+of\s+\d+\s+days?/i);
      const created = addItem((nameMatch ? nameMatch[1] : m[1]).trim());
      target = created || getLastAdded();
    }
    if (target) {
      setItemDue(target, days);
      save(); render();
      setStatus('Due set');
    }
    return true;
  }

  m = t.match(/^set\s+a\s+deadline\s+of\s+(\d+)\s+days?$/) || stripVoiceWrap(t).match(/^set\s+a\s+deadline\s+of\s+(\d+)\s+days?$/);
  if (m) {
    const target = getLastAdded();
    if (target) {
      setItemDue(target, +m[1]);
      save(); render();
      setStatus('Due set');
    } else {
      setStatus('No item to set a due date');
    }
    return true;
  }

  if (/^due tomorrow$/.test(t) || /^due tomorrow$/.test(stripVoiceWrap(t))) {
    const target = getLastAdded();
    if (target) {
      setItemDue(target, 1);
      save(); render();
      setStatus('Due set');
    } else {
      setStatus('No item to set a due date');
    }
    return true;
  }

  m = t.match(/^(.+)\s+due tomorrow$/);
  if (m) {
    let target = findItemByExactText(m[1]);
    if (!target) {
      const nameMatch = cleanedRaw.match(/^(.+)\s+due tomorrow$/i);
      addItem((nameMatch ? nameMatch[1] : m[1]).trim());
      target = getLastAdded();
    }
    if (target) {
      setItemDue(target, 1);
      save(); render();
      setStatus('Due set');
    }
    return true;
  }

  // “add X to Ideas” / “put X in Home” — file to a matching cat or sub (or create a top-level page).
  // Bare “X to Ideas” is handled only while quick capture is open, so ordinary sentences stay items.
  const cap = parseAddToDest(cleanedRaw, { allowBareTo: !!captureOpen });
  if (cap && cap.text) {
    fileCapturedItem(cap.text, cap.dest, { allowCreate: cap.explicit, explicit: cap.explicit });
    return true;
  }

  return false;
}

function handleVoice(raw) {
  const cleaned = cleanTranscript(raw);
  if (!cleaned.t) { setStatus(userWantsListening ? 'Listening…' : ''); return; }

  if (pendingCorrection) {
    pendingCorrection = false;
    const target = getLastAdded();
    if (target) {
      target.text = cleaned.raw;
      save(); render();
      setStatus('Corrected');
      return;
    }
  }

  const sc = parseDeleteCount(cleaned.raw) == null ? splitScratch(cleaned.raw) : null;
  if (sc) {
    if (sc.leading) {
      // "scratch that buy eggs" → remove the last item, then capture the rest
      deleteLastItems(1);
      handleVoice(sc.after);
      return;
    }
    sc.keep.forEach(k => handleVoice(k));
    if (sc.dropped) {
      const dropped = sc.dropped;
      setStatus('Dropped ' + shortQuote(dropped));
      showVoiceToast('Dropped ' + shortQuote(dropped), () => { addItem(dropped); setStatus('Added back'); });
    }
    if (sc.after) handleVoice(sc.after);
    else if (userWantsListening) setTimeout(() => { if (userWantsListening && /^Dropped/.test(micStatus.textContent || '')) setStatus('Listening…'); }, 1500);
    return;
  }

  if (applyCommand(cleaned.raw)) return;

  if (captureOpen) {
    handleCaptureText(cleaned.raw);
    if (userWantsListening) setStatus('Listening…');
    return;
  }

  const chunks = splitVoiceParts(cleaned.raw);
  const parts = [];
  chunks.forEach(chunk => {
    const intentParts = splitIntentPhrases(chunk);
    if (intentParts && intentParts.length) parts.push(...intentParts);
    else parts.push(chunk);
  });

  const changed = parts.length > 1 || (parts.length === 1 && parts[0] !== cleaned.raw);
  if (changed) {
    parts.forEach(part => {
      if (!part) return;
      if (!applyCommand(part)) addItem(part);
    });
    setStatus(userWantsListening ? 'Listening…' : '');
    return;
  }

  addItem(cleaned.raw);
  setStatus(userWantsListening ? 'Listening…' : '');
}


