/* ═══════════════════════════════════════════════════════════════
   CHAT ROOM — Firebase + PeerJS (WebRTC) — FULL (v4)
   ═══════════════════════════════════════════════════════════════ */
(function () {
"use strict";

const firebaseConfig = {
  apiKey:      "AIzaSyCqKKmfHbyMrLwxthpY7oYAoNqbekWBOuYk",
  authDomain:  "chat-site-12345.firebaseapp.com",
  databaseURL: "https://chat-site-12345-default-rtdb.firebaseio.com",
  projectId:   "chat-site-12345",
  appId:       "1:660571630838:web:7be88b3d899720ba1590d7"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

/* ═══════════════════════════════════════════════════════════════
   CUSTOM DIALOG / TOAST (resilient)
   ═══════════════════════════════════════════════════════════════ */
const UI = (() => {
  const missing = !document.getElementById('appDialog') ||
                  !document.getElementById('appDialogOk') ||
                  !document.getElementById('appDialogCancel') ||
                  !document.getElementById('appDialogTitle') ||
                  !document.getElementById('appDialogMessage');
  if (missing) {
    console.warn('[UI] Dialog DOM missing — falling back to native');
    return {
      alert:   (msg) => { try { window.alert(msg); } catch(e){} },
      confirm: (msg) => { try { return Promise.resolve(window.confirm(msg)); } catch(e){ return Promise.resolve(false); } },
      prompt:  (msg, def='') => { try { return Promise.resolve(window.prompt(msg, def)); } catch(e){ return Promise.resolve(null); } },
      toast:   (msg) => console.log('[toast]', msg)
    };
  }
  const backdrop = document.getElementById('appDialog');
  const toastEl  = document.getElementById('appToast');
  let resolver = null;

  function getEls() {
    return {
      title:  document.getElementById('appDialogTitle'),
      msg:    document.getElementById('appDialogMessage'),
      input:  document.getElementById('appDialogInput'),
      ok:     document.getElementById('appDialogOk'),
      cancel: document.getElementById('appDialogCancel')
    };
  }
  function close(result) {
    backdrop.classList.remove('show');
    if (resolver) { const r = resolver; resolver = null; r(result); }
  }
  function open(opts) {
    return new Promise(resolve => {
      resolver = resolve;
      const els = getEls();
      const { title, msg, input, ok, cancel } = els;
      title.textContent = opts.title || '';
      msg.textContent   = opts.message || '';
      msg.style.display = opts.message ? '' : 'none';
      if (opts.type === 'prompt') {
        input.style.display = '';
        input.value = opts.defaultValue || '';
        input.placeholder = opts.placeholder || '';
      } else {
        input.style.display = 'none';
      }
      ok.textContent = opts.okText || 'OK';
      cancel.textContent = opts.cancelText || 'Cancel';
      cancel.style.display = (opts.type === 'alert') ? 'none' : '';
      if (opts.danger) ok.classList.add('danger'); else ok.classList.remove('danger');
      backdrop.classList.add('show');
      setTimeout(() => { if (opts.type === 'prompt') input.focus(); else ok.focus(); }, 50);

      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        ok.removeEventListener('click', onOk);
        cancel.removeEventListener('click', onCancel);
        backdrop.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        close(val);
      };
      const onOk = () => { if (opts.type === 'prompt') finish(input.value); else finish(true); };
      const onCancel = () => finish(opts.type === 'prompt' ? null : false);
      const onBackdrop = (e) => { if (e.target === backdrop && opts.type !== 'alert') finish(opts.type === 'prompt' ? null : false); };
      const onKey = (e) => {
        if (e.key === 'Enter' && opts.type !== 'alert') { e.preventDefault(); if (opts.type === 'prompt') finish(input.value); else finish(true); }
        else if (e.key === 'Escape' && opts.type !== 'alert') { e.preventDefault(); finish(opts.type === 'prompt' ? null : false); }
      };
      ok.addEventListener('click', onOk);
      cancel.addEventListener('click', onCancel);
      backdrop.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }
  let toastTimer = null;
  function toast(msg, type = 'info', dur = 3000) {
    if (!toastEl) { console.log('[toast]', msg); return; }
    toastEl.className = 'app-toast ' + type;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
  }
  return {
    alert:   (m, o={}) => open({ type:'alert',   title:o.title||'Notice',  message:m, okText:'OK', ...o }),
    confirm: (m, o={}) => open({ type:'confirm', title:o.title||'Confirm', message:m, okText:o.okText||'OK', cancelText:o.cancelText||'Cancel', ...o }),
    prompt:  (m, d='', o={}) => open({ type:'prompt', title:o.title||'Input', message:m, defaultValue:d, placeholder:o.placeholder||'', okText:o.okText||'OK', cancelText:o.cancelText||'Cancel', ...o }),
    toast
  };
})();

/* ─── Admin auth ─── */
const ADMIN_PASSWORD_HASH = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918";
const MAX_ATTEMPTS = 3;
let adminAttempts  = parseInt(sessionStorage.getItem('adminAttempts') || '0');
let adminLockUntil = parseInt(sessionStorage.getItem('adminLock') || '0');

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ─── Identity ─── */
let userId = localStorage.getItem('chatUserId');
if (!userId) { userId = Math.random().toString(36).slice(2, 11); localStorage.setItem('chatUserId', userId); }

/* ─── State ─── */
let room = "", currentUser = "", isInitialLoad = true;
let userHasScrolledUp = false, replyingTo = null;
let soundEnabled = true, pendingImage = null, openReactionPicker = null;
const loadedKeys = new Set(), reactionUnsubs = new Map(), readUnsubs = new Map(), msgObservers = new Map();
let oldestKey = null, pageVisible = true, unreadCount = 0;
const PAGE_SIZE = 80, originalTitle = document.title;
const onlineUsers = {};
let lastDateSepBottom = '';
let lastMsgAuthor = '', lastMsgTime = 0;
let scrollUnread = 0;
let openTouchActiveLi = null;
let pendingAutoMsg = '';

const ICON = {
  react: '<svg class="icon icon-sm"><use href="#i-smile"/></svg>',
  reply: '<svg class="icon icon-sm"><use href="#i-reply"/></svg>',
  pin:   '<svg class="icon icon-sm"><use href="#i-pin"/></svg>',
  copy:  '<svg class="icon icon-sm"><use href="#i-copy"/></svg>',
  check: '<svg class="icon icon-sm"><use href="#i-check"/></svg>',
  x:     '<svg class="icon icon-sm"><use href="#i-x"/></svg>',
  edit:  '<svg class="icon icon-sm"><use href="#i-edit"/></svg>',
  trash: '<svg class="icon icon-sm"><use href="#i-trash"/></svg>',
  eye:   '<svg class="icon icon-sm"><use href="#i-eye"/></svg>',
  send:  '<svg class="icon icon-sm"><use href="#i-send"/></svg>',
  alert: '<svg class="icon icon-sm"><use href="#i-alert"/></svg>',
  shield:'<svg class="icon icon-sm"><use href="#i-shield"/></svg>',
  clock: '<svg class="icon icon-xs"><use href="#i-clock"/></svg>'
};

const $app         = document.getElementById('app');
const $chatEl      = document.getElementById('chat');
const $scrollBtn   = document.getElementById('scrollBtn');
const $scrollBadge = document.getElementById('scrollBadge');
const $msgInput    = document.getElementById('msg');
const $emojiPicker = document.getElementById('emojiPicker');
const $replyBanner = document.getElementById('replyBanner');
const $replyPreview= document.getElementById('replyPreview');
const $pinnedBar   = document.getElementById('pinnedBar');
const $pinnedText  = document.getElementById('pinnedText');
const $onlineCount = document.getElementById('onlineCount');
const $onlineList  = document.getElementById('onlineList');
const $onlineTooltip = document.getElementById('onlineTooltip');
const $imgPreviewBar   = document.getElementById('imgPreviewBar');
const $imgPreviewThumb = document.getElementById('imgPreviewThumb');
const $imgPreviewName  = document.getElementById('imgPreviewName');
const $charCounter = document.getElementById('charCounter');
const $typingEl    = document.getElementById('typingIndicator');
const $darkBtn     = document.getElementById('darkBtn');
const $notifBtn    = document.getElementById('notifBtn');
const $sendBtn     = document.getElementById('sendBtn');
const $offlineBanner = document.getElementById('offlineBanner');
const $ctxMenu     = document.getElementById('ctxMenu');

let peer = null, currentCall = null, localStream = null;
let callMode = null, myPeerId = '', callAnswered = false;
let callTimer = null, callSeconds = 0, dialTimeout = null;
let wakeLock = null;

const $voiceCallBtn = document.getElementById('voiceCallBtn');
const $videoCallBtn = document.getElementById('videoCallBtn');
const $hangupBtn    = document.getElementById('hangupBtn');
const $remoteAudio  = document.getElementById('remoteAudio');
const $remoteVideo  = document.getElementById('remoteVideo');
const $localVideo   = document.getElementById('localVideo');
const $callStatusEl = document.getElementById('callStatus');
const $ring         = document.getElementById('ring');

const $adminModal      = document.getElementById('adminAuthModal');
const $adminPwInput    = document.getElementById('adminPwInput');
const $adminAttemptMsg = document.getElementById('authAttemptMsg');

let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.connect(ctx.destination); src.start(0);
    }
  } catch (e) {}
  if ($ring) {
    const wasMuted = $ring.muted;
    $ring.muted = true;
    const p = $ring.play();
    if (p && p.then) {
      p.then(() => { $ring.pause(); $ring.currentTime = 0; $ring.muted = wasMuted; })
       .catch(() => { $ring.muted = wasMuted; });
    }
  }
}
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
document.addEventListener('click', unlockAudio, { once: true });

/* ─── Helpers ─── */
function setupKickListener() {
  db.ref('kicked/' + room + '/' + userId).on('value', snap => {
    if (snap.exists() && snap.val() === true) { snap.ref.remove(); showKickedScreen(); }
  });
}
function setupBanListener() {
  db.ref(`bans/${room}/${userId}`).on('value', snap => { if (snap.exists()) showBannedScreen(); });
}
function showKickedScreen() {
  $app.style.display = 'none';
  document.getElementById('kickedScreen').classList.add('show');
  db.ref('online/' + room + '/' + userId).remove();
  db.ref('typing/' + room + '/' + userId).remove();
}
function showBannedScreen() {
  const ks = document.getElementById('kickedScreen');
  if (ks.classList.contains('show')) return;
  ks.querySelector('h2').textContent = 'You are banned';
  ks.querySelector('p').textContent = 'An admin has permanently banned you from this room.';
  $app.style.display = 'none';
  ks.classList.add('show');
  if (room) {
    db.ref('online/' + room + '/' + userId).remove();
    db.ref('typing/' + room + '/' + userId).remove();
  }
}

const PALETTE = ['#6366f1','#f97316','#06b6d4','#10b981','#ec4899','#f59e0b','#8b5cf6','#14b8a6','#ef4444','#3b82f6'];
function avatarColor(n) {
  n = (typeof n === 'string' && n) ? n : '?';
  let h = 0;
  for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h);
  return PALETTE[Math.abs(h) % PALETTE.length];
}
function avatarInitials(n) {
  n = (typeof n === 'string' && n.trim()) ? n.trim() : '?';
  return n.slice(0, 2).toUpperCase();
}
const _escDiv = document.createElement('div');
function esc(s) { _escDiv.textContent = s || ''; return _escDiv.innerHTML; }
function fmtTime(t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function fmtDate(t) { return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }); }
function sanitiseRoomName(n) { return n.replace(/[.#$[\]/]/g, '_').trim(); }
const URL_RE = /(https?:\/\/[^\s<]+)/g;
function linkify(s) { return esc(s).replace(/\n/g, '<br>').replace(URL_RE, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'); }

function addRipple(el, e) {
  const rect = el.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;
  const size = Math.max(rect.width, rect.height) * 1.2;
  const r = document.createElement('span'); r.className = 'ripple-wave';
  r.style.cssText = `width:${size}px;height:${size}px;left:${x - size/2}px;top:${y - size/2}px`;
  el.appendChild(r); r.addEventListener('animationend', () => r.remove(), { once: true });
}
function haptic(ms = 15) { if (navigator.vibrate) navigator.vibrate(ms); }

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed';
      ta.style.top = '-9999px'; ta.style.left = '-9999px';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta); ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    } catch (err) { reject(err); }
  });
}

function closeTouchActions() {
  if (openTouchActiveLi) { openTouchActiveLi.classList.remove('touch-active'); openTouchActiveLi = null; }
}
function openTouchActions(li) {
  if (openTouchActiveLi && openTouchActiveLi !== li) openTouchActiveLi.classList.remove('touch-active');
  li.classList.add('touch-active');
  openTouchActiveLi = li;
}
document.addEventListener('click', e => {
  if (!openTouchActiveLi) return;
  if (e.target.closest('.msg-actions')) return;
  if (e.target.closest('.msg.touch-active') && e.target.closest('.bubble')) { closeTouchActions(); return; }
  closeTouchActions();
}, true);

/* ─── Dark / Sound / Ring ─── */
function applyDark(on) {
  document.documentElement.toggleAttribute('data-dark', on);
  $darkBtn.innerHTML = on ? '<svg class="icon"><use href="#i-sun"/></svg>' : '<svg class="icon"><use href="#i-moon"/></svg>';
  localStorage.setItem('chatDark', on ? '1' : '');
}
$darkBtn.addEventListener('click', e => { addRipple($darkBtn, e); applyDark(!document.documentElement.hasAttribute('data-dark')); });
if (localStorage.getItem('chatDark')) applyDark(true);

function applySound(on) {
  soundEnabled = on;
  $notifBtn.innerHTML = on ? '<svg class="icon"><use href="#i-bell"/></svg><span class="badge"></span>' : '<svg class="icon"><use href="#i-bell-off"/></svg><span class="badge"></span>';
  localStorage.setItem('chatSound', on ? '1' : '');
}
$notifBtn.addEventListener('click', () => applySound(!soundEnabled));
applySound(localStorage.getItem('chatSound') !== '');

