/* ═══════════════════════════════════════════════════════════════
   CHAT ROOM — Firebase + PeerJS (WebRTC)
   Replaces alert/confirm/prompt with custom dialogs
   Ringtone: ./ringtone.m4a loops on incoming call
   ═══════════════════════════════════════════════════════════════ */
(function () {
"use strict";

/* ─── Firebase ─── */
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
   CUSTOM DIALOG / TOAST SYSTEM (replaces alert/confirm/prompt)
   ═══════════════════════════════════════════════════════════════ */
const UI = (() => {
  const backdrop = document.getElementById('appDialog');
  const titleEl  = document.getElementById('appDialogTitle');
  const msgEl    = document.getElementById('appDialogMessage');
  const inputEl  = document.getElementById('appDialogInput');
  const okBtn    = document.getElementById('appDialogOk');
  const cancelBtn= document.getElementById('appDialogCancel');
  const toastEl  = document.getElementById('appToast');

  let resolver = null;

  function resetButtons() {
    const oldOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(oldOk, okBtn);
    const oldCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(oldCancel, cancelBtn);
    return { okBtn: oldOk, cancelBtn: oldCancel };
  }

  function close(result) {
    backdrop.classList.remove('show');
    if (resolver) { const r = resolver; resolver = null; r(result); }
  }

  function open(opts) {
    return new Promise(resolve => {
      resolver = resolve;
      titleEl.textContent = opts.title || '';
      msgEl.textContent   = opts.message || '';
      msgEl.style.display = opts.message ? '' : 'none';

      if (opts.type === 'prompt') {
        inputEl.style.display = '';
        inputEl.value = opts.defaultValue || '';
        inputEl.placeholder = opts.placeholder || '';
      } else {
        inputEl.style.display = 'none';
      }

      const { okBtn: ok, cancelBtn: cancel } = resetButtons();
      ok.textContent = opts.okText || 'OK';
      cancel.textContent = opts.cancelText || 'Cancel';
      cancel.style.display = (opts.type === 'alert') ? 'none' : '';

      if (opts.danger) ok.classList.add('danger');
      else ok.classList.remove('danger');

      backdrop.classList.add('show');

      setTimeout(() => {
        if (opts.type === 'prompt') inputEl.focus();
        else ok.focus();
      }, 50);

      const finish = (val) => {
        close(val);
        document.removeEventListener('keydown', onKey);
      };

      ok.addEventListener('click', () => {
        if (opts.type === 'prompt') finish(inputEl.value);
        else finish(true);
      });
      cancel.addEventListener('click', () => finish(opts.type === 'prompt' ? null : false));

      backdrop.addEventListener('click', e => {
        if (e.target === backdrop && opts.type !== 'alert') {
          finish(opts.type === 'prompt' ? null : false);
        }
      }, { once: true });

      const onKey = (e) => {
        if (e.key === 'Enter' && opts.type !== 'alert') {
          e.preventDefault();
          if (opts.type === 'prompt') finish(inputEl.value);
          else finish(true);
        } else if (e.key === 'Escape' && opts.type !== 'alert') {
          e.preventDefault();
          finish(opts.type === 'prompt' ? null : false);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  let toastTimer = null;
  function toast(msg, type = 'info', dur = 3000) {
    if (!toastEl) return;
    toastEl.className = 'app-toast ' + type;
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), dur);
  }

  return {
    alert:   (message, opts = {}) => open({ type: 'alert',   title: opts.title || 'Notice',  message, okText: 'OK', ...opts }),
    confirm: (message, opts = {}) => open({ type: 'confirm', title: opts.title || 'Confirm', message, okText: opts.okText || 'OK', cancelText: opts.cancelText || 'Cancel', ...opts }),
    prompt:  (message, defaultValue = '', opts = {}) => open({ type: 'prompt', title: opts.title || 'Input', message, defaultValue, placeholder: opts.placeholder || '', okText: opts.okText || 'OK', cancelText: opts.cancelText || 'Cancel' }),
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

/* ─── PeerJS state ─── */
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

/* ─── Admin modal refs ─── */
const $adminModal      = document.getElementById('adminAuthModal');
const $adminPwInput    = document.getElementById('adminPwInput');
const $adminAttemptMsg = document.getElementById('authAttemptMsg');

/* iOS audio unlock */
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
  /* Unlock <audio id="ring"> so future programmatic play() is allowed on iOS */
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

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
function setupKickListener() {
  db.ref('kicked/' + room + '/' + userId).on('value', snap => {
    if (snap.exists() && snap.val() === true) { snap.ref.remove(); showKickedScreen(); }
  });
}
function setupBanListener() {
  db.ref(`bans/${room}/${userId}`).on('value', snap => {
    if (snap.exists()) showBannedScreen();
  });
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

/* ═══════════════════════════════════════════════════════════════
   DARK / SOUND / RINGTONE
   ═══════════════════════════════════════════════════════════════ */
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

/* Short single-shot ping for new messages */
function playRing() {
  if (!soundEnabled) return;
  if (!$ring) return;
  $ring.loop = false;
  $ring.currentTime = 0;
  $ring.play().catch(() => {});
}

/* Loop ringtone for incoming calls */
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

/* ═══════════════════════════════════════════════════════════════
   EMOJI PICKER
   ═══════════════════════════════════════════════════════════════ */
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
   IMAGE
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
document.getElementById('attachBtn').addEventListener('click', e => {
  haptic(10); addRipple(e.currentTarget, e);
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', async function (e) {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 15 * 1024 * 1024) { UI.toast('Image must be under 15 MB', 'error'); return; }
  $sendBtn.disabled = true; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';
  try {
    const dataUrl = await compressImage(file, 800, 0.75);
    pendingImage = { dataUrl, name: file.name };
    $imgPreviewThumb.src = dataUrl;
    $imgPreviewName.textContent = file.name;
    $imgPreviewBar.classList.add('visible');
  } catch { UI.toast('Failed to process image', 'error'); }
  finally { $sendBtn.disabled = false; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>'; }
  e.target.value = '';
});
document.getElementById('clearImg').addEventListener('click', clearImage);
function clearImage() { pendingImage = null; $imgPreviewBar.classList.remove('visible'); $imgPreviewThumb.src = ''; }

async function handlePastedImage(file) {
  if (!room) return;
  if (file.size > 15 * 1024 * 1024) { UI.toast('Image must be under 15 MB', 'error'); return; }
  $sendBtn.disabled = true; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';
  try {
    const dataUrl = await compressImage(file, 800, 0.75);
    pendingImage = { dataUrl, name: file.name || 'pasted-image.jpg' };
    $imgPreviewThumb.src = dataUrl;
    $imgPreviewName.textContent = pendingImage.name;
    $imgPreviewBar.classList.add('visible');
    $msgInput.focus();
  } catch { UI.toast('Failed to process pasted image', 'error'); }
  finally { $sendBtn.disabled = false; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>'; }
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

/* ═══════════════════════════════════════════════════════════════
   ONLINE / ADMIN SECRET
   ═══════════════════════════════════════════════════════════════ */
document.getElementById('onlineBtn').addEventListener('click', () => {
  haptic(8); $onlineTooltip.classList.toggle('show');
});
document.addEventListener('click', e => {
  if (!e.target.closest('#onlineWrap')) $onlineTooltip.classList.remove('show');
});
document.getElementById('adminSecretBtn').addEventListener('click', () => { window.admin(); });

function updateOnlineUI() {
  const names = Object.values(onlineUsers).map(u => typeof u === 'string' ? u : (u && u.name) || '?');
  $onlineCount.textContent = names.length;
  const frag = document.createDocumentFragment();
  names.forEach(n => { const li = document.createElement('li'); li.textContent = n; frag.appendChild(li); });
  $onlineList.innerHTML = '';
  $onlineList.appendChild(frag);
}

/* ═══════════════════════════════════════════════════════════════
   REPLY / PIN
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   SCROLL
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   OFFLINE / VISIBILITY
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   VIEWPORT (only used in chat)
   ═══════════════════════════════════════════════════════════════ */
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
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
}
window.addEventListener('resize', syncViewport);
syncViewport();

/* ═══════════════════════════════════════════════════════════════
   JOIN
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   ONLINE TRACKING
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   TYPING
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   SEND
   ═══════════════════════════════════════════════════════════════ */
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
  if (pendingImage) msg.imageData = pendingImage.dataUrl;
  if (replyingTo)   msg.replyTo = { key: replyingTo.key, name: replyingTo.name, msg: replyingTo.msg };
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

/* ═══════════════════════════════════════════════════════════════
   EDIT MESSAGE
   ═══════════════════════════════════════════════════════════════ */
async function editMessage(key, currentText) {
  const newText = await UI.prompt('Edit your message:', currentText, { okText: 'Save', title: 'Edit Message' });
  if (newText === null) return;
  const clean = newText.replace(/<[^>]*>/g, '');
  if (!clean.trim()) { UI.toast('Message cannot be empty', 'warn'); return; }
  db.ref('messages/' + room + '/' + key).update({ msg: clean, edited: true });
}

/* ═══════════════════════════════════════════════════════════════
   REACTIONS
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   READ RECEIPTS
   ═══════════════════════════════════════════════════════════════ */
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
      btn.className = 'read-btn'; btn.innerHTML = ICON.eye + ' Seen';
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

/* ═══════════════════════════════════════════════════════════════
   REACTION PICKER
   ═══════════════════════════════════════════════════════════════ */
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

/* ═══════════════════════════════════════════════════════════════
   LIGHTBOX / CONTEXT MENU
   ═══════════════════════════════════════════════════════════════ */
const $lightbox = document.getElementById('lightbox');
const $lightboxImg = document.getElementById('lightboxImg');
$lightbox.addEventListener('click', () => $lightbox.classList.remove('open'));
function openLightbox(src) { $lightboxImg.src = src; $lightbox.classList.add('open'); }

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

/* ═══════════════════════════════════════════════════════════════
   DISPLAY MESSAGE
   ═══════════════════════════════════════════════════════════════ */
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
    </div>
    <div class="read-indicator" id="read-${key}"></div>`;
  if (m.imageData) {
    const img = li.querySelector('.msg-img');
    img.src = m.imageData;
    img.onerror = () => { img.style.display = 'none'; };
    img.addEventListener('click', e => { e.stopPropagation(); openLightbox(img.src); });
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
   PEERJS CALL MODULE — full-screen call page
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
  if (!text) {
    $callStatusEl.classList.remove('show', 'active', 'error');
    $callStatusEl.textContent = '';
    return;
  }
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

/* ─── Call page: open / close ─── */
function openCallPage(peerName, isVideo) {
  document.body.classList.add('call-active');
  $callPage.classList.toggle('video-mode', isVideo);

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
  $callPage.classList.remove('show', 'video-mode');
  document.body.classList.remove('call-active');
  $callRemoteVideo.srcObject = null;
  $callLocalVideo.srcObject = null;
}

/* ─── Call handlers ─── */
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

    const isVideo = callMode === 'video';
    $callPeerSub.textContent = isVideo ? 'Video call' : 'Voice call';

    if (isVideo) {
      $callRemoteVideo.srcObject = remoteStream;
      tryPlay($callRemoteVideo);
      if (localStream) {
        $callLocalVideo.srcObject = localStream;
        tryPlay($callLocalVideo);
      }
    } else {
      // voice only → still need to hear them
      $remoteAudio.srcObject = remoteStream;
      tryPlay($remoteAudio);
    }

    updateCallUI(true);
    startCallTimer();
    requestWakeLock();
    haptic(20);
  });

  call.on('close', () => {
    stopRingtone();
    $callPeerSub.textContent = 'Call ended';
    setTimeout(() => { closeCallPage(); cleanupCall(); }, 600);
  });
  call.on('error', () => {
    stopRingtone();
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

  // Show call page immediately
  openCallPage(targetName, needVideo);
  $callPeerSub.textContent = 'Requesting device permission…';

  localStream = await getLocalStream(needVideo);
  if (!localStream) {
    closeCallPage();
    callMode = null;
    return;
  }

  // For video calls show local preview right away
  if (needVideo) {
    $callLocalVideo.srcObject = localStream;
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
  const needVideo = !!meta.video;
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
    $callPeerSub.textContent = 'Cannot access device';
    try { call.close(); } catch (e) {}
    setTimeout(() => { closeCallPage(); cleanupCall(); }, 1500);
    return;
  }
  if (needVideo) {
    $callLocalVideo.srcObject = localStream;
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
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
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

  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }

  if ($remoteAudio) $remoteAudio.srcObject = null;
  if ($remoteVideo) $remoteVideo.srcObject = null;
  if ($localVideo)  $localVideo.srcObject  = null;

  $callRemoteVideo.srcObject = null;
  $callLocalVideo.srcObject = null;

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

/* ─── Call page controls ─── */
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

    // Replace the track in the active RTCPeerConnection
    const sender = currentCall?.peerConnection
      ?.getSenders()
      .find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newVideoTrack);

    // Replace local stream video track
    const oldVideoTrack = localStream.getVideoTracks()[0];
    if (oldVideoTrack) { localStream.removeTrack(oldVideoTrack); oldVideoTrack.stop(); }
    localStream.addTrack(newVideoTrack);

    // Update local preview & mirror state
    $callLocalVideo.srcObject = localStream;
    $callLocalVideo.play().catch(() => {});
    $callLocalVideo.style.transform = newFacing === 'user' ? 'scaleX(-1)' : 'scaleX(1)';

    currentFacingMode = newFacing;
    haptic(15);
  } catch (err) {
    console.error('[switchCamera] failed:', err);
    UI.toast('Could not switch camera', 'error');
  }
});

/* ─── Entry buttons on the chat header ─── */
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

/* Full admin console (compact but functional) */
function openAdminConsole() {
  if (!document.getElementById('adminCSS')) {
    const s = document.createElement('style'); s.id = 'adminCSS';
    s.textContent = `
      #adminPanel{position:fixed;inset:0;z-index:9999;background:#06070f;color:#f1f5f9;font-family:'Inter',sans-serif;display:flex;flex-direction:column;overflow:hidden}
      #adm-topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;background:rgba(18,22,40,0.7);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;gap:16px}
      #adm-topbar .brand{display:flex;align-items:center;gap:12px;flex-shrink:0}
      #adm-topbar .brand-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#a855f7);display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0}
      #adm-topbar .brand-name{font-size:.95rem;font-weight:800;letter-spacing:.1em}
      #adm-close{background:rgba(30,37,56,0.8);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;padding:8px 18px;border-radius:10px;cursor:pointer;font-family:'Inter',sans-serif;font-size:.8rem;font-weight:600}
      #adm-stats{display:flex;gap:1px;background:rgba(255,255,255,0.05);flex-shrink:0}
      .adm-stat{flex:1;padding:16px 20px;background:rgba(10,14,25,0.8);display:flex;flex-direction:column;gap:6px;min-width:0}
      .adm-stat-val{font-size:1.6rem;font-weight:800;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .adm-stat-lbl{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;font-weight:600}
      #adm-tabs{display:flex;gap:4px;padding:12px 24px 0;background:rgba(10,14,25,0.8);flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.08);overflow-x:auto}
      .adm-tab{padding:10px 20px;border-radius:10px 10px 0 0;font-size:.8rem;font-weight:700;cursor:pointer;border:1px solid transparent;border-bottom:none;color:#64748b;background:none;font-family:'Inter',sans-serif}
      .adm-tab.active{color:#f1f5f9;background:rgba(18,22,40,0.9);border-color:rgba(255,255,255,0.08)}
      #adm-body{flex:1;overflow:hidden}
      .adm-pane{display:none;height:100%;overflow-y:auto;padding:20px 24px}
      .adm-pane.active{display:block}
      .adm-section-title{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;margin-bottom:14px;font-weight:700}
      .adm-room-card{background:rgba(10,14,25,0.7);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:20px;margin-bottom:12px}
      .adm-room-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
      .adm-room-name{font-size:.95rem;font-weight:700;color:#f1f5f9;flex:1}
      .adm-room-badge{font-size:.7rem;background:rgba(99,102,241,.15);color:#818cf8;padding:5px 12px;border-radius:20px;font-weight:600}
      .adm-room-users{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
      .adm-user-chip{display:flex;align-items:center;gap:8px;background:rgba(30,37,56,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:6px 14px 6px 8px;font-size:.75rem;color:#f1f5f9}
      .adm-user-chip .av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:#fff}
      .adm-room-actions{display:flex;gap:8px;flex-wrap:wrap}
      .adm-btn{font-family:'Inter',sans-serif;font-size:.75rem;font-weight:700;padding:8px 16px;border-radius:10px;border:none;cursor:pointer;display:inline-flex;align-items:center;gap:8px}
      .adm-btn.ghost{background:rgba(30,37,56,0.8);color:#94a3b8}
      .adm-btn.danger{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)}
      .adm-btn.primary{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff}
      .adm-btn.warn{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.2)}
      .adm-user-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-user-av{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:#fff}
      .adm-user-info{flex:1;min-width:0}
      .adm-user-name{font-size:.9rem;font-weight:700;color:#f1f5f9}
      .adm-user-sub{font-size:.7rem;color:#64748b;margin-top:2px}
      .adm-user-actions{display:flex;gap:8px}
      .adm-kick-btn,.adm-ban-btn{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:none;cursor:pointer}
      .adm-kick-btn{background:rgba(239,68,68,.1);color:#f87171}
      .adm-ban-btn{background:rgba(239,68,68,.06);color:#9b2c2c}
      .adm-msg-row{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-msg-av{width:32px;height:32px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:700;color:#fff}
      .adm-msg-body{flex:1;min-width:0}
      .adm-msg-meta{display:flex;align-items:center;gap:10px;margin-bottom:4px}
      .adm-msg-sender{font-size:.8rem;font-weight:700;color:#94a3b8}
      .adm-msg-room-tag{font-size:.65rem;background:rgba(99,102,241,.12);color:#818cf8;padding:2px 8px;border-radius:10px;font-weight:600}
      .adm-msg-time{font-size:.65rem;color:#475569;margin-left:auto;font-family:'JetBrains Mono',monospace}
      .adm-msg-text{font-size:.85rem;color:#f1f5f9;word-break:break-word;line-height:1.6}
      .adm-msg-del{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:none;cursor:pointer;background:rgba(239,68,68,.1);color:#f87171}
      .adm-msg-search{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 16px;color:#f1f5f9;outline:none;margin-bottom:14px}
      .adm-announce-area{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 18px;color:#f1f5f9;outline:none;resize:vertical;min-height:100px;margin-bottom:10px}
      .adm-room-select{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 18px;color:#f1f5f9;outline:none;margin-bottom:14px}
      .adm-empty{text-align:center;padding:60px 20px;color:#475569;font-size:.85rem}
    `;
    document.head.appendChild(s);
  }

  const panel = document.createElement('div'); panel.id = 'adminPanel';
  panel.innerHTML = `
    <div id="adm-topbar">
      <div class="brand">
        <div class="brand-icon"><svg class="icon"><use href="#i-shield"/></svg></div>
        <span class="brand-name">ADMIN CONSOLE</span>
      </div>
      <button id="adm-close">Close</button>
    </div>
    <div id="adm-stats">
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-rooms">—</div><div class="adm-stat-lbl">Rooms</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-users">—</div><div class="adm-stat-lbl">Online</div></div>
      <div class="adm-stat"><div class="adm-stat-val" id="adm-s-msgs">—</div><div class="adm-stat-lbl">Messages</div></div>
    </div>
    <div id="adm-tabs">
      <button class="adm-tab active" data-tab="rooms">Rooms</button>
      <button class="adm-tab" data-tab="users">Users</button>
      <button class="adm-tab" data-tab="messages">Messages</button>
      <button class="adm-tab" data-tab="broadcast">Broadcast</button>
    </div>
    <div id="adm-body">
      <div class="adm-pane active" id="adm-pane-rooms"><div id="adm-room-list"><div class="adm-empty">Loading…</div></div></div>
      <div class="adm-pane" id="adm-pane-users"><div id="adm-user-list"><div class="adm-empty">Loading…</div></div></div>
      <div class="adm-pane" id="adm-pane-messages">
        <input class="adm-msg-search" id="adm-msg-filter" placeholder="Filter by user, room, text…">
        <div id="adm-msg-list"><div class="adm-empty">Loading…</div></div>
      </div>
      <div class="adm-pane" id="adm-pane-broadcast">
        <div class="adm-section-title">Target room</div>
        <select class="adm-room-select" id="adm-bc-room"><option value="__all__">— All active rooms —</option></select>
        <div class="adm-section-title">Message</div>
        <textarea class="adm-announce-area" id="adm-bc-text" placeholder="Type your announcement…"></textarea>
        <div style="display:flex;gap:12px;align-items:center">
          <button class="adm-btn primary" id="adm-bc-send">Send</button>
          <span id="adm-bc-status" style="font-size:.8rem;font-weight:600;color:#10b981"></span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const $ = id => document.getElementById(id);

  const roomsData = {};
  const activeRooms = () => Object.keys(roomsData);
  let allMsgs = [];

  panel.querySelectorAll('.adm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
      panel.querySelectorAll('.adm-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('adm-pane-' + btn.dataset.tab).classList.add('active');
    });
  });

  function closeAdmin() {
    panel.remove();
    onlineRef.off(); msgsRef.off();
    clearInterval(ticker);
  }
  $('adm-close').addEventListener('click', closeAdmin);

  const ticker = setInterval(() => {}, 1000);

  const onlineRef = db.ref('online');
  onlineRef.on('value', snap => {
    Object.keys(roomsData).forEach(k => delete roomsData[k]);
    const allUsers = [];
    if (snap.exists()) {
      snap.forEach(r => {
        roomsData[r.key] = [];
        r.forEach(u => {
          const val = u.val();
          const uname = typeof val === 'string' ? val : ((val && val.name) || '?');
          roomsData[r.key].push({ uid: u.key, name: uname });
          allUsers.push({ uid: u.key, name: uname, room: r.key });
        });
      });
    }
    $('adm-s-rooms').textContent = activeRooms().length;
    $('adm-s-users').textContent = allUsers.length;

    const sel = $('adm-bc-room');
    const prev = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    activeRooms().forEach(rn => {
      const o = document.createElement('option'); o.value = rn; o.textContent = '# ' + rn;
      sel.appendChild(o);
    });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;

    renderRoomList();
    renderUserList();
  });

  function renderRoomList() {
    const rl = $('adm-room-list');
    const rNames = activeRooms();
    if (!rNames.length) { rl.innerHTML = '<div class="adm-empty">No active rooms</div>'; return; }
    rl.innerHTML = '';
    rNames.forEach(rn => {
      const users = roomsData[rn];
      const card = document.createElement('div'); card.className = 'adm-room-card';
      card.innerHTML = `
        <div class="adm-room-header">
          <span class="adm-room-name"># ${esc(rn)}</span>
          <span class="adm-room-badge">${users.length} users</span>
        </div>
        <div class="adm-room-users">${users.map(u => `<div class="adm-user-chip"><div class="av" style="background:${avatarColor(u.name)}">${avatarInitials(u.name)}</div>${esc(u.name)}</div>`).join('')}</div>
        <div class="adm-room-actions">
          <button class="adm-btn warn js-clear">Clear msgs</button>
          <button class="adm-btn danger js-del">Delete</button>
        </div>`;
      card.querySelector('.js-clear').addEventListener('click', async () => {
        const ok = await UI.confirm('Clear all messages in #' + rn + '?', { okText: 'Clear', danger: true });
        if (ok) ['messages','reactions','readReceipts','pinned'].forEach(k => db.ref(k + '/' + rn).remove());
      });
      card.querySelector('.js-del').addEventListener('click', async () => {
        const ok = await UI.confirm('Delete room #' + rn + '?', { okText: 'Delete', danger: true });
        if (ok) ['messages','online','typing','readReceipts','reactions','pinned','kicked'].forEach(k => db.ref(k + '/' + rn).remove());
      });
      rl.appendChild(card);
    });
  }

  function renderUserList() {
    const ul = $('adm-user-list');
    let allUsers = [];
    Object.entries(roomsData).forEach(([r, users]) => users.forEach(u => allUsers.push({ ...u, room: r })));
    if (!allUsers.length) { ul.innerHTML = '<div class="adm-empty">No users online</div>'; return; }
    ul.innerHTML = '';
    allUsers.forEach(u => {
      const row = document.createElement('div'); row.className = 'adm-user-row';
      row.innerHTML = `
        <div class="adm-user-av" style="background:${avatarColor(u.name)}">${avatarInitials(u.name)}</div>
        <div class="adm-user-info">
          <div class="adm-user-name">${esc(u.name)}</div>
          <div class="adm-user-sub"># ${esc(u.room)}</div>
        </div>
        <div class="adm-user-actions">
          <button class="adm-kick-btn">Kick</button>
          <button class="adm-ban-btn">Ban</button>
        </div>`;
      row.querySelector('.adm-kick-btn').addEventListener('click', async () => {
        const ok = await UI.confirm('Kick ' + u.name + '?', { okText: 'Kick', danger: true });
        if (!ok) return;
        db.ref('kicked/' + u.room + '/' + u.uid).set(true).then(() => db.ref('online/' + u.room + '/' + u.uid).remove());
      });
      row.querySelector('.adm-ban-btn').addEventListener('click', async () => {
        const ok = await UI.confirm('Ban ' + u.name + '?', { okText: 'Ban', danger: true });
        if (!ok) return;
        db.ref('bans/' + u.room + '/' + u.uid).set({ name: u.name, bannedAt: Date.now(), room: u.room });
        db.ref('kicked/' + u.room + '/' + u.uid).set(true);
      });
      ul.appendChild(row);
    });
  }

  const msgsRef = db.ref('messages');
  msgsRef.on('value', snap => {
    allMsgs = [];
    if (snap.exists()) {
      snap.forEach(roomSnap => {
        const rn = roomSnap.key;
        roomSnap.forEach(msgSnap => {
          const m = msgSnap.val();
          allMsgs.push({ key: msgSnap.key, room: rn, sender: m.name || '?', text: m.msg || '', time: m.time || 0 });
        });
      });
    }
    allMsgs.sort((a, b) => b.time - a.time);
    if (allMsgs.length > 500) allMsgs = allMsgs.slice(0, 500);
    $('adm-s-msgs').textContent = allMsgs.length;
    renderMsgList();
  });

  function renderMsgList() {
    const ml = $('adm-msg-list');
    const kw = ($('adm-msg-filter')?.value || '').toLowerCase().trim();
    let filtered = allMsgs;
    if (kw) filtered = filtered.filter(m => m.text.toLowerCase().includes(kw) || m.sender.toLowerCase().includes(kw));
    if (!filtered.length) { ml.innerHTML = '<div class="adm-empty">No messages</div>'; return; }
    ml.innerHTML = '';
    filtered.forEach(m => {
      const row = document.createElement('div'); row.className = 'adm-msg-row';
      row.innerHTML = `
        <div class="adm-msg-av" style="background:${avatarColor(m.sender)}">${avatarInitials(m.sender)}</div>
        <div class="adm-msg-body">
          <div class="adm-msg-meta">
            <span class="adm-msg-sender">${esc(m.sender)}</span>
            <span class="adm-msg-room-tag">#${esc(m.room)}</span>
            <span class="adm-msg-time">${new Date(m.time).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span>
          </div>
          <div class="adm-msg-text">${esc(m.text.slice(0, 200))}</div>
        </div>
        <button class="adm-msg-del">Del</button>`;
      row.querySelector('.adm-msg-del').addEventListener('click', async () => {
        const ok = await UI.confirm('Delete this message?', { okText: 'Delete', danger: true });
        if (ok) db.ref('messages/' + m.room + '/' + m.key).remove();
      });
      ml.appendChild(row);
    });
  }
  $('adm-msg-filter').addEventListener('input', renderMsgList);

  $('adm-bc-send').addEventListener('click', () => {
    const text = $('adm-bc-text').value.trim();
    if (!text) { UI.toast('Message is empty', 'err'); return; }
    const target = $('adm-bc-room').value;
    const targets = target === '__all__' ? activeRooms() : [target];
    if (!targets.length) { UI.toast('No active rooms', 'err'); return; }
    Promise.all(targets.map(rn => db.ref('messages/' + rn).push({
      name: 'Announce System', msg: text, time: Date.now(), isAnnouncement: true
    }))).then(() => {
      UI.toast('Sent to ' + targets.length + ' rooms', 'success');
      $('adm-bc-text').value = '';
    });
  });
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

/* ═══════════════════════════════════════════════════════════════
   JOIN CARD MOUSE FOLLOW (desktop only)
   ═══════════════════════════════════════════════════════════════ */
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