function playRing() {
  if (!soundEnabled) return;
  if (!$ring) return;
  $ring.loop = false;
  $ring.currentTime = 0;
  $ring.play().catch(() => {});
}
let ringtonePlaying = false;
function playRingtone() {
  if (!$ring) return;
  $ring.loop = true;
  try { $ring.currentTime = 0; } catch (e) {}
  const p = $ring.play();
  if (p && p.then) p.then(() => { ringtonePlaying = true; }).catch(() => {});
}
function stopRingtone() {
  if (!$ring) return;
  try { $ring.pause(); $ring.currentTime = 0; } catch (e) {}
  ringtonePlaying = false;
}

/* ─── Emoji ─── */
const EMOJIS = ['😀','😂','🥰','😍','🤔','😎','🥺','😭','🔥','❤️','👍','👎','🎉','✨','🙏','😅','😆','🤣','💯','😊','😢','🤩','😤','🙄','😬','🥳','😴','🤗','💪','👏','🎊','🌟','💥','🫡','😇','🥲','😏','😌','🤤','😋','😛','🫠','🤠','👀','💀','🫶','🫂','✌️','🤞'];
const REACTIONS = ['👍','❤️','😂','😮','😢','🔥'];
const $emojiBtn = document.getElementById('emojiBtn');
const epFrag = document.createDocumentFragment();
EMOJIS.forEach(e => {
  const s = document.createElement('span'); s.textContent = e;
  s.addEventListener('click', () => {
    haptic();
    const pos = $msgInput.selectionStart, val = $msgInput.value;
    $msgInput.value = val.slice(0, pos) + e + val.slice(pos);
    $msgInput.focus(); $msgInput.selectionStart = $msgInput.selectionEnd = pos + e.length;
  });
  epFrag.appendChild(s);
});
$emojiPicker.appendChild(epFrag);
$emojiBtn.addEventListener('click', () => { haptic(10); $emojiPicker.classList.toggle('open'); });
document.addEventListener('click', e => {
  if (!e.target.closest('#emojiPicker') && !e.target.closest('#emojiBtn')) $emojiPicker.classList.remove('open');
});
/* ═══════════════════════════════════════════════════════════════
   IMAGE + FILE UPLOAD  (v4 — supports images AND code/text files)
   ═══════════════════════════════════════════════════════════════ */
function compressImage(file, maxPx, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = reject;
    reader.onload = ev => {
      const img = new Image(); img.onerror = reject;
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ★ Text / code file detection */
const CODE_EXT_RE = /\.(txt|js|mjs|cjs|ts|tsx|jsx|html|htm|css|scss|sass|less|json|md|markdown|py|pyw|c|h|cpp|hpp|cc|java|kt|rb|go|rs|php|xml|svg|yml|yaml|toml|ini|cfg|conf|sh|bash|zsh|bat|ps1|sql|lua|r|swift|dart|vue|svelte|astro)$/i;

function isTextFile(file) {
  if (file.type && file.type.startsWith('text/')) return true;
  if (/^application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|x-httpd-php)/.test(file.type || '')) return true;
  return CODE_EXT_RE.test(file.name);
}

document.getElementById('attachBtn').addEventListener('click', e => {
  haptic(10); addRipple(e.currentTarget, e);
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async function (e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;

  const isImage = file.type.startsWith('image/');
  const isText  = isTextFile(file);

  if (!isImage && !isText) {
    UI.toast('Only images and code/text files are supported', 'error');
    return;
  }

  const sizeLimit = isImage ? 15 * 1024 * 1024 : 2 * 1024 * 1024;
  if (file.size > sizeLimit) {
    UI.toast((isImage ? 'Image' : 'Text file') + ' must be under ' + (isImage ? '15' : '2') + ' MB', 'error');
    return;
  }

  $sendBtn.disabled = true;
  $sendBtn.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';

  try {
    if (isImage) {
      const dataUrl = await compressImage(file, 800, 0.75);
      pendingImage = { type: 'image', dataUrl, name: file.name };
      $imgPreviewThumb.style.display = '';
      $imgPreviewThumb.src = dataUrl;
      $imgPreviewName.textContent = file.name;
      $imgPreviewBar.classList.remove('is-file');
    } else {
      const text = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ''));
        r.onerror = () => reject(r.error);
        r.readAsText(file, 'utf-8');
      });

      const MAX_STORE = 200 * 1024; // 200 KB
      const truncated = text.length > MAX_STORE;
      const finalText = truncated
        ? text.slice(0, MAX_STORE) + '\n\n/* … content truncated: file too large … */'
        : text;

      const lang = (file.name.split('.').pop() || 'txt').toLowerCase();
      pendingImage = {
        type: 'file',
        name: file.name,
        lang,
        size: file.size,
        text: finalText,
        truncated
      };

      $imgPreviewThumb.style.display = 'none';
      $imgPreviewThumb.src = '';
      $imgPreviewName.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
      $imgPreviewBar.classList.add('is-file');
    }
    $imgPreviewBar.classList.add('visible');
  } catch (err) {
    console.error('[file] failed:', err);
    UI.toast('Failed to process file', 'error');
  } finally {
    $sendBtn.disabled = false;
    $sendBtn.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>';
  }
});

document.getElementById('clearImg').addEventListener('click', clearImage);
function clearImage() {
  pendingImage = null;
  $imgPreviewBar.classList.remove('visible');
  $imgPreviewBar.classList.remove('is-file');
  $imgPreviewThumb.src = '';
  $imgPreviewThumb.style.display = '';
}

async function handlePastedImage(file) {
  if (!room) return;
  if (file.size > 15 * 1024 * 1024) { UI.toast('Image must be under 15 MB', 'error'); return; }
  $sendBtn.disabled = true;
  $sendBtn.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';
  try {
    const dataUrl = await compressImage(file, 800, 0.75);
    pendingImage = { type: 'image', dataUrl, name: file.name || 'pasted-image.jpg' };
    $imgPreviewThumb.style.display = '';
    $imgPreviewThumb.src = dataUrl;
    $imgPreviewName.textContent = pendingImage.name;
    $imgPreviewBar.classList.remove('is-file');
    $imgPreviewBar.classList.add('visible');
    $msgInput.focus();
  } catch { UI.toast('Failed to process pasted image', 'error'); }
  finally {
    $sendBtn.disabled = false;
    $sendBtn.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>';
  }
}
document.addEventListener('paste', e => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) handlePastedImage(file);
      break;
    }
  }
});

/* ─── Online / Admin ─── */
document.getElementById('onlineBtn').addEventListener('click', () => { haptic(8); $onlineTooltip.classList.toggle('show'); });
document.addEventListener('click', e => { if (!e.target.closest('#onlineWrap')) $onlineTooltip.classList.remove('show'); });
document.getElementById('adminSecretBtn').addEventListener('click', () => { window.admin(); });

function updateOnlineUI() {
  const names = Object.values(onlineUsers).map(u => typeof u === 'string' ? u : (u && u.name) || '?');
  $onlineCount.textContent = names.length;
  const frag = document.createDocumentFragment();
  names.forEach(n => { const li = document.createElement('li'); li.textContent = n; frag.appendChild(li); });
  $onlineList.innerHTML = '';
  $onlineList.appendChild(frag);
}

/* ─── Reply / Pin ─── */
document.getElementById('cancelReply').addEventListener('click', cancelReply);
function cancelReply() { replyingTo = null; $replyBanner.classList.remove('visible'); }
function startReply(key, name, text) {
  haptic(12);
  replyingTo = { key, name, msg: text };
  $replyPreview.textContent = name + ': ' + text;
  $replyBanner.classList.add('visible');
  $msgInput.focus();
}
document.getElementById('unpinBtn').addEventListener('click', async e => {
  e.stopPropagation();
  const ok = await UI.confirm('Unpin this message?', { okText: 'Unpin' });
  if (ok) db.ref('pinned/' + room).remove();
});
$pinnedBar.addEventListener('click', function (e) {
  if (e.target.closest('#unpinBtn')) return;
  const key = this.dataset.pinnedKey; if (!key) return;
  const el = document.getElementById('msg-' + key);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const bubble = el.querySelector('.bubble');
    bubble.style.transition = 'background .5s';
    bubble.style.background = 'rgba(99,102,241,0.3)';
    setTimeout(() => { bubble.style.background = ''; }, 1000);
  }
});
function setPinnedUI(text, key) {
  if (!text) { $pinnedBar.classList.remove('visible'); return; }
  $pinnedText.textContent = text; $pinnedBar.dataset.pinnedKey = key;
  $pinnedBar.classList.add('visible');
}
async function pinMessage(key, text) {
  const ok = await UI.confirm('Pin this message?', { okText: 'Pin' });
  if (ok) db.ref('pinned/' + room).set({ key, msg: (text || '') });
}

/* ─── Scroll ─── */
function isAtBottom() { return $chatEl.scrollTop + $chatEl.clientHeight >= $chatEl.scrollHeight - 80; }
function scrollToBottom(force) {
  if (force || !userHasScrolledUp) {
    $chatEl.scrollTop = $chatEl.scrollHeight;
    userHasScrolledUp = false;
    updateScrollBtn();
  }
}
let _scrollRaf = false;
$chatEl.addEventListener('scroll', () => {
  if (_scrollRaf) return;
  _scrollRaf = true;
  requestAnimationFrame(() => { _scrollRaf = false; userHasScrolledUp = !isAtBottom(); updateScrollBtn(); });
}, { passive: true });
function updateScrollBtn() {
  const show = !isAtBottom() && $chatEl.scrollHeight > $chatEl.clientHeight + 80;
  $scrollBtn.classList.toggle('visible', show);
}
$scrollBtn.addEventListener('click', () => {
  haptic(10); scrollToBottom(true);
  scrollUnread = 0; $scrollBadge.style.display = 'none';
  $scrollBtn.classList.remove('has-unread');
});

/* ─── Offline / Visibility ─── */
function syncOffline() { $offlineBanner.classList.toggle('visible', !navigator.onLine); }
window.addEventListener('online', syncOffline);
window.addEventListener('offline', syncOffline);
syncOffline();
document.addEventListener('visibilitychange', () => {
  pageVisible = !document.hidden;
  if (pageVisible) { unreadCount = 0; document.title = originalTitle; $notifBtn.classList.remove('has-notif'); }
});
function handleNewMsg() {
  if (!pageVisible) {
    unreadCount++;
    document.title = '(' + unreadCount + ') ' + originalTitle;
    $notifBtn.classList.add('has-notif');
  }
}

/* ─── Viewport ─── */
let _vpRaf = null;
function syncViewport() {
  if (!document.body.classList.contains('in-chat')) return;
  if (_vpRaf) cancelAnimationFrame(_vpRaf);
  _vpRaf = requestAnimationFrame(() => {
    const vv = window.visualViewport;
    if (vv) document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    else document.documentElement.style.setProperty('--app-height', `100dvh`);
  });
}
if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport);
window.addEventListener('resize', syncViewport);
syncViewport();

/* ─── Join ─── */
const $joinName = document.getElementById('joinName');
const _savedName = localStorage.getItem('chatName');
if (_savedName) $joinName.value = _savedName;

let _joining = false;
const $joinBtn = document.getElementById('joinBtn');
$joinBtn.addEventListener('click', e => { addRipple($joinBtn, e); joinRoom(); });
document.getElementById('roomInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('roomInput').blur(); setTimeout(() => $joinName.focus(), 80); }
});
$joinName.addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });

async function joinRoom() {
  if (_joining) return;
  const rawRoom = document.getElementById('roomInput').value.trim();
  const name = $joinName.value.trim();
  if (!rawRoom || !name) { UI.toast('Please enter a room name and your name', 'warn'); return; }
  _joining = true;
  const tentativeRoom = sanitiseRoomName(rawRoom);

  db.ref(`bans/${tentativeRoom}/${userId}`).once('value', snap => {
    if (snap.exists()) { showBannedScreen(); return; }
    room = tentativeRoom; currentUser = name;
    localStorage.setItem('chatName', name);
    try {
      history.replaceState(null, '', location.pathname + '?room=' + encodeURIComponent(room) + '&user=' + encodeURIComponent(name));
    } catch (e) {}

    haptic(30);
    document.getElementById('join').style.display = 'none';
    document.getElementById('chatRoom').classList.add('active');
    document.body.classList.add('in-chat');
    document.getElementById('deleteRoomBtn').style.display = 'flex';
    document.getElementById('roomLabel').textContent = '# ' + room;

    trackOnline();
    loadMessages();
    setupPinListener();
    setupTypingListener();
    setupKickListener();
    setupBanListener();
    initPeer();
    syncViewport();

    const draft = localStorage.getItem('draft_' + room);
    if (draft) {
      $msgInput.value = draft;
      $msgInput.style.height = 'auto';
      $msgInput.style.height = Math.min($msgInput.scrollHeight, 140) + 'px';
    }
    if (pendingAutoMsg) {
      const autoTxt = pendingAutoMsg;
      pendingAutoMsg = '';
      setTimeout(() => { if (!room) return; $msgInput.value = autoTxt; send(); }, 900);
    }
  });
}

document.getElementById('logoBtn').addEventListener('click', async () => {
  if (typeof closeTouchActions === 'function') closeTouchActions();
  if (!room) return;
  const ok = await UI.confirm('Leave this room?', { okText: 'Leave', cancelText: 'Stay' });
  if (ok) location.href = location.pathname;
});
document.getElementById('logoBtn').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
});
document.getElementById('deleteRoomBtn').addEventListener('click', async () => {
  const ok = await UI.confirm('Delete this room? All messages will be lost.', { okText: 'Delete', danger: true });
  if (!ok) return;
  ['messages','online','typing','readReceipts','reactions','pinned','kicked'].forEach(k => db.ref(k + '/' + room).remove());
  location.href = location.pathname;
});

/* ─── Online tracking ─── */
function trackOnline() {
  db.ref('.info/connected').on('value', snap => {
    if (!snap.val()) return;
    const ref = db.ref('online/' + room + '/' + userId);
    ref.update({ name: currentUser, peerId: myPeerId || '' });
    ref.onDisconnect().remove();
    db.ref('typing/' + room + '/' + userId).onDisconnect().remove();
  });
  db.ref('online/' + room).on('value', snap => {
    Object.keys(onlineUsers).forEach(k => delete onlineUsers[k]);
    if (snap.exists()) snap.forEach(c => { onlineUsers[c.key] = c.val(); });
    updateOnlineUI();
  });
}

/* ─── Typing ─── */
let typingTimeout = null;
$msgInput.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  $charCounter.textContent = '';
  if (room) localStorage.setItem('draft_' + room, this.value);
  if (!room) return;
  const ref = db.ref('typing/' + room + '/' + userId);
  ref.set(true);
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => ref.remove(), 2500);
});
function setupTypingListener() {
  db.ref('typing/' + room).on('value', snap => {
    let typing = false;
    if (snap.exists()) snap.forEach(c => { if (c.key !== userId) typing = true; });
    $typingEl.textContent = typing ? 'Someone is typing…' : '';
  });
}

function setupPinListener() {
  db.ref('pinned/' + room).on('value', snap => {
    if (snap.exists()) {
      const d = snap.val();
      setPinnedUI(d.msg, d.key);
      document.querySelectorAll('.msg.is-pinned').forEach(el => el.classList.remove('is-pinned'));
      const el = document.getElementById('msg-' + d.key);
      if (el) el.classList.add('is-pinned');
    } else {
      document.getElementById('pinnedBar').classList.remove('visible');
      document.querySelectorAll('.msg.is-pinned').forEach(el => el.classList.remove('is-pinned'));
    }
  });
}

/* ─── Send ─── */
$sendBtn.addEventListener('click', e => { addRipple($sendBtn, e); send(); });
$msgInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    const s = this.selectionStart;
    this.value = this.value.slice(0, s) + '\n' + this.value.slice(s);
    this.selectionStart = this.selectionEnd = s + 1;
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 140) + 'px';
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault(); send();
  }
});
function send() {
  const name = localStorage.getItem('chatName');
  let text = $msgInput.value;
  if (!text.trim() && !pendingImage) return;
  text = text.replace(/<[^>]*>/g, '');
  const msg = { name, msg: text, time: Date.now() };

  if (pendingImage) {
    if (pendingImage.type === 'file') {
      msg.fileData = {
        name: pendingImage.name,
        lang: pendingImage.lang,
        size: pendingImage.size,
        text: pendingImage.text,
        truncated: !!pendingImage.truncated
      };
    } else {
      msg.imageData = pendingImage.dataUrl;
    }
  }

  if (replyingTo) msg.replyTo = { key: replyingTo.key, name: replyingTo.name, msg: replyingTo.msg };

  haptic(20);
  db.ref('messages/' + room).push(msg).then(ref => {
    db.ref('readReceipts/' + room + '/' + ref.key + '/' + userId).set(currentUser);
  });
  $msgInput.value = '';
  $msgInput.style.height = 'auto';
  if (room) localStorage.removeItem('draft_' + room);
  clearImage(); cancelReply(); $emojiPicker.classList.remove('open');
  setTimeout(() => scrollToBottom(true), 50);
}

/* ─── Edit ─── */
async function editMessage(key, currentText) {
  const newText = await UI.prompt('Edit your message:', currentText, { okText: 'Save', title: 'Edit Message' });
  if (newText === null) return;
  const clean = newText.replace(/<[^>]*>/g, '');
  if (!clean.trim()) { UI.toast('Message cannot be empty', 'warn'); return; }
  db.ref('messages/' + room + '/' + key).update({ msg: clean, edited: true });
}

/* ─── Reactions ─── */
function toggleReaction(key, emoji) {
  haptic(15);
  const ref = db.ref('reactions/' + room + '/' + key + '/' + emoji + '/' + userId);
  ref.once('value', snap => { snap.exists() ? ref.remove() : ref.set(true); });
}
function renderReactions(key, data) {
  const li = document.getElementById('msg-' + key); if (!li) return;
  let row = li.querySelector('.reactions-row');
  if (!row) {
    row = document.createElement('div'); row.className = 'reactions-row';
    li.querySelector('.bubble').appendChild(row);
  }
  row.innerHTML = '';
  if (!data) return;
  Object.entries(data).forEach(([emoji, users]) => {
    const count = Object.keys(users).length; if (!count) return;
    const chip = document.createElement('button');
    chip.className = 'reaction-chip' + (users[userId] ? ' mine' : '');
    chip.textContent = emoji + ' ' + count;
    chip.addEventListener('click', e => { e.stopPropagation(); toggleReaction(key, emoji); });
    row.appendChild(chip);
  });
}
function setupReactionListener(key) {
  if (reactionUnsubs.has(key)) return;
  const ref = db.ref('reactions/' + room + '/' + key);
  const cb = snap => renderReactions(key, snap.val());
  ref.on('value', cb);
  reactionUnsubs.set(key, () => ref.off('value', cb));
}

/* ─── Read Receipts ─── */
function setupReadListener(key, isSelf) {
  if (readUnsubs.has(key)) return;
  const ref = db.ref('readReceipts/' + room + '/' + key);
  const cb = snap => {
    const readSpan = document.getElementById('read-' + key); if (!readSpan) return;
    readSpan.innerHTML = '';
    if (!snap.exists()) return;
    const readerMap = new Map();
    snap.forEach(c => { if (c.val() && typeof c.val() === 'string') readerMap.set(c.val(), c.key); });
    const readers = [...readerMap.keys()].filter(n => !isSelf || n !== currentUser);
    if (readers.length > 0) {
      const btn = document.createElement('button');
      btn.className = 'read-btn';
      btn.type = 'button';
      btn.innerHTML = ICON.eye + ' Seen';
      btn.addEventListener('click', e => { e.stopPropagation(); showReadModal(readers); });
      readSpan.appendChild(btn);
    }
  };
  ref.on('value', cb);
  readUnsubs.set(key, () => ref.off('value', cb));
}
function markRead(msgKey) { db.ref('readReceipts/' + room + '/' + msgKey + '/' + userId).set(currentUser); }
function showReadModal(readers) {
  document.querySelector('.modal-backdrop')?.remove();
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  const modal = document.createElement('div'); modal.className = 'modal';
  const h = document.createElement('h4'); h.textContent = 'Seen by';
  const list = document.createElement('div'); list.className = 'modal-list';
  if (!readers.length) {
    const empty = document.createElement('div'); empty.className = 'modal-empty';
    empty.textContent = 'No one has seen this yet';
    list.appendChild(empty);
  } else {
    readers.forEach(name => {
      const item = document.createElement('div'); item.className = 'modal-item';
      const av = document.createElement('div'); av.className = 'avatar';
      av.style.cssText = `width:36px;height:36px;background:${avatarColor(name)};font-size:.8rem`;
      av.textContent = avatarInitials(name);
      const span = document.createElement('span'); span.textContent = name;
      item.append(av, span); list.appendChild(item);
    });
  }
  modal.append(h, list); backdrop.appendChild(modal); document.body.appendChild(backdrop);
  setTimeout(() => {
    const onKey = e => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
  }, 50);
}

/* ─── Reaction Picker ─── */
function showReactionPicker(key, li) {
  openReactionPicker?.remove();
  openReactionPicker = null;
  haptic(15);
  const picker = document.createElement('div'); picker.className = 'reaction-picker';
  REACTIONS.forEach(emoji => {
    const s = document.createElement('span'); s.textContent = emoji;
    s.addEventListener('click', e => {
      e.stopPropagation();
      toggleReaction(key, emoji);
      picker.remove(); openReactionPicker = null;
    });
    picker.appendChild(s);
  });
  li.querySelector('.bubble').appendChild(picker);
  openReactionPicker = picker;
  setTimeout(() => {
    function outside(e) {
      if (!e.target.closest('.reaction-picker')) {
        picker.remove(); openReactionPicker = null;
        document.removeEventListener('click', outside);
      }
    }
    document.addEventListener('click', outside);
  }, 10);
}

/* ─── Lightbox / Code Viewer ─── */
const $lightbox = document.getElementById('lightbox');
const $lightboxImg = document.getElementById('lightboxImg');
$lightbox.addEventListener('click', () => $lightbox.classList.remove('open'));
function openLightbox(src) { $lightboxImg.src = src; $lightbox.classList.add('open'); }

function openCodeView(filename, lang, content) {
  const modal = document.getElementById('codeViewModal');
  if (!modal) { UI.alert('Code viewer not available.'); return; }
  document.getElementById('codeViewFilename').textContent = filename || 'file.txt';
  document.getElementById('codeViewLang').textContent = ((lang || 'txt') + '').toUpperCase();
  document.getElementById('codeViewContent').textContent = content || '';
  modal.classList.add('open');
}
(function bindCodeView() {
  const modal = document.getElementById('codeViewModal');
  if (!modal) return;
  const closeBtn = document.getElementById('codeViewClose');
  const copyBtn  = document.getElementById('codeViewCopy');
  closeBtn?.addEventListener('click', () => modal.classList.remove('open'));
  modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) modal.classList.remove('open');
  });
  copyBtn?.addEventListener('click', () => {
    const text = document.getElementById('codeViewContent').textContent;
    copyText(text)
      .then(() => UI.toast('Copied to clipboard', 'success'))
      .catch(() => UI.toast('Copy failed', 'error'));
  });
})();

/* ─── Context Menu ─── */
function showCtxMenu(x, y, key, isSelf, rawMsg) {
  haptic(50); $ctxMenu.innerHTML = '';
  const items = [
    { icon: ICON.react, label: 'React', action: () => { closeCtxMenu(); const li = document.getElementById('msg-' + key); if (li) showReactionPicker(key, li); } },
    { icon: ICON.reply, label: 'Reply', action: () => { closeCtxMenu(); startReply(key, document.querySelector('#msg-' + key + ' .name')?.textContent || '', rawMsg); } },
    { icon: ICON.copy, label: 'Copy', action: () => { closeCtxMenu(); copyText(rawMsg).then(() => UI.toast('Copied', 'success')).catch(() => UI.toast('Copy failed', 'error')); } },
    { icon: ICON.pin, label: 'Pin', action: () => { closeCtxMenu(); pinMessage(key, rawMsg || '[image]'); } },
  ];
  if (isSelf) {
    items.push({ icon: ICON.edit, label: 'Edit', action: () => { closeCtxMenu(); editMessage(key, rawMsg); } });
    items.push({ icon: ICON.trash, label: 'Delete', danger: true, action: async () => {
      closeCtxMenu();
      const ok = await UI.confirm('Delete this message?', { okText: 'Delete', danger: true });
      if (ok) db.ref('messages/' + room + '/' + key).remove();
    }});
  }
  items.forEach(item => {
    const btn = document.createElement('button');
    btn.className = 'ctx-item' + (item.danger ? ' danger' : '');
    btn.innerHTML = `<span class="ctx-icon">${item.icon}</span>${item.label}`;
    btn.addEventListener('click', item.action);
    $ctxMenu.appendChild(btn);
  });
  if (window.innerWidth <= 600) {
    $ctxMenu.style.left = '0'; $ctxMenu.style.top = 'auto'; $ctxMenu.style.bottom = '0';
  } else {
    const menuW = 220, menuH = items.length * 56 + 20;
    const vw = window.innerWidth, vh = window.innerHeight;
    let cx = x, cy = y;
    if (cx + menuW > vw - 12) cx = vw - menuW - 12;
    if (cy + menuH > vh - 12) cy = y - menuH - 12;
    if (cy < 12) cy = 12;
    $ctxMenu.style.left = cx + 'px'; $ctxMenu.style.top = cy + 'px';
    $ctxMenu.style.bottom = 'auto';
  }
  $ctxMenu.classList.add('show');
  setTimeout(() => document.addEventListener('click', closeCtxMenuOutside), 10);
}
function closeCtxMenu() {
  $ctxMenu.classList.remove('show');
  document.removeEventListener('click', closeCtxMenuOutside);
  closeTouchActions();
}
function closeCtxMenuOutside(e) { if (!$ctxMenu.contains(e.target)) closeCtxMenu(); }

/* ─── Display Message ─── */
function displayMessage(m, key, prepend = false) {
  if (loadedKeys.has(key)) return;
  loadedKeys.add(key);
  const name = localStorage.getItem('chatName') || '';
  const isSelf = m.name === name;

  if (!prepend) {
    const dateStr = fmtDate(m.time);
    if (dateStr !== lastDateSepBottom) {
      lastDateSepBottom = dateStr; lastMsgAuthor = '';
      const sep = document.createElement('li'); sep.className = 'date-sep';
      sep.textContent = dateStr; $chatEl.appendChild(sep);
    }
  }
  const GROUP_GAP = 2 * 60 * 1000;
  const isGrouped = !prepend && !m.replyTo && m.name === lastMsgAuthor && (m.time - lastMsgTime) < GROUP_GAP;
  if (!prepend) { lastMsgAuthor = m.name; lastMsgTime = m.time; }

  const li = document.createElement('li');
  li.id = 'msg-' + key;
  li.className = 'msg ' + (isSelf ? 'self' : 'other') + (isGrouped ? ' grouped' : '');
  const rawMsg = m.msg || '';
  const escapedMsg = linkify(rawMsg);
  const editedTag = m.edited ? '<span class="edited-tag">(edited)</span>' : '';
  const replyHtml = m.replyTo ? `<div class="reply-quote"><strong>${esc(m.replyTo.name)}</strong>: ${esc(m.replyTo.msg)}</div>` : '';
  const avatarHtml = !isSelf ? `<div class="avatar" style="background:${avatarColor(m.name)}">${avatarInitials(m.name)}</div>` : '';
  const showMeta = !isGrouped;

  li.innerHTML = `
    ${showMeta ? `
    <div class="msg-meta">
      ${avatarHtml}
      ${!isSelf ? `<span class="name">${esc(m.name)}</span>` : ''}
      <span class="time">${ICON.clock}${fmtTime(m.time)}</span>
    </div>` : ''}
    <div class="bubble">
      ${replyHtml}
      <span class="msg-content">${escapedMsg}</span>${editedTag}
      ${m.imageData ? `<img class="msg-img" alt="image" loading="lazy">` : ''}
      ${m.fileData ? `
        <div class="msg-file" role="button" tabindex="0">
          <div class="msg-file-header">
            <svg class="icon icon-sm"><use href="#i-file"/></svg>
            <span class="msg-file-name">${esc(m.fileData.name)}</span>
            <span class="msg-file-lang">${esc((m.fileData.lang || 'txt').toUpperCase())}</span>
          </div>
          <pre class="msg-file-preview">${esc((m.fileData.text || '').slice(0, 500))}${(m.fileData.text || '').length > 500 ? '\n…' : ''}</pre>
          <div class="msg-file-footer">
            <span>${((m.fileData.size || 0) / 1024).toFixed(1)} KB${m.fileData.truncated ? ' · truncated' : ''}</span>
            <button class="msg-file-view" type="button">View full</button>
          </div>
        </div>
      ` : ''}
    </div>
    <div class="read-indicator" id="read-${key}"></div>`;

  if (m.imageData) {
    const img = li.querySelector('.msg-img');
    img.src = m.imageData;
    img.onerror = () => { img.style.display = 'none'; };
    img.addEventListener('click', e => { e.stopPropagation(); openLightbox(img.src); });
  }

  // ★ File card click → open code viewer
  if (m.fileData) {
    const fileCard = li.querySelector('.msg-file');
    const viewBtn  = li.querySelector('.msg-file-view');
    const openCode = (e) => {
      e.stopPropagation();
      openCodeView(m.fileData.name, m.fileData.lang, m.fileData.text || '');
    };
    fileCard?.addEventListener('click', openCode);
    viewBtn?.addEventListener('click', openCode);
  }

  const actions = document.createElement('div'); actions.className = 'msg-actions';
  const mkBtn = (icon, title, cb) => {
    const b = document.createElement('button');
    b.className = 'action-mini'; b.title = title;
    b.dataset.act = title; b.setAttribute('aria-label', title);
    b.innerHTML = icon;
    b.addEventListener('click', e => { e.stopPropagation(); haptic(10); closeTouchActions(); cb(b); });
    actions.appendChild(b);
  };
  mkBtn(ICON.react, 'React', () => showReactionPicker(key, li));
  mkBtn(ICON.reply, 'Reply', () => startReply(key, m.name, rawMsg));
  mkBtn(ICON.pin, 'Pin', () => pinMessage(key, rawMsg || '[image]'));
  mkBtn(ICON.copy, 'Copy', btn => {
    copyText(rawMsg).then(() => { btn.innerHTML = ICON.check; haptic(10); })
                    .catch(() => { btn.innerHTML = ICON.x; setTimeout(() => { btn.innerHTML = ICON.copy; }, 1200); });
  });
  if (isSelf) {
    mkBtn(ICON.edit, 'Edit', () => editMessage(key, rawMsg));
    mkBtn(ICON.trash, 'Delete', async () => {
      const ok = await UI.confirm('Delete this message?', { okText: 'Delete', danger: true });
      if (ok) db.ref('messages/' + room + '/' + key).remove();
    });
  }
  li.appendChild(actions);

  const bubble = li.querySelector('.bubble');
  bubble.style.webkitUserSelect = 'none';
  bubble.style.userSelect = 'none';
  bubble.style.webkitTouchCallout = 'none';
  bubble.addEventListener('contextmenu', e => {
    e.preventDefault();
    showCtxMenu(e.clientX, e.clientY, key, isSelf, rawMsg);
  });

  let touchTimeout, startX, startY, isLongPress = false;
  bubble.addEventListener('touchstart', e => {
    if (window.innerWidth > 600) return;
    isLongPress = false;
    const touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY;
    touchTimeout = setTimeout(() => {
      isLongPress = true;
      showCtxMenu(startX, startY, key, isSelf, rawMsg);
      haptic(50); openTouchActions(li);
    }, 400);
  }, { passive: true });
  bubble.addEventListener('touchmove', e => {
    if (window.innerWidth > 600) return;
    const touch = e.touches[0];
    if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
      clearTimeout(touchTimeout); isLongPress = false;
    }
  }, { passive: true });
  bubble.addEventListener('touchend', e => {
    if (window.innerWidth > 600) return;
    clearTimeout(touchTimeout);
    if (isLongPress) { e.stopPropagation(); e.preventDefault(); isLongPress = false; }
  });

  $chatEl.appendChild(li);
  if (!oldestKey) oldestKey = key;
  setupReadListener(key, isSelf);
  if (!isSelf) {
    const obs = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { markRead(key); obs.unobserve(entry.target); msgObservers.delete(key); }
      });
    }, { threshold: .6 });
    obs.observe(li); msgObservers.set(key, obs);
  } else markRead(key);
  setupReactionListener(key);
  if (!prepend && !isSelf) {
    if (userHasScrolledUp && !isInitialLoad) {
      scrollUnread++;
      $scrollBtn.classList.add('has-unread');
      $scrollBadge.style.display = 'block';
      $scrollBadge.textContent = scrollUnread > 99 ? '99+' : scrollUnread;
    }
    scrollToBottom(false);
  }
}
/* ═══════════════════════════════════════════════════════════════
   BOTTOM SNAP / LOAD MESSAGES
   ═══════════════════════════════════════════════════════════════ */
function instantBottom() {
  const prev = $chatEl.style.scrollBehavior;
  $chatEl.style.scrollBehavior = 'auto';
  $chatEl.scrollTop = $chatEl.scrollHeight;
  $chatEl.style.scrollBehavior = prev;
  userHasScrolledUp = false;
  updateScrollBtn();
}
function jumpToBottomOnEnter() {
  instantBottom();
  requestAnimationFrame(instantBottom);
  [80, 250, 600, 1200, 2000].forEach(t => setTimeout(() => { if (!userHasScrolledUp || t <= 250) instantBottom(); }, t));
  const until = Date.now() + 3000;
  $chatEl.querySelectorAll('img').forEach(img => {
    if (!img.complete) img.addEventListener('load', () => { if (Date.now() < until) instantBottom(); }, { once: true });
  });
}
function loadMessages() {
  userHasScrolledUp = false;
  msgObservers.forEach(o => o.disconnect()); msgObservers.clear();
  reactionUnsubs.forEach(u => u()); reactionUnsubs.clear();
  readUnsubs.forEach(u => u()); readUnsubs.clear();
  db.ref('messages/' + room).limitToLast(PAGE_SIZE).on('child_added', data => {
    const msg = data.val(), key = data.key;
    if (!oldestKey) oldestKey = key;
    displayMessage(msg, key);
    if (msg.name !== localStorage.getItem('chatName') && !isInitialLoad) { playRing(); handleNewMsg(); }
  });
  db.ref('messages/' + room).limitToLast(PAGE_SIZE).once('value', () => {
    isInitialLoad = false;
    jumpToBottomOnEnter();
  });
  db.ref('messages/' + room).on('child_changed', data => {
    const key = data.key; const li = document.getElementById('msg-' + key); if (!li) return;
    const m = data.val(); const content = li.querySelector('.msg-content');
    if (content) content.innerHTML = linkify(m.msg || '');
    let tag = li.querySelector('.edited-tag');
    if (m.edited) {
      if (!tag) { tag = document.createElement('span'); tag.className = 'edited-tag'; tag.textContent = '(edited)'; li.querySelector('.bubble').appendChild(tag); }
    } else if (tag) tag.remove();
  });
  db.ref('messages/' + room).on('child_removed', data => {
    const key = data.key; const li = document.getElementById('msg-' + key);
    if (li) {
      if (openTouchActiveLi === li) openTouchActiveLi = null;
      li.style.transition = 'opacity .3s, transform .3s';
      li.style.opacity = '0'; li.style.transform = 'scale(.9)';
      setTimeout(() => li.remove(), 300);
    }
    msgObservers.get(key)?.disconnect(); msgObservers.delete(key);
    reactionUnsubs.get(key)?.(); reactionUnsubs.delete(key);
    readUnsubs.get(key)?.(); readUnsubs.delete(key);
    loadedKeys.delete(key);
  });
}

/* ═══════════════════════════════════════════════════════════════
   SEARCH
   ═══════════════════════════════════════════════════════════════ */
let searchTimeout;
document.getElementById('searchMsg').addEventListener('input', function () {
  const clearBtn = document.getElementById('searchClear');
  clearBtn.classList.toggle('visible', this.value.length > 0);
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const kw = this.value.trim().toLowerCase();
    let firstMatch = null;
    document.querySelectorAll('#chat .msg').forEach(li => {
      const content = li.querySelector('.msg-content'); if (!content) return;
      const text = content.textContent.toLowerCase();
      const match = !kw || text.includes(kw);
      li.classList.toggle('search-match', kw !== '' && match);
      li.classList.toggle('search-hidden', kw !== '' && !match);
      if (kw && match && !firstMatch) firstMatch = li;
    });
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 220);
});
document.getElementById('searchClear').addEventListener('click', () => {
  document.getElementById('searchMsg').value = '';
  document.getElementById('searchClear').classList.remove('visible');
  document.querySelectorAll('#chat .msg').forEach(li => li.classList.remove('search-match', 'search-hidden'));
});

/* ═══════════════════════════════════════════════════════════════
   PEERJS CALL MODULE
   ═══════════════════════════════════════════════════════════════ */
const $callPage        = document.getElementById('callPage');
const $callRemoteVideo = document.getElementById('callRemoteVideo');
const $callLocalVideo  = document.getElementById('callLocalVideo');
const $callAudioUI     = document.getElementById('callAudioUI');
const $callAvatar      = document.getElementById('callAvatar');
const $callPeerName    = document.getElementById('callPeerName');
const $callPeerSub     = document.getElementById('callPeerSub');
const $callTopPeerName = document.getElementById('callTopPeerName');
const $callTimer       = document.getElementById('callTimer');
const $callMuteBtn     = document.getElementById('callMuteBtn');
const $callSwitchCamBtn= document.getElementById('callSwitchCamBtn');
const $callHangupBtn   = document.getElementById('callHangupBtn');

let micMuted = false;
let currentFacingMode = 'user';

function setCallStatus(text, cls) {
  if (!$callStatusEl) return;
  if (!text) { $callStatusEl.classList.remove('show','active','error'); $callStatusEl.textContent=''; return; }
  $callStatusEl.textContent = text;
  $callStatusEl.className = 'show' + (cls ? ' ' + cls : '');
}
function startCallTimer() {
  callSeconds = 0;
  clearInterval(callTimer);
  callTimer = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    if ($callTimer) $callTimer.textContent = m + ':' + s;
  }, 1000);
}
function stopCallTimer() { clearInterval(callTimer); callTimer = null; }

async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWakeLock() {
  try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {}
}

function initPeer() {
  if (peer && !peer.destroyed) { if (myPeerId) registerPeerId(myPeerId); return; }
  myPeerId = 'chatapp-' + userId + '-' + Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 6);
  peer = new Peer(myPeerId, {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  });
  peer.on('open', id => { myPeerId = id; registerPeerId(id); });
  peer.on('call', handleIncomingCall);
  peer.on('error', handlePeerError);
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) {} });
}
function registerPeerId(id) {
  if (!room || !currentUser) return;
  db.ref('online/' + room + '/' + userId).update({ name: currentUser, peerId: id });
}

async function getLocalStream(needVideo) {
  const isFile = location.protocol === 'file:';
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isHttp = location.protocol === 'http:' && !isLocalhost;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    let msg = 'Microphone / camera API not available.\n\n';
    if (isFile) msg += 'You opened this page via file://. Serve over http://localhost or HTTPS instead.';
    else if (isHttp) msg += 'You are on insecure HTTP. Safari hides the mic/cam API. Use HTTPS (Cloudflare Tunnel / ngrok).';
    else msg += 'Please use a modern browser over HTTPS.';
    UI.alert(msg, { title: 'Cannot access media' });
    return null;
  }

  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: needVideo ? { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } } : false
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.error('[getUserMedia] failed:', err);
    let msg = 'Could not access media devices: ' + (err.message || err.name || err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      msg = 'You denied the microphone' + (needVideo ? '/camera' : '') + ' permission.\n\n' +
            'iOS Safari: tap "aA" in the address bar → Website Settings → allow Microphone/Camera.';
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      msg = 'No microphone' + (needVideo ? ' or camera' : '') + ' device was found.';
    } else if (err.name === 'NotReadableError') {
      msg = 'Your microphone/camera is in use by another app.';
    }
    UI.alert(msg, { title: 'Media error' });
    return null;
  }
}

function updateRemoteOrientation() {
  if (!$callRemoteVideo) return;
  const w = $callRemoteVideo.videoWidth, h = $callRemoteVideo.videoHeight;
  if (!w || !h) return;
  const isPortrait = h > w;
  $callPage.classList.toggle('portrait-remote', isPortrait);
  $callPage.classList.toggle('landscape-remote', !isPortrait);
}
function updateLocalOrientation() {
  if (!$callLocalVideo) return;
  const w = $callLocalVideo.videoWidth, h = $callLocalVideo.videoHeight;
  if (!w || !h) return;
  const isPortrait = h > w;
  $callPage.classList.toggle('portrait-local', isPortrait);
  $callPage.classList.toggle('landscape-local', !isPortrait);
}

function openCallPage(peerName, isVideo) {
  document.body.classList.add('call-active');
  $callPage.classList.toggle('video-mode', isVideo);
  $callPage.classList.remove('portrait-remote', 'landscape-remote', 'portrait-local', 'landscape-local');

  $callPeerName.textContent = peerName;
  $callPeerSub.textContent = 'Connecting…';
  $callTopPeerName.textContent = peerName;
  $callAvatar.textContent = avatarInitials(peerName);
  $callAvatar.style.background = `linear-gradient(135deg, ${avatarColor(peerName)}, #a855f7)`;

  $callTimer.textContent = '00:00';
  micMuted = false;
  $callMuteBtn.classList.remove('active');
  $callMuteBtn.innerHTML = '<svg class="icon"><use href="#i-mic"/></svg><span>Mute</span>';
  $callSwitchCamBtn.style.display = isVideo ? '' : 'none';

  $callPage.classList.add('show');
}
function closeCallPage() {
  $callPage.classList.remove('show', 'video-mode', 'portrait-remote', 'landscape-remote', 'portrait-local', 'landscape-local');
  document.body.classList.remove('call-active');
  $callRemoteVideo.srcObject = null;
  $callLocalVideo.srcObject = null;
}

function setupCallHandlers(call, peerName) {
  const tryPlay = (el, tries = 5) => {
    if (!el) return;
    const p = el.play();
    if (p && p.catch) p.catch(() => { if (tries > 0) setTimeout(() => tryPlay(el, tries - 1), 250); });
  };

  call.on('stream', remoteStream => {
    callAnswered = true;
    stopRingtone();
    clearTimeout(dialTimeout);

    const hasRemoteVideo = remoteStream.getVideoTracks().length > 0;
    const isVideo = hasRemoteVideo || callMode === 'video';

    if (hasRemoteVideo && !$callPage.classList.contains('video-mode')) {
      $callPage.classList.add('video-mode');
      callMode = 'video';
    }
    $callPeerSub.textContent = isVideo ? 'Video call' : 'Voice call';

    $remoteAudio.srcObject = remoteStream;
    tryPlay($remoteAudio);

    if (isVideo) {
      $callRemoteVideo.addEventListener('loadedmetadata', updateRemoteOrientation, { once: true });
      $callRemoteVideo.srcObject = remoteStream;
      $callRemoteVideo.classList.add('show');
      tryPlay($callRemoteVideo);

      if (localStream) {
        $callLocalVideo.addEventListener('loadedmetadata', updateLocalOrientation, { once: true });
        $callLocalVideo.srcObject = localStream;
        $callLocalVideo.classList.add('show');
        tryPlay($callLocalVideo);
      }
      if (!call.__orientationWatcher) {
        call.__orientationWatcher = setInterval(() => {
          updateRemoteOrientation();
          updateLocalOrientation();
        }, 2000);
      }
    }

    $callSwitchCamBtn.style.display = isVideo ? '' : 'none';

    updateCallUI(true);
    startCallTimer();
    requestWakeLock();
    haptic(20);
  });

  call.on('close', () => {
    stopRingtone();
    if (call.__orientationWatcher) clearInterval(call.__orientationWatcher);
    $callPeerSub.textContent = 'Call ended';
    setTimeout(() => { closeCallPage(); cleanupCall(); }, 600);
  });
  call.on('error', () => {
    stopRingtone();
    if (call.__orientationWatcher) clearInterval(call.__orientationWatcher);
    $callPeerSub.textContent = 'Call error';
    setTimeout(() => { closeCallPage(); cleanupCall(); }, 800);
  });
}

async function startCall(needVideo) {
  if (!room) { UI.toast('Join a room first', 'warn'); return; }
  if (currentCall || localStream) { UI.toast('A call is already in progress', 'warn'); return; }
  if (!peer || peer.destroyed) { UI.toast('Call service not ready yet', 'warn'); return; }
  showCallUserPicker(needVideo);
}

function showCallUserPicker(needVideo) {
  document.querySelector('.modal-backdrop')?.remove();
  const others = Object.entries(onlineUsers)
    .filter(([uid]) => uid !== userId)
    .map(([uid, info]) => typeof info === 'string'
      ? { uid, name: info, peerId: null }
      : { uid, name: (info && info.name) || '?', peerId: (info && info.peerId) || null })
    .filter(u => u.peerId);

  if (!others.length) { UI.toast('No one else is available to call', 'warn'); return; }

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  const modal = document.createElement('div'); modal.className = 'modal';
  const h = document.createElement('h4');
  h.textContent = needVideo ? 'Start video call with…' : 'Start voice call with…';
  const list = document.createElement('div'); list.className = 'modal-list';
  list.style.gap = '8px';
  others.forEach(u => {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'call-user-row';
    const av = document.createElement('div');
    av.className = 'avatar'; av.style.background = avatarColor(u.name);
    av.textContent = avatarInitials(u.name);
    const nm = document.createElement('span');
    nm.className = 'call-user-name'; nm.textContent = u.name;
    const badge = document.createElement('span');
    badge.className = 'call-user-badge';
    badge.textContent = needVideo ? 'VIDEO' : 'VOICE';
    item.append(av, nm, badge);
    item.addEventListener('click', () => { backdrop.remove(); initiateCall(u.peerId, u.name, needVideo); });
    list.appendChild(item);
  });
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'modal-btn cancel'; cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => backdrop.remove());
  actions.appendChild(cancel);
  modal.append(h, list, actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

async function initiateCall(targetPeerId, targetName, needVideo) {
  callMode = needVideo ? 'video' : 'audio';
  callAnswered = false;
  currentFacingMode = 'user';

  openCallPage(targetName, needVideo);
  $callPeerSub.textContent = 'Requesting device permission…';

  localStream = await getLocalStream(needVideo);
  if (!localStream) { closeCallPage(); callMode = null; return; }

  if (needVideo) {
    $callLocalVideo.addEventListener('loadedmetadata', updateLocalOrientation, { once: true });
    $callLocalVideo.srcObject = localStream;
    $callLocalVideo.classList.add('show');
    $callLocalVideo.play().catch(() => {});
  }

  $callPeerSub.textContent = 'Calling…';
  updateCallUI(true);

  const call = peer.call(targetPeerId, localStream, {
    metadata: { video: needVideo, callerId: myPeerId, callerName: currentUser }
  });
  if (!call) {
    $callPeerSub.textContent = 'Peer not available';
    setTimeout(() => { closeCallPage(); cleanupCall(); }, 1200);
    return;
  }
  currentCall = call;
  setupCallHandlers(call, targetName);
  dialTimeout = setTimeout(() => {
    if (currentCall === call && !callAnswered) {
      $callPeerSub.textContent = 'No answer';
      setTimeout(() => { closeCallPage(); cleanupCall(); }, 1000);
    }
  }, 30000);
}

async function handleIncomingCall(call) {
  if (currentCall || localStream) { try { call.close(); } catch (e) {} return; }
  const meta = call.metadata || {};
  const needVideo = meta.video === undefined ? true : !!meta.video;
  const callerName = meta.callerName || meta.callerId || call.peer;

  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  playRingtone();

  const accept = await UI.confirm(
    (needVideo ? 'Video' : 'Voice') + ' call invitation\nFrom: ' + callerName,
    { title: 'Incoming call', okText: 'Accept', cancelText: 'Decline' }
  );

  stopRingtone();
  if (!accept) { try { call.close(); } catch (e) {} return; }

  callMode = needVideo ? 'video' : 'audio';
  callAnswered = false;
  currentFacingMode = 'user';

  openCallPage(callerName, needVideo);
  $callPeerSub.textContent = 'Connecting…';

  localStream = await getLocalStream(needVideo);
  if (!localStream) {
    if (needVideo) {
      UI.toast('Camera unavailable, falling back to voice', 'warn');
      localStream = await getLocalStream(false);
      if (localStream) { callMode = 'audio'; $callPage.classList.remove('video-mode'); }
    }
    if (!localStream) {
      $callPeerSub.textContent = 'Cannot access device';
      try { call.close(); } catch (e) {}
      setTimeout(() => { closeCallPage(); cleanupCall(); }, 1500);
      return;
    }
  }
  if (needVideo && localStream) {
    $callLocalVideo.addEventListener('loadedmetadata', updateLocalOrientation, { once: true });
    $callLocalVideo.srcObject = localStream;
    $callLocalVideo.classList.add('show');
    $callLocalVideo.play().catch(() => {});
  }

  call.answer(localStream);
  currentCall = call;
  setupCallHandlers(call, callerName);
  updateCallUI(true);
}

function endCall() {
  haptic(30);
  stopRingtone();
  if (currentCall) {
    if (currentCall.__orientationWatcher) clearInterval(currentCall.__orientationWatcher);
    try { currentCall.close(); } catch (e) {}
    currentCall = null;
  }
  if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }
  $callPeerSub.textContent = 'Call ended';
  setTimeout(() => { closeCallPage(); cleanupCall(); }, 600);
}

function cleanupCall() {
  stopRingtone();
  stopCallTimer();
  clearTimeout(dialTimeout);
  releaseWakeLock();
  callMode = null;
  callAnswered = false;
  micMuted = false;

  if (currentCall) {
    if (currentCall.__orientationWatcher) clearInterval(currentCall.__orientationWatcher);
    try { currentCall.close(); } catch (e) {}
    currentCall = null;
  }
  if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }

  if ($remoteAudio) $remoteAudio.srcObject = null;
  if ($remoteVideo) $remoteVideo.srcObject = null;
  if ($localVideo)  $localVideo.srcObject  = null;
  if ($callRemoteVideo) $callRemoteVideo.srcObject = null;
  if ($callLocalVideo)  $callLocalVideo.srcObject  = null;

  setCallStatus('');
  updateCallUI(false);
}

function updateCallUI(inCall) {
  if ($hangupBtn)    $hangupBtn.classList.toggle('active', inCall);
  if ($voiceCallBtn) $voiceCallBtn.disabled = inCall;
  if ($videoCallBtn) $videoCallBtn.disabled = inCall;
}

function handlePeerError(err) {
  console.error('[PeerJS] error:', err);
  let msg = 'Call service error: ' + (err.message || err.type || 'unknown');
  if (err.type === 'peer-unavailable') msg = 'That user is no longer available.';
  else if (err.type === 'network') msg = 'Network error. Please check your connection.';
  else if (err.type === 'unavailable-id') msg = 'Peer ID conflict. Please refresh the page.';
  else if (err.type === 'browser-incompatible') msg = 'Your browser does not support WebRTC.';
  else if (err.type === 'server-error') msg = 'PeerJS server is busy. Try again later.';
  setCallStatus(msg, 'error');
  setTimeout(() => { if (!currentCall) setCallStatus(''); }, 4000);
}

$callHangupBtn?.addEventListener('click', endCall);

$callMuteBtn?.addEventListener('click', () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !micMuted; });
  if (micMuted) {
    $callMuteBtn.classList.add('active');
    $callMuteBtn.innerHTML = '<svg class="icon"><use href="#i-mic-off"/></svg><span>Unmute</span>';
  } else {
    $callMuteBtn.classList.remove('active');
    $callMuteBtn.innerHTML = '<svg class="icon"><use href="#i-mic"/></svg><span>Mute</span>';
  }
});

$callSwitchCamBtn?.addEventListener('click', async () => {
  if (!localStream || callMode !== 'video') return;
  const newFacing = currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: newFacing }, width: { ideal: 1280 }, height: { ideal: 720 } }
    });
    const newVideoTrack = newStream.getVideoTracks()[0];

    const sender = currentCall?.peerConnection
      ?.getSenders()
      .find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newVideoTrack);

    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) { localStream.removeTrack(oldVideoTrack); oldVideoTrack.stop(); }
    localStream.addTrack(newVideoTrack);

    $callLocalVideo.srcObject = localStream;
    $callLocalVideo.play().catch(() => {});
    $callLocalVideo.style.transform = newFacing === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
    $callLocalVideo.addEventListener('loadedmetadata', updateLocalOrientation, { once: true });
    setTimeout(updateLocalOrientation, 300);

    currentFacingMode = newFacing;
    haptic(15);
  } catch (err) {
    console.error('[switchCamera] failed:', err);
    UI.toast('Could not switch camera', 'error');
  }
});

if ($voiceCallBtn) $voiceCallBtn.addEventListener('click', e => { addRipple($voiceCallBtn, e); startCall(false); });
if ($videoCallBtn) $videoCallBtn.addEventListener('click', e => { addRipple($videoCallBtn, e); startCall(true); });
if ($hangupBtn)    $hangupBtn.addEventListener('click', e => { addRipple($hangupBtn, e); endCall(); });

window.addEventListener('beforeunload', () => {
  if (currentCall) { try { currentCall.close(); } catch (e) {} }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN
   ═══════════════════════════════════════════════════════════════ */
window.admin = function () {
  if (document.getElementById('adminPanel')) { document.getElementById('adminPanel').remove(); return; }
  checkAdminAuth(openAdminConsole);
};

document.getElementById('toggleAdminPw').addEventListener('click', () => {
  const isText = $adminPwInput.type === 'text';
  $adminPwInput.type = isText ? 'password' : 'text';
  document.getElementById('toggleAdminPw').innerHTML = isText
    ? '<svg class="icon"><use href="#i-eye"/></svg>'
    : '<svg class="icon"><use href="#i-eye-off"/></svg>';
});
document.getElementById('adminAuthCancel').addEventListener('click', () => {
  $adminModal.classList.remove('show');
  $adminPwInput.value = '';
  $adminAttemptMsg.textContent = '';
});

function checkAdminAuth(onSuccess) {
  const now = Date.now();
  if (adminLockUntil > now) {
    const s = Math.ceil((adminLockUntil - now) / 1000);
    UI.toast('Too many attempts. Try again in ' + s + 's', 'error');
    return;
  }
  $adminModal.classList.add('show');
  $adminPwInput.value = '';
  $adminAttemptMsg.textContent = adminAttempts > 0 ? (MAX_ATTEMPTS - adminAttempts) + ' attempts remaining' : '';
  setTimeout(() => $adminPwInput.focus(), 100);

  const confirmBtn = document.getElementById('adminAuthConfirm');
  const newConfirm = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);

  const tryAuth = async () => {
    const enteredHash = await sha256Hex($adminPwInput.value);
    if (enteredHash === ADMIN_PASSWORD_HASH) {
      adminAttempts = 0;
      sessionStorage.setItem('adminAttempts', '0');
      $adminModal.classList.remove('show');
      $adminPwInput.value = '';
      onSuccess();
    } else {
      adminAttempts++;
      sessionStorage.setItem('adminAttempts', String(adminAttempts));
      $adminPwInput.classList.add('error');
      setTimeout(() => $adminPwInput.classList.remove('error'), 500);
      if (adminAttempts >= MAX_ATTEMPTS) {
        adminLockUntil = Date.now() + 60000;
        sessionStorage.setItem('adminLock', String(adminLockUntil));
        $adminAttemptMsg.textContent = 'Locked for 60 seconds.';
        newConfirm.disabled = true;
        setTimeout(() => { newConfirm.disabled = false; }, 60000);
      } else {
        $adminAttemptMsg.textContent = 'Wrong password. ' + (MAX_ATTEMPTS - adminAttempts) + ' remaining.';
      }
      $adminPwInput.value = '';
      $adminPwInput.focus();
    }
  };
  newConfirm.addEventListener('click', tryAuth);
  $adminPwInput.addEventListener('keypress', e => { if (e.key === 'Enter') tryAuth(); });
}

function openAdminConsole() {
  if (!document.getElementById('adminCSS')) {
    const s = document.createElement('style'); s.id = 'adminCSS';
    s.textContent = `
      #adm-toast-wrap{position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
      .adm-toast{background:rgba(18,22,40,0.9);border:1px solid rgba(99,102,241,0.3);color:#f1f5f9;font-family:'Inter',sans-serif;font-size:.8rem;padding:12px 20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5);pointer-events:all;display:flex;align-items:center;gap:10px;max-width:360px}
      .adm-toast.success{border-color:rgba(16,185,129,.5);color:#10b981}
      .adm-toast.warn{border-color:rgba(245,158,11,.5);color:#fbbf24}
      .adm-toast.err{border-color:rgba(239,68,68,.5);color:#f87171}
      #adminPanel{position:fixed;inset:0;z-index:9999;background:#06070f;color:#f1f5f9;font-family:'Inter',sans-serif;display:flex;flex-direction:column;overflow:hidden}
      #adm-topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;background:rgba(18,22,40,0.7);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;gap:16px}
      #adm-topbar .brand{display:flex;align-items:center;gap:12px}
      #adm-topbar .brand-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#a855f7);display:flex;align-items:center;justify-content:center;color:#fff}
      #adm-topbar .brand-name{font-size:.95rem;font-weight:800;letter-spacing:.1em}
      #adm-topbar .live-badge{font-size:.65rem;color:#10b981;border:1px solid rgba(16,185,129,.5);padding:3px 10px;border-radius:20px;letter-spacing:.1em;display:flex;align-items:center;gap:6px;background:rgba(16,185,129,.08);font-weight:600}
      #adm-ts,#adm-uptime{font-size:.7rem;color:#64748b;font-family:'JetBrains Mono',monospace;white-space:nowrap}
      #adm-close{background:rgba(30,37,56,0.8);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;padding:8px 18px;border-radius:10px;cursor:pointer;font-family:'Inter',sans-serif;font-size:.8rem;font-weight:600}
      #adm-close:hover{background:rgba(99,102,241,0.2);color:#f1f5f9}
      #adm-stats{display:flex;gap:1px;background:rgba(255,255,255,0.05);flex-shrink:0}
      .adm-stat{flex:1;padding:16px 20px;background:rgba(10,14,25,0.8);display:flex;flex-direction:column;gap:6px;min-width:0}
      .adm-stat-val{font-size:1.6rem;font-weight:800;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .adm-stat-lbl{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;font-weight:600}
      #adm-tabs{display:flex;gap:4px;padding:12px 24px 0;background:rgba(10,14,25,0.8);flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.08);overflow-x:auto}
      .adm-tab{padding:10px 20px;border-radius:10px 10px 0 0;font-size:.8rem;font-weight:700;cursor:pointer;border:1px solid transparent;border-bottom:none;color:#64748b;background:none;font-family:'Inter',sans-serif;white-space:nowrap;display:flex;align-items:center;gap:8px}
      .adm-tab.active{color:#f1f5f9;background:rgba(18,22,40,0.9);border-color:rgba(255,255,255,0.08)}
      .adm-tab .tab-badge{display:inline-flex;align-items:center;justify-content:center;background:#6366f1;color:#fff;border-radius:20px;font-size:.65rem;padding:1px 8px;margin-left:6px;font-weight:700}
      .adm-tab .tab-badge.red{background:#ef4444}
      #adm-body{flex:1;overflow:hidden}
      .adm-pane{display:none;height:100%;overflow-y:auto;padding:20px 24px}
      .adm-pane.active{display:block}
      .adm-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
      .adm-section-title{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;margin-bottom:14px;font-weight:700}
      .adm-sort-select{font-family:'Inter',sans-serif;font-size:.8rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px 14px;color:#94a3b8;outline:none;cursor:pointer;font-weight:500}
      .adm-room-card{background:rgba(10,14,25,0.7);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:20px;margin-bottom:12px}
      .adm-room-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
      .adm-room-name{font-size:.95rem;font-weight:700;color:#f1f5f9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .adm-room-badge{font-size:.7rem;background:rgba(99,102,241,.15);color:#818cf8;padding:5px 12px;border-radius:20px;font-weight:600}
      .adm-room-badge.msgs{color:#94a3b8;background:rgba(255,255,255,0.05)}
      .adm-room-users{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
      .adm-user-chip{display:flex;align-items:center;gap:8px;background:rgba(30,37,56,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:6px 14px 6px 8px;font-size:.75rem;color:#f1f5f9;font-weight:500}
      .adm-user-chip .av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:#fff}
      .adm-room-actions{display:flex;gap:8px;flex-wrap:wrap}
      .adm-btn{font-family:'Inter',sans-serif;font-size:.75rem;font-weight:700;padding:8px 16px;border-radius:10px;border:none;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:8px}
      .adm-btn.ghost{background:rgba(30,37,56,0.8);color:#94a3b8}
      .adm-btn.ghost:hover{background:rgba(40,50,80,0.9);color:#f1f5f9}
      .adm-btn.danger{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)}
      .adm-btn.danger:hover{background:rgba(239,68,68,.25)}
      .adm-btn.primary{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff}
      .adm-btn.primary:hover{background:linear-gradient(135deg,#4f46e5,#9333ea)}
      .adm-btn.warn{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.2)}
      .adm-btn.warn:hover{background:rgba(245,158,11,.25)}
      .adm-user-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-user-row:hover{background:rgba(30,37,56,0.6)}
      .adm-user-av{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:#fff}
      .adm-user-info{flex:1;min-width:0}
      .adm-user-name{font-size:.9rem;font-weight:700;color:#f1f5f9}
      .adm-user-sub{font-size:.7rem;color:#64748b;margin-top:2px;display:flex;gap:12px;flex-wrap:wrap}
      .adm-online-dot{width:10px;height:10px;border-radius:50%;background:#10b981;flex-shrink:0;box-shadow:0 0 12px rgba(16,185,129,.6)}
      .adm-user-actions{display:flex;gap:8px;flex-shrink:0}
      .adm-kick-btn,.adm-warn-btn,.adm-ban-btn{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:none;cursor:pointer}
      .adm-kick-btn{background:rgba(239,68,68,.1);color:#f87171}
      .adm-kick-btn:hover{background:rgba(239,68,68,.25)}
      .adm-warn-btn{background:rgba(245,158,11,.1);color:#fbbf24}
      .adm-warn-btn:hover{background:rgba(245,158,11,.25)}
      .adm-ban-btn{background:rgba(239,68,68,.06);color:#9b2c2c}
      .adm-ban-btn:hover{background:rgba(239,68,68,.2)}
      .adm-msg-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
      .adm-msg-search{flex:1;min-width:160px;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 16px;color:#f1f5f9;outline:none}
      .adm-bulk-bar{display:none;align-items:center;gap:12px;padding:10px 16px;background:rgba(18,22,40,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:12px;font-size:.8rem;color:#94a3b8;font-weight:500}
      .adm-bulk-bar.visible{display:flex}
      .adm-msg-row{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-msg-row:hover{background:rgba(30,37,56,0.5)}
      .adm-msg-row.selected{background:rgba(99,102,241,.1);outline:1px solid rgba(99,102,241,.3)}
      .adm-msg-cb{accent-color:#6366f1;width:18px;height:18px;flex-shrink:0;margin-top:6px;cursor:pointer}
      .adm-msg-av{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;color:#fff;margin-top:2px}
      .adm-msg-body{flex:1;min-width:0}
      .adm-msg-meta{display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap}
      .adm-msg-sender{font-size:.8rem;font-weight:700;color:#94a3b8;cursor:pointer}
      .adm-msg-sender:hover{color:#818cf8}
      .adm-msg-room-tag{font-size:.65rem;background:rgba(99,102,241,.12);color:#818cf8;padding:2px 8px;border-radius:10px;font-weight:600}
      .adm-msg-time{font-size:.65rem;color:#475569;margin-left:auto;font-family:'JetBrains Mono',monospace}
      .adm-msg-text{font-size:.85rem;color:#f1f5f9;word-break:break-word;line-height:1.6}
      .adm-msg-img-thumb{max-width:120px;max-height:90px;border-radius:10px;margin-top:8px;cursor:pointer}
      .adm-msg-reply{font-size:.75rem;color:#64748b;background:rgba(10,14,25,0.8);border-left:3px solid rgba(99,102,241,.5);padding:6px 12px;border-radius:6px;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .adm-msg-actions{display:flex;gap:6px;flex-shrink:0;margin-top:4px}
      .adm-msg-del,.adm-msg-copy{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:none;cursor:pointer}
      .adm-msg-del{background:rgba(239,68,68,.1);color:#f87171}
      .adm-msg-del:hover{background:rgba(239,68,68,.25)}
      .adm-msg-copy{background:rgba(30,37,56,0.8);color:#94a3b8}
      .adm-msg-copy:hover{background:rgba(40,50,80,0.9);color:#f1f5f9}
      .adm-bc-type-row{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap}
      .adm-bc-type{font-family:'Inter',sans-serif;font-size:.78rem;font-weight:700;padding:8px 18px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);background:rgba(10,14,25,0.8);color:#64748b;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
      .adm-bc-type.active{border-color:#6366f1;color:#f1f5f9;background:rgba(99,102,241,.15)}
      .adm-announce-area{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 18px;color:#f1f5f9;outline:none;resize:vertical;min-height:100px;margin-bottom:10px}
      .adm-bc-preview{background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 18px;font-size:.85rem;color:#94a3b8;margin-bottom:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;display:none}
      .adm-bc-preview.visible{display:block}
      .adm-bc-preview-label{font-size:.65rem;color:#475569;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px;font-weight:700}
      .adm-room-select{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 18px;color:#f1f5f9;outline:none;margin-bottom:14px}
      .adm-ban-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-ban-av{width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff}
      .adm-ban-info{flex:1;min-width:0}
      .adm-ban-name{font-size:.9rem;font-weight:700;color:#f87171}
      .adm-ban-meta{font-size:.7rem;color:#64748b;margin-top:2px}
      .adm-unban-btn{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 14px;border-radius:8px;border:none;cursor:pointer;background:rgba(16,185,129,.1);color:#10b981}
      .adm-unban-btn:hover{background:rgba(16,185,129,.25)}
      .adm-log-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap}
      .adm-log-filters{display:flex;gap:8px}
      .adm-log-filter{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:1px solid transparent;cursor:pointer;background:rgba(30,37,56,0.8);color:#64748b}
      .adm-log-filter.active{border-color:currentColor}
      .adm-log-filter.f-info{color:#10b981}.adm-log-filter.f-info.active{background:rgba(16,185,129,.15)}
      .adm-log-filter.f-warn{color:#fbbf24}.adm-log-filter.f-warn.active{background:rgba(245,158,11,.15)}
      .adm-log-filter.f-err{color:#f87171}.adm-log-filter.f-err.active{background:rgba(239,68,68,.15)}
      .adm-log{font-size:.8rem;line-height:1.7;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px 20px;max-height:calc(100vh - 320px);overflow-y:auto}
      .adm-log-entry{padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:10px;align-items:baseline}
      .adm-log-entry.hidden{display:none}
      .adm-log-ts{color:#475569;flex-shrink:0;font-size:.7rem;font-family:'JetBrains Mono',monospace}
      .adm-log-warn{color:#fbbf24}
      .adm-log-info{color:#10b981}
      .adm-log-err{color:#f87171}
      .adm-empty{text-align:center;padding:60px 20px;color:#475569;font-size:.85rem;font-weight:500}
      #adm-shortcuts{position:fixed;bottom:24px;right:24px;z-index:10000;background:rgba(18,22,40,0.9);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 20px;font-size:.7rem;color:#64748b;line-height:2;pointer-events:none;opacity:.8}
      #adm-shortcuts kbd{background:rgba(30,37,56,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:2px 8px;color:#94a3b8;font-size:.65rem;font-weight:600}
    `;
    document.head.appendChild(s);
  }
  if (!document.getElementById('adm-toast-wrap')) {
    const tw = document.createElement('div'); tw.id='adm-toast-wrap';
    document.body.appendChild(tw);
  }
  function admToast(msg, type='info', dur=3500) {
    const wrap = document.getElementById('adm-toast-wrap');
    const t = document.createElement('div');
    t.className='adm-toast '+(type==='success'?'success':type==='warn'?'warn':type==='err'?'err':'');
    const icons = {success:ICON.check,warn:ICON.alert,err:ICON.x,info:ICON.eye};
    t.innerHTML = `<span>${icons[type]||ICON.eye}</span><span>${msg}</span>`;
    wrap.appendChild(t);
    setTimeout(()=>{ t.style.animation='adm-toast-out .3s ease forwards'; setTimeout(()=>t.remove(),300); }, dur);
  }

  const panel = document.createElement('div'); panel.id = 'adminPanel';
  panel.innerHTML = `
    <div id="adm-topbar">
      <div class="brand">
        <div class="brand-icon"><svg class="icon"><use href="#i-shield"/></svg></div>
        <span class="brand-name">ADMIN CONSOLE</span>
        <span class="live-badge"><svg class="icon icon-sm"><use href="#i-radio"/></svg>LIVE</span>
      </div>
      <div style="display:flex;gap:12px;align-items:center">
        <span id="adm-uptime"></span>
        <span id="adm-ts"></span>
        <button id="adm-close">ESC / Close</button>
      </div>
    </div>
    <div id="adm-stats">
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-rooms">—</div><div class="adm-stat-lbl">Rooms</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-users">—</div><div class="adm-stat-lbl">Online</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-msgs">—</div><div class="adm-stat-lbl">Messages</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-rate">—</div><div class="adm-stat-lbl">Msgs/min</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-bans">0</div><div class="adm-stat-lbl">Banned</div></div>
    </div>
    <div id="adm-tabs">
      <button class="adm-tab active" data-tab="rooms">Rooms</button>
      <button class="adm-tab" data-tab="users">Users</button>
      <button class="adm-tab" data-tab="messages">Messages <span class="tab-badge" id="adm-msg-badge">0</span></button>
      <button class="adm-tab" data-tab="broadcast">Broadcast</button>
      <button class="adm-tab" data-tab="bans">Bans <span class="tab-badge red" id="adm-ban-badge" style="display:none">0</span></button>
      <button class="adm-tab" data-tab="log">Log</button>
    </div>
    <div id="adm-body">
      <div class="adm-pane active" id="adm-pane-rooms">
        <div class="adm-toolbar">
          <div class="adm-section-title" style="margin:0;flex:1">Active rooms</div>
          <select class="adm-sort-select" id="adm-room-sort">
            <option value="name">Sort: Name</option>
            <option value="users">Sort: Users</option>
            <option value="msgs">Sort: Messages</option>
          </select>
        </div>
        <div id="adm-room-list"><div class="adm-empty">Loading…</div></div>
      </div>
      <div class="adm-pane" id="adm-pane-users">
        <div class="adm-toolbar">
          <div class="adm-section-title" style="margin:0;flex:1">Currently online</div>
          <select class="adm-sort-select" id="adm-user-sort">
            <option value="name">Sort: Name</option>
            <option value="room">Sort: Room</option>
          </select>
        </div>
        <div id="adm-user-list"><div class="adm-empty">Loading…</div></div>
      </div>
      <div class="adm-pane" id="adm-pane-messages">
        <div class="adm-msg-toolbar">
          <input class="adm-msg-search" id="adm-msg-filter" placeholder="Filter by user, room, text…">
          <select class="adm-sort-select" id="adm-msg-room-filter"><option value="">All rooms</option></select>
        </div>
        <div class="adm-bulk-bar" id="adm-bulk-bar">
          <span id="adm-bulk-count">0 selected</span>
          <button class="adm-btn danger" id="adm-bulk-del">Delete selected</button>
          <button class="adm-btn ghost" id="adm-bulk-cancel">Cancel</button>
        </div>
        <div class="adm-section-title" id="adm-msg-count-lbl">Recent messages</div>
        <div id="adm-msg-list"><div class="adm-empty">Loading…</div></div>
      </div>
      <div class="adm-pane" id="adm-pane-broadcast">
        <div class="adm-section-title">Target room</div>
        <select class="adm-room-select" id="adm-bc-room"><option value="__all__">— All active rooms —</option></select>
        <div class="adm-section-title">Message type</div>
        <div class="adm-bc-type-row">
          <button class="adm-bc-type active" data-type="announce">Announce</button>
          <button class="adm-bc-type" data-type="warning">Warning</button>
          <button class="adm-bc-type" data-type="alert">Alert</button>
          <button class="adm-bc-type" data-type="info">Info</button>
        </div>
        <div class="adm-section-title">Message</div>
        <textarea class="adm-announce-area" id="adm-bc-text" placeholder="Type your announcement…"></textarea>
        <div class="adm-bc-preview" id="adm-bc-preview"><div class="adm-bc-preview-label">Preview</div><div id="adm-bc-preview-text"></div></div>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <button class="adm-btn ghost" id="adm-bc-preview-btn">Preview</button>
          <button class="adm-btn primary" id="adm-bc-send">Send</button>
          <span id="adm-bc-status" style="font-size:.8rem;font-weight:600"></span>
        </div>
      </div>
      <div class="adm-pane" id="adm-pane-bans">
        <div class="adm-section-title">Banned users</div>
        <div id="adm-ban-list"><div class="adm-empty">No bans</div></div>
      </div>
      <div class="adm-pane" id="adm-pane-log">
        <div class="adm-log-toolbar">
          <div class="adm-section-title" style="margin:0">Activity log</div>
          <div class="adm-log-filters">
            <button class="adm-log-filter f-info active" data-f="info">INFO</button>
            <button class="adm-log-filter f-warn active" data-f="warn">WARN</button>
            <button class="adm-log-filter f-err active" data-f="err">ERR</button>
          </div>
          <div style="display:flex;gap:8px">
            <button class="adm-btn ghost" id="adm-log-export">Export</button>
            <button class="adm-btn ghost" id="adm-log-clear">Clear</button>
          </div>
        </div>
        <div class="adm-log" id="adm-log-feed"></div>
      </div>
    </div>
    <div id="adm-shortcuts"><kbd>Esc</kbd> Close &nbsp; <kbd>1-6</kbd> Tabs &nbsp; <kbd>R</kbd> Rooms &nbsp; <kbd>U</kbd> Users &nbsp; <kbd>M</kbd> Msgs &nbsp; <kbd>B</kbd> Broadcast</div>
  `;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);
  function toast(msg, type = 'info') { admToast(msg, type); }

  const LOG_MAX = 200;
  const logEntries = [];
  let logFilters = new Set(['info', 'warn', 'err']);
  const adminLog = (msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    logEntries.unshift({ ts, msg, type });
    if (logEntries.length > LOG_MAX) logEntries.pop();
    const feed = $('adm-log-feed'); if (!feed) return;
    const el = document.createElement('div');
    el.className = 'adm-log-entry' + (!logFilters.has(type) ? ' hidden' : '');
    el.dataset.type = type;
    el.innerHTML = `<span class="adm-log-ts">${ts}</span><span class="adm-log-${type}">${msg}</span>`;
    feed.insertBefore(el, feed.firstChild);
    while (feed.children.length > LOG_MAX) feed.removeChild(feed.lastChild);
  };

  panel.querySelectorAll('.adm-log-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const f = btn.dataset.f;
      if (logFilters.has(f)) { logFilters.delete(f); btn.classList.remove('active'); }
      else { logFilters.add(f); btn.classList.add('active'); }
      document.querySelectorAll('#adm-log-feed .adm-log-entry').forEach(el => {
        el.classList.toggle('hidden', !logFilters.has(el.dataset.type));
      });
    });
  });
  $('adm-log-export').addEventListener('click', () => {
    const text = logEntries.map(e => `[${e.ts}] [${e.type.toUpperCase()}] ${e.msg}`).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    a.download = 'admin-log-' + new Date().toISOString().slice(0, 10) + '.txt';
    a.click();
    adminLog('Log exported', 'info');
  });
  $('adm-log-clear').addEventListener('click', () => { logEntries.length = 0; const f=$('adm-log-feed'); if(f) f.innerHTML=''; });

  const TAB_KEYS = { KeyR:'rooms', KeyU:'users', KeyM:'messages', KeyB:'broadcast', Digit1:'rooms', Digit2:'users', Digit3:'messages', Digit4:'broadcast', Digit5:'bans', Digit6:'log' };
  function switchTab(name) {
    panel.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
    panel.querySelectorAll('.adm-pane').forEach(p => p.classList.remove('active'));
    panel.querySelector(`.adm-tab[data-tab="${name}"]`)?.classList.add('active');
    $('adm-pane-' + name)?.classList.add('active');
  }
  panel.querySelectorAll('.adm-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  function closeAdmin() {
    panel.remove();
    document.getElementById('adm-toast-wrap')?.remove();
    document.getElementById('adm-shortcuts')?.remove();
    onlineRef.off(); msgsRef.off(); bansRef.off();
    mo.disconnect();
    document.removeEventListener('keydown', onAdmKey);
    clearInterval(ticker);
  }
  $('adm-close').addEventListener('click', closeAdmin);
  const onAdmKey = e => {
    if (e.key === 'Escape') { closeAdmin(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    const tab = TAB_KEYS[e.code];
    if (tab) { e.preventDefault(); switchTab(tab); }
  };
  document.addEventListener('keydown', onAdmKey);

  const openedAt = Date.now();
  const ticker = setInterval(() => {
    const ts = $('adm-ts'); if (ts) ts.textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const up = $('adm-uptime'); if (up) {
      const s = Math.floor((Date.now()-openedAt)/1000);
      up.textContent = `↑ ${Math.floor(s/60)}m${String(s%60).padStart(2,'0')}s`;
    }
  }, 1000);

  const roomsData = {};
  const roomMsgCounts = {};
  const activeRooms = () => Object.keys(roomsData);
  let allMsgs = [], msgCount = 0;
  let selectedMsgs = new Set();
  let bcType = 'announce';

  const bansRef = db.ref('bans');
  let bansData = {};
  bansRef.on('value', snap => {
    bansData = snap.exists() ? snap.val() : {};
    let count = 0;
    Object.values(bansData).forEach(users => { count += Object.keys(users || {}).length; });
    const badge = $('adm-ban-badge');
    $('adm-s-bans').textContent = count;
    if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    renderBanList();
  });

  function banUser(uid, name, roomName) {
    UI.confirm(`Ban ${name}? They will be kicked and unable to rejoin this room.`, { okText: 'Ban', danger: true }).then(ok => {
      if (!ok) return;
      db.ref(`bans/${roomName}/${uid}`).set({ name, bannedAt: Date.now(), room: roomName }).then(() => {
        db.ref(`kicked/${roomName}/${uid}`).set(true);
        db.ref(`online/${roomName}/${uid}`).remove();
        adminLog(`Banned ${name} from ${roomName}`, 'err');
        toast(`${name} banned`, 'err');
      });
    });
  }
  function unbanUser(roomName, uid, name) {
    UI.confirm(`Unban ${name}?`, { okText: 'Unban' }).then(ok => {
      if (!ok) return;
      db.ref(`bans/${roomName}/${uid}`).remove().then(() => {
        adminLog(`Unbanned ${name}`, 'warn');
        toast(`${name} unbanned`, 'warn');
      });
    });
  }
  function isBanned(roomName, uid) { return !!(bansData[roomName] && bansData[roomName][uid]); }
  function renderBanList() {
    const bl = $('adm-ban-list'); if (!bl) return;
    bl.innerHTML = '';
    const flat = [];
    Object.entries(bansData).forEach(([roomName, users]) => {
      Object.entries(users || {}).forEach(([uid, d]) => {
        const name = typeof d === 'string' ? d : ((d && d.name) || 'Unknown');
        flat.push({ roomName, uid, name, data: d });
      });
    });
    if (!flat.length) { bl.innerHTML = '<div class="adm-empty">No bans</div>'; return; }
    flat.sort((a, b) => ((b.data && b.data.bannedAt) || 0) - ((a.data && a.data.bannedAt) || 0)).forEach(({ roomName, uid, name, data }) => {
      const row = document.createElement('div'); row.className = 'adm-ban-row';
      const ts = (data && data.bannedAt) ? new Date(data.bannedAt).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
      row.innerHTML = `<div class="adm-ban-av" style="background:${avatarColor(name)}">${avatarInitials(name)}</div><div class="adm-ban-info"><div class="adm-ban-name">${esc(name)}</div><div class="adm-ban-meta">uid: ${uid.slice(0,10)}… · room: #${esc(roomName)} · ${ts}</div></div><button class="adm-unban-btn">Unban</button>`;
      row.querySelector('.adm-unban-btn').addEventListener('click', () => unbanUser(roomName, uid, name));
      bl.appendChild(row);
    });
  }

  function warnUser(u) {
    UI.prompt(`Warn ${u.name} — reason:`, '', { okText: 'Send Warning', title: 'Warn User' }).then(reason => {
      if (!reason || !reason.trim()) return;
      db.ref('messages/' + u.room).push({
        name: 'Moderator', msg: `@${u.name}: ${reason.trim()}`, time: Date.now(), isAnnouncement: true
      }).then(() => {
        adminLog(`Warned ${u.name}: ${reason.trim()}`, 'warn');
        toast(`Warning sent to ${u.name}`, 'warn');
      });
    });
  }

  const onlineRef = db.ref('online');
  onlineRef.on('value', snap => {
    Object.keys(roomsData).forEach(k => delete roomsData[k]);
    const allUsers = [];
    if (snap.exists()) {
      snap.forEach(r => {
        roomsData[r.key] = [];
        r.forEach(u => {
          const banned = isBanned(r.key, u.key);
          const val = u.val();
          const uname = typeof val === 'string' ? val : ((val && val.name) || '?');
          roomsData[r.key].push({ uid: u.key, name: uname, banned });
          allUsers.push({ uid: u.key, name: uname, room: r.key, banned });
        });
      });
    }
    const rNames = activeRooms();
    $('adm-s-rooms').textContent = rNames.length;
    $('adm-s-users').textContent = allUsers.length;

    const sel = $('adm-bc-room');
    if (sel) {
      const prev = sel.value;
      while (sel.options.length > 1) sel.remove(1);
      rNames.forEach(rn => { const o = document.createElement('option'); o.value = rn; o.textContent = '# ' + rn; sel.appendChild(o); });
      if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    }
    const mrf = $('adm-msg-room-filter');
    if (mrf) {
      const prev2 = mrf.value;
      while (mrf.options.length > 1) mrf.remove(1);
      rNames.forEach(rn => { const o = document.createElement('option'); o.value = rn; o.textContent = '# ' + rn; mrf.appendChild(o); });
      if ([...mrf.options].some(o => o.value === prev2)) mrf.value = prev2;
    }
    renderRoomList();
    renderUserList();
  });

  function renderRoomList() {
    const rl = $('adm-room-list'); if (!rl) return;
    let rNames = activeRooms();
    if (!rNames.length) { rl.innerHTML = '<div class="adm-empty">No active rooms</div>'; return; }
    const sort = $('adm-room-sort')?.value || 'name';
    if (sort === 'name') rNames.sort();
    else if (sort === 'users') rNames.sort((a, b) => roomsData[b].length - roomsData[a].length);
    else if (sort === 'msgs') rNames.sort((a, b) => (roomMsgCounts[b] || 0) - (roomMsgCounts[a] || 0));
    rl.innerHTML = '';
    rNames.forEach(rn => {
      const users = roomsData[rn];
      const card = document.createElement('div'); card.className = 'adm-room-card';
      const chips = users.map(u => `<div class="adm-user-chip"><div class="av" style="background:${avatarColor(u.name)}">${avatarInitials(u.name)}</div>${esc(u.name)}${u.banned?' [BANNED]':''}</div>`).join('');
      const msgCnt = roomMsgCounts[rn] ?? '—';
      card.innerHTML = `
        <div class="adm-room-header">
          <span class="adm-room-name"># ${esc(rn)}</span>
          <span class="adm-room-badge">${users.length} users</span>
          <span class="adm-room-badge msgs">${msgCnt} msgs</span>
        </div>
        <div class="adm-room-users">${chips}</div>
        <div class="adm-room-actions">
          <button class="adm-btn warn js-clear-chat">Clear msgs</button>
          <button class="adm-btn ghost js-announce-room">Announce</button>
          <button class="adm-btn danger js-del-room">Delete</button>
        </div>`;
      card.querySelector('.js-clear-chat').addEventListener('click', () => {
        UI.confirm(`Clear ALL messages in #${rn}?`, { okText: 'Clear', danger: true }).then(ok => {
          if (!ok) return;
          ['messages','reactions','readReceipts','pinned'].forEach(k => db.ref(k + '/' + rn).remove());
          adminLog(`Cleared messages in #${rn}`, 'warn');
          toast(`#${rn} messages cleared`, 'warn');
        });
      });
      card.querySelector('.js-announce-room').addEventListener('click', () => {
        switchTab('broadcast');
        const sel = $('adm-bc-room'); if (sel) sel.value = rn;
        setTimeout(() => $('adm-bc-text')?.focus(), 80);
      });
      card.querySelector('.js-del-room').addEventListener('click', () => {
        UI.confirm(`Delete room #${rn}? Cannot be undone.`, { okText: 'Delete', danger: true }).then(ok => {
          if (!ok) return;
          ['messages','online','typing','readReceipts','reactions','pinned','kicked'].forEach(k => db.ref(k + '/' + rn).remove());
          adminLog(`Deleted room #${rn}`, 'err');
          toast(`#${rn} deleted`, 'err');
        });
      });
      rl.appendChild(card);
    });
  }
  $('adm-room-sort').addEventListener('change', renderRoomList);

  function renderUserList() {
    const ul = $('adm-user-list'); if (!ul) return;
    let allUsers = [];
    Object.entries(roomsData).forEach(([r, users]) => users.forEach(u => allUsers.push({ ...u, room: r })));
    if (!allUsers.length) { ul.innerHTML = '<div class="adm-empty">No users online</div>'; return; }
    const sort = $('adm-user-sort')?.value || 'name';
    if (sort === 'name') allUsers.sort((a, b) => a.name.localeCompare(b.name));
    else allUsers.sort((a, b) => a.room.localeCompare(b.room));
    ul.innerHTML = '';
    allUsers.forEach(u => {
      const row = document.createElement('div'); row.className = 'adm-user-row';
      const userMsgCount = allMsgs.filter(m => m.sender === u.name && m.room === u.room).length;
      row.innerHTML = `
        <div class="adm-user-av" style="background:${avatarColor(u.name)}">${avatarInitials(u.name)}</div>
        <div class="adm-user-info">
          <div class="adm-user-name">${esc(u.name)}${u.banned?' [BANNED]':''}</div>
          <div class="adm-user-sub"><span># ${esc(u.room)}</span><span>${userMsgCount} msgs</span></div>
        </div>
        <div class="adm-online-dot"></div>
        <div class="adm-user-actions">
          <button class="adm-warn-btn">Warn</button>
          <button class="adm-kick-btn">Kick</button>
          <button class="adm-ban-btn">Ban</button>
        </div>`;
      row.querySelector('.adm-warn-btn').addEventListener('click', () => warnUser(u));
      row.querySelector('.adm-kick-btn').addEventListener('click', () => {
        UI.confirm(`Kick ${u.name} from #${u.room}?`, { okText: 'Kick', danger: true }).then(ok => {
          if (!ok) return;
          db.ref('kicked/' + u.room + '/' + u.uid).set(true).then(() => db.ref('online/' + u.room + '/' + u.uid).remove());
          adminLog(`Kicked ${u.name} from #${u.room}`, 'warn');
          toast(`${u.name} kicked`, 'warn');
        });
      });
      row.querySelector('.adm-ban-btn').addEventListener('click', () => banUser(u.uid, u.name, u.room));
      ul.appendChild(row);
    });
  }
  $('adm-user-sort').addEventListener('change', renderUserList);

  const msgsRef = db.ref('messages');
  msgsRef.on('value', snap => {
    allMsgs = []; msgCount = 0;
    if (snap.exists()) {
      snap.forEach(roomSnap => {
        const rn = roomSnap.key;
        let cnt = 0;
        roomSnap.forEach(msgSnap => {
          const m = msgSnap.val();
          allMsgs.push({
            key: msgSnap.key, room: rn, sender: m.name || '?', text: m.msg || '',
            time: m.time || 0, hasImg: !!m.imageData, imgData: m.imageData || null,
            replyTo: m.replyTo || null,
            hasFile: !!m.fileData, fileData: m.fileData || null
          });
          msgCount++; cnt++;
        });
        roomMsgCounts[rn] = cnt;
      });
    }
    allMsgs.sort((a, b) => b.time - a.time);
    if (allMsgs.length > 500) allMsgs = allMsgs.slice(0, 500);
    const now = Date.now();
    const recent = allMsgs.filter(m => now - m.time < 60000);
    $('adm-s-msgs').textContent = msgCount;
    $('adm-s-rate').textContent = recent.length;
    $('adm-msg-badge').textContent = msgCount;
    renderMsgList();
    renderRoomList();
  });

  function updateBulkBar() {
    const bar = $('adm-bulk-bar'); if (!bar) return;
    bar.classList.toggle('visible', selectedMsgs.size > 0);
    const cnt = $('adm-bulk-count'); if (cnt) cnt.textContent = selectedMsgs.size + ' selected';
  }
  $('adm-bulk-del').addEventListener('click', () => {
    if (!selectedMsgs.size) return;
    UI.confirm(`Delete ${selectedMsgs.size} messages?`, { okText: 'Delete', danger: true }).then(ok => {
      if (!ok) return;
      selectedMsgs.forEach(id => {
        const [r, key] = id.split('::');
        db.ref('messages/' + r + '/' + key).remove();
      });
      adminLog(`Bulk deleted ${selectedMsgs.size} messages`, 'warn');
      toast(`Deleted ${selectedMsgs.size} messages`, 'warn');
      selectedMsgs.clear(); updateBulkBar();
    });
  });
  $('adm-bulk-cancel').addEventListener('click', () => {
    selectedMsgs.clear(); updateBulkBar();
    document.querySelectorAll('#adm-msg-list .adm-msg-cb').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('#adm-msg-list .adm-msg-row').forEach(r => r.classList.remove('selected'));
  });

  let msgSearchTimeout;
  function renderMsgList() {
    const ml = $('adm-msg-list'); if (!ml) return;
    const kw = ($('adm-msg-filter')?.value || '').toLowerCase().trim();
    const roomF = $('adm-msg-room-filter')?.value || '';
    let filtered = allMsgs;
    if (roomF) filtered = filtered.filter(m => m.room === roomF);
    if (kw) filtered = filtered.filter(m => m.text.toLowerCase().includes(kw) || m.sender.toLowerCase().includes(kw) || m.room.toLowerCase().includes(kw));
    const lbl = $('adm-msg-count-lbl');
    if (lbl) lbl.textContent = filtered.length + ' message' + (filtered.length !== 1 ? 's' : '') + (kw || roomF ? ' (filtered)' : '');
    ml.innerHTML = '';
    if (!filtered.length) {
      ml.innerHTML = '<div class="adm-empty">' + (kw || roomF ? 'No matches' : 'No messages') + '</div>';
      return;
    }
    filtered.forEach(m => {
      const row = document.createElement('div');
      row.className = 'adm-msg-row' + (selectedMsgs.has(m.room + '::' + m.key) ? ' selected' : '');
      let preview = m.text.slice(0, 160) + (m.text.length > 160 ? '…' : '');
      if (m.hasFile) preview = '[FILE: ' + m.fileData.name + ']' + (preview ? ' ' + preview : '');
      const ts = new Date(m.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const replyHtml = m.replyTo ? `<div class="adm-msg-reply">${esc(m.replyTo.name)}: ${esc(m.replyTo.msg || '')}</div>` : '';
      const imgHtml = m.hasImg ? `<img class="adm-msg-img-thumb" src="${m.imgData}" alt="img">` : '';
      row.innerHTML = `
        <input type="checkbox" class="adm-msg-cb" ${selectedMsgs.has(m.room + '::' + m.key) ? 'checked' : ''}>
        <div class="adm-msg-av" style="background:${avatarColor(m.sender)}">${avatarInitials(m.sender)}</div>
        <div class="adm-msg-body">
          <div class="adm-msg-meta">
            <span class="adm-msg-sender">${esc(m.sender)}</span>
            <span class="adm-msg-room-tag">#${esc(m.room)}</span>
            <span class="adm-msg-time">${ts}</span>
          </div>
          ${replyHtml}<div class="adm-msg-text">${esc(preview)}</div>${imgHtml}
        </div>
        <div class="adm-msg-actions">
          <button class="adm-msg-copy">Copy</button>
          <button class="adm-msg-del">Del</button>
        </div>`;
      const cb = row.querySelector('.adm-msg-cb');
      cb.addEventListener('change', () => {
        const id = m.room + '::' + m.key;
        if (cb.checked) selectedMsgs.add(id); else selectedMsgs.delete(id);
        row.classList.toggle('selected', cb.checked);
        updateBulkBar();
      });
      row.querySelector('.adm-msg-sender').addEventListener('click', () => {
        const f = $('adm-msg-filter'); if (f) { f.value = m.sender; renderMsgList(); }
      });
      row.querySelector('.adm-msg-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(m.text).then(() => toast('Copied', 'success')).catch(() => {});
      });
      row.querySelector('.adm-msg-del').addEventListener('click', () => {
        UI.confirm('Delete this message?', { okText: 'Delete', danger: true }).then(ok => {
          if (!ok) return;
          db.ref('messages/' + m.room + '/' + m.key).remove();
          adminLog(`Deleted msg by ${m.sender} in #${m.room}`, 'warn');
          toast('Message deleted', 'warn');
        });
      });
      if (m.hasImg) {
        const thumb = row.querySelector('.adm-msg-img-thumb');
        thumb?.addEventListener('click', () => openLightbox(m.imgData));
      }
      ml.appendChild(row);
    });
  }
  $('adm-msg-filter').addEventListener('input', () => {
    clearTimeout(msgSearchTimeout);
    msgSearchTimeout = setTimeout(renderMsgList, 180);
  });
  $('adm-msg-room-filter').addEventListener('change', renderMsgList);

  panel.querySelectorAll('.adm-bc-type').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.adm-bc-type').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bcType = btn.dataset.type;
    });
  });
  $('adm-bc-preview-btn').addEventListener('click', () => {
    const prev = $('adm-bc-preview');
    const text = $('adm-bc-text')?.value.trim() || '';
    const pt = $('adm-bc-preview-text');
    if (pt) pt.textContent = bcType + ': ' + (text || '(empty)');
    if (prev) prev.classList.toggle('visible');
  });
  $('adm-bc-send').addEventListener('click', () => {
    const text = $('adm-bc-text').value.trim();
    if (!text) { toast('Message is empty', 'err'); return; }
    const target = $('adm-bc-room').value;
    const senderName = bcType + ' System';
    const payload = { name: senderName, msg: text, time: Date.now(), isAnnouncement: true };
    const targets = target === '__all__' ? activeRooms() : [target];
    if (!targets.length) { toast('No active rooms', 'err'); return; }
    const btn = $('adm-bc-send'); btn.disabled = true;
    Promise.all(targets.map(rn => db.ref('messages/' + rn).push(payload)))
      .then(() => {
        const statusMsg = `Sent to ${targets.length} room${targets.length > 1 ? 's' : ''}`;
        const st = $('adm-bc-status');
        if (st) { st.textContent = '✓ ' + statusMsg; st.style.color = '#10b981'; setTimeout(() => { if (st) st.textContent = ''; }, 3000); }
        $('adm-bc-text').value = '';
        $('adm-bc-preview')?.classList.remove('visible');
        adminLog(`Broadcast to ${targets.join(', ')}`, 'info');
        toast(statusMsg, 'success');
      })
      .catch(() => { toast('Broadcast failed', 'err'); })
      .finally(() => { btn.disabled = false; });
  });

  adminLog('Admin console opened', 'info');
  toast('Admin console ready', 'success');

  const mo = new MutationObserver(() => {
    if (!document.getElementById('adminPanel')) {
      onlineRef.off(); msgsRef.off(); bansRef.off();
      mo.disconnect(); clearInterval(ticker);
    }
  });
  mo.observe(document.body, { childList: true });
}

/* ═══════════════════════════════════════════════════════════════
   URL PARAMS
   ═══════════════════════════════════════════════════════════════ */
function parseUrlJoin() {
  const raw = location.search.replace(/^\?/, '');
  if (!raw) return {};
  const dec = v => { try { return decodeURIComponent(v.replace(/\+/g, ' ')).trim(); } catch (e) { return v.trim(); } };
  const ROOM_KEYS = ['room', 'r'];
  const USER_KEYS = ['user', 'name', 'u', 'n', 'username'];
  const MSG_KEYS = ['msg', 'm', 'message', 'text'];
  let r = '', u = '', m = '';
  const bare = [];
  raw.split('&').forEach(part => {
    if (!part) return;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? '' : dec(part.slice(i + 1));
    if (i >= 0 && ROOM_KEYS.includes(k.toLowerCase())) r = v;
    else if (i >= 0 && USER_KEYS.includes(k.toLowerCase())) u = v;
    else if (i >= 0 && MSG_KEYS.includes(k.toLowerCase())) m = v;
    else if (i < 0) bare.push(k);
  });
  if (!r && bare.length) r = bare.shift();
  if (!u && bare.length) u = bare.shift();
  return { room: r, user: u, msg: m };
}
setTimeout(() => {
  const p = parseUrlJoin();
  if (!p.room && !p.user && !p.msg) return;
  if (p.room) document.getElementById('roomInput').value = p.room;
  if (p.user) $joinName.value = p.user;
  if (p.msg) pendingAutoMsg = p.msg;
  if (p.room && $joinName.value.trim()) joinRoom();
  else if (!p.room) document.getElementById('roomInput').focus();
  else $joinName.focus();
}, 0);

const joinCardEl = document.querySelector('.join-card');
if (joinCardEl) {
  document.addEventListener('mousemove', e => {
    if (joinCardEl.offsetParent === null) return;
    const r = joinCardEl.getBoundingClientRect();
    joinCardEl.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
    joinCardEl.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
  }, { passive: true });
}

})();
