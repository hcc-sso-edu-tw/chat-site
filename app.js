/* ═══════════════════════════════════════════════════════════════
   CHAT ROOM — Firebase + PeerJS (WebRTC) Voice/Video Call
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

const ADMIN_PASSWORD_HASH = "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918";
const MAX_ATTEMPTS = 3;
let adminAttempts  = parseInt(sessionStorage.getItem('adminAttempts') || '0');
let adminLockUntil = parseInt(sessionStorage.getItem('adminLock') || '0');

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

let userId = localStorage.getItem('chatUserId');
if (!userId) { userId = Math.random().toString(36).slice(2, 11); localStorage.setItem('chatUserId', userId); }

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

/* ─── iOS audio unlock ─── */
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
}
document.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
document.addEventListener('click', unlockAudio, { once: true });

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
/* Admin modal DOM refs */
const $adminModal      = document.getElementById('adminAuthModal');
const $adminPwInput    = document.getElementById('adminPwInput');
const $adminAttemptMsg = document.getElementById('authAttemptMsg');

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
  ks.querySelector('p').textContent = 'You are banned — An admin has permanently banned you from this room.';
  $app.style.display = 'none';
  ks.classList.add('show');
  if (room) {
    db.ref('online/' + room + '/' + userId).remove();
    db.ref('typing/' + room + '/' + userId).remove();
  }
}

const PALETTE = ['#6366f1','#f97316','#06b6d4','#10b981','#ec4899','#f59e0b','#8b5cf6','#14b8a6','#ef4444','#3b82f6'];
function avatarColor(n) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return PALETTE[Math.abs(h) % PALETTE.length]; }
function avatarInitials(n) { return n.trim().slice(0, 2).toUpperCase(); }
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
  const a = document.getElementById('ring');
  a.currentTime = 0; a.play().catch(() => {});
}

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
  if (file.size > 15 * 1024 * 1024) { alert('Image must be under 15 MB'); return; }
  $sendBtn.disabled = true; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-clock"/></svg>';
  try {
    const dataUrl = await compressImage(file, 800, 0.75);
    pendingImage = { dataUrl, name: file.name };
    $imgPreviewThumb.src = dataUrl;
    $imgPreviewName.textContent = file.name;
    $imgPreviewBar.classList.add('visible');
  } catch { alert('Failed to process image.'); }
  finally { $sendBtn.disabled = false; $sendBtn.innerHTML = '<svg class="icon"><use href="#i-send"/></svg>'; }
  e.target.value = '';
});
document.getElementById('clearImg').addEventListener('click', clearImage);
function clearImage() { pendingImage = null; $imgPreviewBar.classList.remove('visible'); $imgPreviewThumb.src = ''; }

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

document.getElementById('cancelReply').addEventListener('click', cancelReply);
function cancelReply() { replyingTo = null; $replyBanner.classList.remove('visible'); }
function startReply(key, name, text) {
  haptic(12);
  replyingTo = { key, name, msg: text };
  $replyPreview.textContent = name + ': ' + text;
  $replyBanner.classList.add('visible');
  $msgInput.focus();
}
document.getElementById('unpinBtn').addEventListener('click', e => {
  e.stopPropagation();
  if (confirm('Unpin this message?')) db.ref('pinned/' + room).remove();
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
function pinMessage(key, text) {
  if (!confirm('Pin this message?')) return;
  db.ref('pinned/' + room).set({ key, msg: (text || '') });
}

function isAtBottom() { return $chatEl.scrollTop + $chatEl.clientHeight >= $chatEl.scrollHeight - 80; }
function scrollToBottom(force) {
  if (force || !userHasScrolledUp) {
    $chatEl.scrollTop = $chatEl.scrollHeight;
    userHasScrolledUp = false;
    updateScrollBtn();
  }
}
window.scrollToBottom = scrollToBottom;
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

let _vpRaf = null;
function syncViewport() {
  if (_vpRaf) cancelAnimationFrame(_vpRaf);
  _vpRaf = requestAnimationFrame(() => {
    const vv = window.visualViewport;
    if (vv) document.documentElement.style.setProperty('--app-height', `${vv.height}px`);
    else document.documentElement.style.setProperty('--app-height', `100dvh`);
    if (window.scrollY) window.scrollTo(0, 0);
  });
}
function onResize() {
  const stick = document.activeElement === $msgInput && !userHasScrolledUp;
  syncViewport();
  if (stick) instantBottom();
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', onResize);
  window.visualViewport.addEventListener('scroll', onResize);
} else window.addEventListener('resize', onResize);
window.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); }, { passive: true });
syncViewport();

const $joinName = document.getElementById('joinName');
const _savedName = localStorage.getItem('chatName');
if (_savedName) $joinName.value = _savedName;

let _joining = false;
const $joinBtn = document.getElementById('joinBtn');
$joinBtn.addEventListener('click', e => { addRipple($joinBtn, e); joinRoom(); });
document.getElementById('roomInput').addEventListener('keypress', e => { if (e.key === 'Enter') $joinName.focus(); });
$joinName.addEventListener('keypress', e => { if (e.key === 'Enter') joinRoom(); });

function joinRoom() {
  if (_joining) return;
  const rawRoom = document.getElementById('roomInput').value.trim();
  const name = $joinName.value.trim();
  if (!rawRoom || !name) { alert('Please enter a room name and your name.'); return; }
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
    document.getElementById('chatRoom').style.display = 'flex';
    document.getElementById('deleteRoomBtn').style.display = 'flex';
    document.getElementById('roomLabel').textContent = '# ' + room;

    trackOnline();
    loadMessages();
    setupPinListener();
    setupTypingListener();
    setupKickListener();
    setupBanListener();
    initPeer();

    const draft = localStorage.getItem('draft_' + room);
    if (draft) {
      $msgInput.value = draft;
      $msgInput.style.height = 'auto';
      $msgInput.style.height = Math.min($msgInput.scrollHeight, 140) + 'px';
    }
    const ring = document.getElementById('ring');
    ring.volume = 0;
    ring.play().catch(() => {}).finally(() => { ring.pause(); ring.currentTime = 0; ring.volume = 1; });

    if (pendingAutoMsg) {
      const autoTxt = pendingAutoMsg;
      pendingAutoMsg = '';
      setTimeout(() => { if (!room) return; $msgInput.value = autoTxt; send(); }, 900);
    }
  });
}

document.getElementById('logoBtn').addEventListener('click', () => {
  if (typeof closeTouchActions === 'function') closeTouchActions();
  if (!room) return;
  location.href = location.pathname;
});
document.getElementById('logoBtn').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
});
document.getElementById('deleteRoomBtn').addEventListener('click', () => {
  if (!confirm('Delete this room? All messages will be lost.')) return;
  ['messages','online','typing','readReceipts','reactions','pinned','kicked'].forEach(k => db.ref(k + '/' + room).remove());
  location.href = location.pathname;
});

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

let typingTimeout = null;
$msgInput.addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
  $charCounter.textContent = '';
  $charCounter.className = 'char-counter';
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
  $sendBtn.classList.add('sending');
  setTimeout(() => $sendBtn.classList.remove('sending'), 500);
  db.ref('messages/' + room).push(msg).then(ref => {
    db.ref('readReceipts/' + room + '/' + ref.key + '/' + userId).set(currentUser);
  });
  $msgInput.value = '';
  $msgInput.style.height = 'auto';
  if (room) localStorage.removeItem('draft_' + room);
  clearImage(); cancelReply(); $emojiPicker.classList.remove('open');
  setTimeout(() => scrollToBottom(true), 50);
}

function editMessage(key, currentText) {
  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div'); modal.className = 'modal';
  modal.innerHTML = `<h4>Edit Message</h4><textarea id="editInput">${esc(currentText)}</textarea>
    <div class="modal-actions">
      <button class="modal-btn cancel" id="editCancel">Cancel</button>
      <button class="modal-btn primary" id="editSave">Save</button>
    </div>`;
  backdrop.appendChild(modal); document.body.appendChild(backdrop);
  const ta = modal.querySelector('#editInput'); ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  modal.querySelector('#editCancel').addEventListener('click', () => backdrop.remove());
  modal.querySelector('#editSave').addEventListener('click', () => {
    const newText = ta.value.replace(/<[^>]*>/g, '');
    if (!newText.trim()) { alert('Message cannot be empty.'); return; }
    db.ref('messages/' + room + '/' + key).update({ msg: newText, edited: true });
    backdrop.remove();
  });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
  const onKey = e => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

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
  const onKey = e => { if (e.key === 'Escape') { backdrop.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
}

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

const $lightbox = document.getElementById('lightbox');
const $lightboxImg = document.getElementById('lightboxImg');
$lightbox.addEventListener('click', () => $lightbox.classList.remove('open'));
function openLightbox(src) { $lightboxImg.src = src; $lightbox.classList.add('open'); }

function showCtxMenu(x, y, key, isSelf, rawMsg) {
  haptic(50); $ctxMenu.innerHTML = '';
  const items = [
    { icon: ICON.react, label: 'React', action: () => { closeCtxMenu(); const li = document.getElementById('msg-' + key); if (li) showReactionPicker(key, li); } },
    { icon: ICON.reply, label: 'Reply', action: () => { closeCtxMenu(); startReply(key, document.querySelector('#msg-' + key + ' .name')?.textContent || '', rawMsg); } },
    { icon: ICON.copy, label: 'Copy', action: () => { closeCtxMenu(); copyText(rawMsg).then(() => haptic(10)).catch(() => alert('Copy failed')); } },
    { icon: ICON.pin, label: 'Pin', action: () => { closeCtxMenu(); pinMessage(key, rawMsg || '[image]'); } },
  ];
  if (isSelf) {
    items.push({ icon: ICON.edit, label: 'Edit', action: () => { closeCtxMenu(); editMessage(key, rawMsg); } });
    items.push({ icon: ICON.trash, label: 'Delete', danger: true, action: () => { closeCtxMenu(); if (confirm('Delete this message?')) db.ref('messages/' + room + '/' + key).remove(); } });
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
    mkBtn(ICON.trash, 'Delete', () => { if (confirm('Delete this message?')) db.ref('messages/' + room + '/' + key).remove(); });
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
   PEERJS CALL MODULE — with Safari/HTTP friendly errors
   ═══════════════════════════════════════════════════════════════ */
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
    setCallStatus('In call ' + m + ':' + s, 'active');
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
  /* ─── 1. Check secure context ─── */
  const isFile = location.protocol === 'file:';
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isHttp = location.protocol === 'http:' && !isLocalhost;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    let msg = '❌ Microphone/camera API is not available in this browser context.\n\n';
    if (isFile) {
      msg += 'You are opening this page via file:// — that is NOT a secure context.\n\n' +
             'Please serve the files over HTTPS or http://localhost:\n' +
             '  1) In the folder with index.html, run:\n' +
             '       python3 -m http.server 8000\n' +
             '  2) Visit: http://localhost:8000\n\n' +
             'For mobile testing, use HTTPS (e.g. Cloudflare Tunnel or ngrok).';
    } else if (isHttp) {
      msg += 'You are on an insecure HTTP origin (' + location.origin + ').\n\n' +
             'Safari (and modern Chrome) HIDE the camera/mic API on non-HTTPS pages.\n\n' +
             'Fix it by either:\n' +
             '  • Using an HTTPS URL (Cloudflare Tunnel, ngrok, or deploy to Vercel/Netlify), or\n' +
             '  • Opening the page via http://localhost on the SAME device.';
    } else {
      msg += 'Please use a modern browser (Chrome / Safari / Edge) over HTTPS.';
    }
    alert(msg);
    return null;
  }

  /* ─── 2. Try to get the stream ─── */
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: needVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    console.error('[getUserMedia] failed:', err);
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert('You denied the microphone' + (needVideo ? '/camera' : '') + ' permission.\n\n' +
            'On iOS Safari: tap "aA" in the address bar → Website Settings → allow Microphone/Camera.\n' +
            'On Chrome: click the lock icon in the URL bar → allow.');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      alert('No microphone' + (needVideo ? ' or camera' : '') + ' device was found.');
    } else if (err.name === 'NotReadableError') {
      alert('Your microphone/camera is in use by another app. Close it and try again.');
    } else {
      alert('Could not access media devices: ' + (err.message || err.name || err));
    }
    return null;
  }
}

function setupCallHandlers(call, peerName) {
  const tryPlay = (el, tries = 5) => {
    if (!el) return;
    const p = el.play();
    if (p && p.catch) p.catch(() => { if (tries > 0) setTimeout(() => tryPlay(el, tries - 1), 250); });
  };

  call.on('stream', remoteStream => {
    callAnswered = true;
    clearTimeout(dialTimeout);
    if (callMode === 'video') {
      $remoteVideo.srcObject = remoteStream;
      $remoteVideo.classList.add('show');
      tryPlay($remoteVideo);
      if (localStream) {
        $localVideo.srcObject = localStream;
        $localVideo.classList.add('show');
        tryPlay($localVideo);
      }
    } else {
      $remoteAudio.srcObject = remoteStream;
      tryPlay($remoteAudio);
    }
    updateCallUI(true);
    startCallTimer();
    requestWakeLock();
    haptic(20);
  });
  call.on('close', () => {
    setCallStatus('Call ended', 'error');
    setTimeout(() => cleanupCall(), 800);
  });
  call.on('error', () => {
    setCallStatus('Call error', 'error');
    setTimeout(() => cleanupCall(), 1500);
  });
}

async function startCall(needVideo) {
  if (!room) { alert('Please join a room first.'); return; }
  if (currentCall || localStream) { alert('A call is already in progress.'); return; }
  if (!peer || peer.destroyed) { alert('Call service not ready. Please wait a moment.'); return; }
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

  if (!others.length) { alert('No one else is available to call right now.'); return; }

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
  setCallStatus('Requesting device permission…', '');
  localStream = await getLocalStream(needVideo);
  if (!localStream) { setCallStatus(''); callMode = null; return; }
  setCallStatus('Calling ' + targetName + '…', '');
  updateCallUI(true);
  const call = peer.call(targetPeerId, localStream, {
    metadata: { video: needVideo, callerId: myPeerId, callerName: currentUser }
  });
  if (!call) {
    setCallStatus('Call failed: peer not available', 'error');
    setTimeout(() => cleanupCall(), 1500);
    return;
  }
  currentCall = call;
  setupCallHandlers(call, targetName);
  dialTimeout = setTimeout(() => {
    if (currentCall === call && !callAnswered) {
      setCallStatus('No answer', 'error');
      setTimeout(() => cleanupCall(), 1000);
    }
  }, 30000);
}

async function handleIncomingCall(call) {
  if (currentCall || localStream) { try { call.close(); } catch (e) {} return; }
  const meta = call.metadata || {};
  const needVideo = !!meta.video;
  const callerName = meta.callerName || meta.callerId || call.peer;

  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  const accept = confirm(
    (needVideo ? 'Video' : 'Voice') + ' call invitation\n' +
    'From: ' + callerName + '\n\nAccept?'
  );
  if (!accept) { try { call.close(); } catch (e) {} return; }

  callMode = needVideo ? 'video' : 'audio';
  callAnswered = false;
  setCallStatus('Connecting…', '');
  localStream = await getLocalStream(needVideo);
  if (!localStream) {
    setCallStatus('Could not access device', 'error');
    try { call.close(); } catch (e) {}
    setTimeout(() => cleanupCall(), 1500);
    return;
  }
  call.answer(localStream);
  currentCall = call;
  setupCallHandlers(call, callerName);
  updateCallUI(true);
}

function endCall() {
  haptic(30);
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }
  if ($remoteAudio) $remoteAudio.srcObject = null;
  if ($remoteVideo) $remoteVideo.srcObject = null;
  if ($localVideo)  $localVideo.srcObject  = null;
  setCallStatus('Call ended', 'error');
  setTimeout(() => cleanupCall(), 800);
}

function cleanupCall() {
  stopCallTimer();
  clearTimeout(dialTimeout);
  releaseWakeLock();
  callMode = null;
  callAnswered = false;
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  if (localStream) { localStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localStream = null; }
  if ($remoteAudio) $remoteAudio.srcObject = null;
  if ($remoteVideo) { $remoteVideo.srcObject = null; $remoteVideo.classList.remove('show'); }
  if ($localVideo)  { $localVideo.srcObject  = null; $localVideo.classList.remove('show'); }
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

if ($voiceCallBtn) $voiceCallBtn.addEventListener('click', e => { addRipple($voiceCallBtn, e); startCall(false); });
if ($videoCallBtn) $videoCallBtn.addEventListener('click', e => { addRipple($videoCallBtn, e); startCall(true); });
if ($hangupBtn)    $hangupBtn.addEventListener('click', e => { addRipple($hangupBtn, e); endCall(); });

window.addEventListener('beforeunload', () => {
  if (currentCall) { try { currentCall.close(); } catch (e) {} }
  if (localStream) localStream.getTracks().forEach(t => t.stop());
});

/* ═══════════════════════════════════════════════════════════════
   ADMIN (compact version — full version still works)
   ═══════════════════════════════════════════════════════════════ */
window.admin = function () {
  if (document.getElementById('adminPanel')) { document.getElementById('adminPanel').remove(); return; }
  checkAdminAuth(openAdminConsole);
};

function checkAdminAuth(onSuccess) {
  const now = Date.now();
  if (adminLockUntil > now) {
    const s = Math.ceil((adminLockUntil - now) / 1000);
    alert('Too many attempts. Try again in ' + s + 's.');
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
      .adm-toast{background:rgba(18,22,40,0.9);backdrop-filter:blur(20px);border:1px solid rgba(99,102,241,0.3);color:#f1f5f9;font-family:'Inter',sans-serif;font-size:.8rem;padding:12px 20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.5),0 0 24px rgba(99,102,241,.2);animation:adm-toast-in .3s cubic-bezier(.34,1.56,.64,1);pointer-events:all;display:flex;align-items:center;gap:10px;max-width:360px}
      .adm-toast.success{border-color:rgba(16,185,129,.5);color:#10b981}
      .adm-toast.warn{border-color:rgba(245,158,11,.5);color:#fbbf24}
      .adm-toast.err{border-color:rgba(239,68,68,.5);color:#f87171}
      @keyframes adm-toast-in{from{opacity:0;transform:translateX(20px) scale(.95)}to{opacity:1;transform:none}}
      @keyframes adm-toast-out{to{opacity:0;transform:translateX(20px) scale(.95)}}
      #adminPanel{position:fixed;inset:0;z-index:9999;background:#06070f;color:#f1f5f9;font-family:'Inter',sans-serif;display:flex;flex-direction:column;overflow:hidden;animation:adm-in .3s cubic-bezier(.34,1.56,.64,1);background-image:radial-gradient(ellipse 60% 50% at 20% 10%,rgba(99,102,241,0.08),transparent),radial-gradient(ellipse 50% 50% at 80% 90%,rgba(168,85,247,0.08),transparent)}
      @keyframes adm-in{from{opacity:0;transform:scale(.98)}to{opacity:1;transform:none}}
      #adm-topbar{display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:64px;background:rgba(18,22,40,0.7);backdrop-filter:blur(24px);border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;gap:16px}
      #adm-topbar .brand{display:flex;align-items:center;gap:12px;flex-shrink:0}
      #adm-topbar .brand-icon{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,#6366f1,#a855f7);display:flex;align-items:center;justify-content:center;color:#fff;flex-shrink:0;box-shadow:0 4px 16px rgba(99,102,241,.4)}
      #adm-topbar .brand-name{font-size:.95rem;font-weight:800;letter-spacing:.1em;background:linear-gradient(135deg,#818cf8,#c084fc);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      #adm-topbar .live-badge{font-size:.65rem;color:#10b981;border:1px solid rgba(16,185,129,.5);padding:3px 10px;border-radius:20px;letter-spacing:.1em;animation:adm-pulse 2s infinite;display:flex;align-items:center;gap:6px;background:rgba(16,185,129,.08);font-weight:600}
      @keyframes adm-pulse{0%,100%{opacity:1}50%{opacity:.7}}
      #adm-topbar .right{display:flex;align-items:center;gap:12px;flex-shrink:0}
      #adm-ts,#adm-uptime{font-size:.7rem;color:#64748b;font-family:'JetBrains Mono',monospace;white-space:nowrap}
      #adm-close{background:rgba(30,37,56,0.8);border:1px solid rgba(255,255,255,0.1);color:#94a3b8;padding:8px 18px;border-radius:10px;cursor:pointer;font-family:'Inter',sans-serif;font-size:.8rem;font-weight:600;transition:background .2s,color .2s,transform .2s;white-space:nowrap}
      #adm-close:hover{background:rgba(99,102,241,0.2);color:#f1f5f9;transform:translateY(-1px)}
      #adm-stats{display:flex;gap:1px;background:rgba(255,255,255,0.05);flex-shrink:0}
      .adm-stat{flex:1;padding:16px 20px;background:rgba(10,14,25,0.8);display:flex;flex-direction:column;gap:6px;min-width:0}
      .adm-stat-val{font-size:1.6rem;font-weight:800;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(135deg,#e2e8f0,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
      .adm-stat-val.up{animation:adm-countup .4s cubic-bezier(.34,1.56,.64,1)}
      @keyframes adm-countup{from{transform:translateY(8px);opacity:.5}to{transform:none;opacity:1}}
      .adm-stat-lbl{font-size:.65rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;font-weight:600}
      #adm-tabs{display:flex;gap:4px;padding:12px 24px 0;background:rgba(10,14,25,0.8);flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.08);overflow-x:auto;scrollbar-width:none}
      #adm-tabs::-webkit-scrollbar{display:none}
      .adm-tab{padding:10px 20px;border-radius:10px 10px 0 0;font-size:.8rem;font-weight:700;letter-spacing:.05em;cursor:pointer;border:1px solid transparent;border-bottom:none;color:#64748b;background:none;font-family:'Inter',sans-serif;transition:color .2s,background .2s;position:relative;bottom:-1px;white-space:nowrap;display:flex;align-items:center;gap:8px}
      .adm-tab:hover{color:#94a3b8;background:rgba(30,37,56,0.5)}
      .adm-tab.active{color:#f1f5f9;background:rgba(18,22,40,0.9);border-color:rgba(255,255,255,0.08);border-bottom-color:rgba(18,22,40,0.9)}
      .adm-tab .tab-badge{display:inline-flex;align-items:center;justify-content:center;background:#6366f1;color:#fff;border-radius:20px;font-size:.65rem;padding:1px 8px;margin-left:6px;font-weight:700}
      .adm-tab .tab-badge.red{background:#ef4444}
      #adm-body{flex:1;overflow:hidden}
      .adm-pane{display:none;height:100%;overflow-y:auto;padding:20px 24px}
      .adm-pane.active{display:block}
      .adm-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
      .adm-section-title{font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.15em;margin-bottom:14px;font-weight:700}
      .adm-sort-select{font-family:'Inter',sans-serif;font-size:.8rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:8px 14px;color:#94a3b8;outline:none;cursor:pointer;font-weight:500}
      .adm-sort-select:focus{border-color:#6366f1}
      .adm-room-card{background:rgba(10,14,25,0.7);border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:20px;margin-bottom:12px;transition:border-color .2s,transform .2s}
      .adm-room-card:hover{border-color:rgba(99,102,241,.4);transform:translateY(-2px)}
      .adm-room-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
      .adm-room-name{font-size:.95rem;font-weight:700;color:#f1f5f9;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .adm-room-badge{font-size:.7rem;background:rgba(99,102,241,.15);color:#818cf8;padding:5px 12px;border-radius:20px;white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:6px;font-weight:600}
      .adm-room-badge.msgs{color:#94a3b8;background:rgba(255,255,255,0.05)}
      .adm-room-users{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
      .adm-user-chip{display:flex;align-items:center;gap:8px;background:rgba(30,37,56,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:20px;padding:6px 14px 6px 8px;font-size:.75rem;color:#f1f5f9;font-weight:500}
      .adm-user-chip .av{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.6rem;font-weight:700;color:#fff;flex-shrink:0}
      .adm-room-actions{display:flex;gap:8px;flex-wrap:wrap}
      .adm-btn{font-family:'Inter',sans-serif;font-size:.75rem;font-weight:700;padding:8px 16px;border-radius:10px;border:none;cursor:pointer;transition:background .2s,transform .2s;white-space:nowrap;display:inline-flex;align-items:center;gap:8px}
      .adm-btn:active:not(:disabled){transform:scale(.95)}
      .adm-btn:disabled{opacity:.4;cursor:not-allowed}
      .adm-btn.ghost{background:rgba(30,37,56,0.8);color:#94a3b8}
      .adm-btn.ghost:hover:not(:disabled){background:rgba(40,50,80,0.9);color:#f1f5f9}
      .adm-btn.danger{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.2)}
      .adm-btn.danger:hover:not(:disabled){background:rgba(239,68,68,.25)}
      .adm-btn.primary{background:linear-gradient(135deg,#6366f1,#a855f7);color:#fff}
      .adm-btn.primary:hover:not(:disabled){background:linear-gradient(135deg,#4f46e5,#9333ea);transform:translateY(-2px)}
      .adm-btn.warn{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.2)}
      .adm-btn.warn:hover:not(:disabled){background:rgba(245,158,11,.25)}
      .adm-user-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;transition:background .2s;margin-bottom:4px}
      .adm-user-row:hover{background:rgba(30,37,56,0.6)}
      .adm-user-av{width:40px;height:40px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.8rem;font-weight:700;color:#fff}
      .adm-user-info{flex:1;min-width:0}
      .adm-user-name{font-size:.9rem;font-weight:700;color:#f1f5f9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .adm-user-sub{font-size:.7rem;color:#64748b;margin-top:2px;display:flex;gap:12px;flex-wrap:wrap}
      .adm-online-dot{width:10px;height:10px;border-radius:50%;background:#10b981;flex-shrink:0;box-shadow:0 0 12px rgba(16,185,129,.6)}
      .adm-user-actions{display:flex;gap:8px;flex-shrink:0}
      .adm-kick-btn,.adm-warn-btn,.adm-ban-btn{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:none;cursor:pointer;transition:background .2s,transform .2s}
      .adm-kick-btn{background:rgba(239,68,68,.1);color:#f87171}
      .adm-kick-btn:hover{background:rgba(239,68,68,.25)}
      .adm-warn-btn{background:rgba(245,158,11,.1);color:#fbbf24}
      .adm-warn-btn:hover{background:rgba(245,158,11,.25)}
      .adm-ban-btn{background:rgba(239,68,68,.06);color:#9b2c2c}
      .adm-ban-btn:hover{background:rgba(239,68,68,.2)}
      .adm-msg-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
      .adm-msg-search{flex:1;min-width:160px;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:10px 16px;color:#f1f5f9;outline:none}
      .adm-msg-search:focus{border-color:#6366f1}
      .adm-bulk-bar{display:none;align-items:center;gap:12px;padding:10px 16px;background:rgba(18,22,40,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:10px;margin-bottom:12px;font-size:.8rem;color:#94a3b8;font-weight:500}
      .adm-bulk-bar.visible{display:flex}
      .adm-msg-row{display:flex;align-items:flex-start;gap:12px;padding:12px 16px;border-radius:12px;transition:background .15s;margin-bottom:4px}
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
      .adm-announce-area{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:14px 18px;color:#f1f5f9;outline:none;resize:vertical;min-height:100px;margin-bottom:10px;line-height:1.6}
      .adm-announce-area:focus{border-color:#6366f1}
      .adm-bc-char{font-size:.7rem;color:#475569;text-align:right;margin-bottom:12px;font-family:'JetBrains Mono',monospace}
      .adm-bc-preview{background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 18px;font-size:.85rem;color:#94a3b8;margin-bottom:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;display:none}
      .adm-bc-preview.visible{display:block}
      .adm-bc-preview-label{font-size:.65rem;color:#475569;text-transform:uppercase;letter-spacing:.12em;margin-bottom:6px;font-weight:700}
      .adm-room-select{width:100%;font-family:'Inter',sans-serif;font-size:.85rem;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 18px;color:#f1f5f9;outline:none;margin-bottom:14px}
      .adm-room-select:focus{border-color:#6366f1}
      .adm-ban-row{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:4px}
      .adm-ban-row:hover{background:rgba(30,37,56,0.6)}
      .adm-ban-av{width:36px;height:36px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:700;color:#fff}
      .adm-ban-info{flex:1;min-width:0}
      .adm-ban-name{font-size:.9rem;font-weight:700;color:#f87171}
      .adm-ban-meta{font-size:.7rem;color:#64748b;margin-top:2px}
      .adm-unban-btn{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 14px;border-radius:8px;border:none;cursor:pointer;background:rgba(16,185,129,.1);color:#10b981}
      .adm-unban-btn:hover{background:rgba(16,185,129,.25)}
      .adm-log-toolbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap}
      .adm-log-filters{display:flex;gap:8px}
      .adm-log-filter{font-family:'Inter',sans-serif;font-size:.7rem;font-weight:700;padding:5px 12px;border-radius:8px;border:1px solid transparent;cursor:pointer;background:rgba(30,37,56,0.8);color:#64748b}
      .adm-log-filter.f-info{color:#10b981}.adm-log-filter.f-info.active{background:rgba(16,185,129,.15)}
      .adm-log-filter.f-warn{color:#fbbf24}.adm-log-filter.f-warn.active{background:rgba(245,158,11,.15)}
      .adm-log-filter.f-err{color:#f87171}.adm-log-filter.f-err.active{background:rgba(239,68,68,.15)}
      .adm-log{font-size:.8rem;line-height:1.7;background:rgba(10,14,25,0.8);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px 20px;max-height:calc(100vh - 320px);overflow-y:auto}
      .adm-log-entry{padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);display:flex;gap:10px;align-items:baseline}
      .adm-log-entry:last-child{border:none}
      .adm-log-entry.hidden{display:none}
      .adm-log-ts{color:#475569;flex-shrink:0;font-size:.7rem;font-family:'JetBrains Mono',monospace}
      .adm-log-warn{color:#fbbf24;font-weight:500}
      .adm-log-info{color:#10b981;font-weight:500}
      .adm-log-err{color:#f87171;font-weight:500}
      .adm-empty{text-align:center;padding:60px 20px;color:#475569;font-size:.85rem;font-weight:500}
      #adm-shortcuts{position:fixed;bottom:24px;right:24px;z-index:10000;background:rgba(18,22,40,0.9);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px 20px;font-size:.7rem;color:#64748b;line-height:2;pointer-events:none;opacity:.8}
      #adm-shortcuts kbd{background:rgba(30,37,56,0.8);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:2px 8px;color:#94a3b8;font-size:.65rem;font-weight:600}
    `;
    document.head.appendChild(s);
  }

  if (!document.getElementById('adm-toast-wrap')) {
    const tw = document.createElement('div'); tw.id = 'adm-toast-wrap';
    document.body.appendChild(tw);
  }
  function admToast(msg, type = 'info', dur = 3500) {
    const wrap = document.getElementById('adm-toast-wrap');
    const t = document.createElement('div');
    t.className = 'adm-toast ' + (type === 'success' ? 'success' : type === 'warn' ? 'warn' : type === 'err' ? 'err' : '');
    const icons = { success: ICON.check, warn: ICON.alert, err: ICON.x, info: ICON.eye };
    t.innerHTML = `<span>${icons[type] || ICON.eye}</span><span>${msg}</span>`;
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.animation = 'adm-toast-out .3s ease forwards';
      setTimeout(() => t.remove(), 300);
    }, dur);
  }

  const panel = document.createElement('div'); panel.id = 'adminPanel';
  panel.innerHTML = `
    <div id="adm-topbar">
      <div class="brand">
        <div class="brand-icon"><svg class="icon"><use href="#i-shield"/></svg></div>
        <span class="brand-name">ADMIN CONSOLE</span>
        <span class="live-badge"><svg class="icon icon-sm"><use href="#i-radio"/></svg>LIVE</span>
      </div>
      <div class="right">
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
      <button class="adm-tab active" data-tab="rooms"><svg class="icon icon-sm"><use href="#i-home"/></svg> Rooms</button>
      <button class="adm-tab" data-tab="users"><svg class="icon icon-sm"><use href="#i-users"/></svg> Users</button>
      <button class="adm-tab" data-tab="messages"><svg class="icon icon-sm"><use href="#i-chat"/></svg> Messages <span class="tab-badge" id="adm-msg-badge">0</span></button>
      <button class="adm-tab" data-tab="broadcast"><svg class="icon icon-sm"><use href="#i-radio"/></svg> Broadcast</button>
      <button class="adm-tab" data-tab="bans"><svg class="icon icon-sm"><use href="#i-ban"/></svg> Bans <span class="tab-badge red" id="adm-ban-badge" style="display:none">0</span></button>
      <button class="adm-tab" data-tab="log"><svg class="icon icon-sm"><use href="#i-list"/></svg> Log</button>
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
        <div class="adm-bc-char" id="adm-bc-char"></div>
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
    <div id="adm-shortcuts"><kbd>Esc</kbd> Close &nbsp; <kbd>1-6</kbd> Tabs</div>
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
  });
  $('adm-log-clear').addEventListener('click', () => {
    logEntries.length = 0;
    const f = $('adm-log-feed'); if (f) f.innerHTML = '';
  });

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
  };
  document.addEventListener('keydown', onAdmKey);

  const openedAt = Date.now();
  const ticker = setInterval(() => {
    const ts = $('adm-ts'); if (ts) ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const up = $('adm-uptime'); if (up) {
      const s = Math.floor((Date.now() - openedAt) / 1000);
      up.textContent = `↑ ${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
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
    const count = Object.keys(bansData).length;
    const badge = $('adm-ban-badge');
    $('adm-s-bans').textContent = count;
    if (badge) { badge.textContent = count; badge.style.display = count > 0 ? '' : 'none'; }
    renderBanList();
  });
  function renderBanList() {
    const bl = $('adm-ban-list'); if (!bl) return;
    bl.innerHTML = '';
    const entries = Object.entries(bansData);
    if (!entries.length) { bl.innerHTML = '<div class="adm-empty">No bans</div>'; return; }
    entries.forEach(([uid, d]) => {
        // ★ 兼容旧格式：d 可能是纯字符串、也可能是 {name,...} 对象
        const name = typeof d === 'string' ? d : ((d && d.name) || 'Unknown');
        const room = (d && d.room) || '?';
        const row = document.createElement('div'); row.className = 'adm-ban-row';
        row.innerHTML = `<div class="adm-ban-av" style="background:${avatarColor(name)}">${avatarInitials(name)}</div><div class="adm-ban-info"><div class="adm-ban-name">${esc(name)}</div><div class="adm-ban-meta">room: #${esc(room)}</div></div><button class="adm-unban-btn">Unban</button>`;
        row.querySelector('.adm-unban-btn').addEventListener('click', () => {
        if (confirm('Unban ' + name + '?')) db.ref('bans/' + uid).remove();
        });
        bl.appendChild(row);
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
          const banned = !!bansData[u.key];
          const val = u.val();
          const uname = typeof val === 'string' ? val : ((val && val.name) || '?');
          roomsData[r.key].push({ uid: u.key, name: uname, banned });
          allUsers.push({ uid: u.key, name: uname, room: r.key, banned });
        });
      });
    }
    $('adm-s-rooms').textContent = activeRooms().length;
    $('adm-s-users').textContent = allUsers.length;
    renderRoomList();
    renderUserList();
  });

  function renderRoomList() {
    const rl = $('adm-room-list'); if (!rl) return;
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
      card.querySelector('.js-clear').addEventListener('click', () => {
        if (confirm('Clear ALL messages in #' + rn + '?')) {
          ['messages','reactions','readReceipts','pinned'].forEach(k => db.ref(k + '/' + rn).remove());
        }
      });
      card.querySelector('.js-del').addEventListener('click', () => {
        if (confirm('Delete room #' + rn + '?')) {
          ['messages','online','typing','readReceipts','reactions','pinned','kicked'].forEach(k => db.ref(k + '/' + rn).remove());
        }
      });
      rl.appendChild(card);
    });
  }

  function renderUserList() {
    const ul = $('adm-user-list'); if (!ul) return;
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
      row.querySelector('.adm-kick-btn').addEventListener('click', () => {
        if (confirm('Kick ' + u.name + '?')) {
          db.ref('kicked/' + u.room + '/' + u.uid).set(true).then(() => db.ref('online/' + u.room + '/' + u.uid).remove());
        }
      });
      row.querySelector('.adm-ban-btn').addEventListener('click', () => {
        if (confirm('Ban ' + u.name + '?')) {
          db.ref('bans/' + u.room + '/' + u.uid).set({ name: u.name, bannedAt: Date.now(), room: u.room });
          db.ref('kicked/' + u.room + '/' + u.uid).set(true);
        }
      });
      ul.appendChild(row);
    });
  }

  const msgsRef = db.ref('messages');
  msgsRef.on('value', snap => {
    allMsgs = []; msgCount = 0;
    if (snap.exists()) {
      snap.forEach(roomSnap => {
        const rn = roomSnap.key;
        roomSnap.forEach(msgSnap => {
          const m = msgSnap.val();
          allMsgs.push({ key: msgSnap.key, room: rn, sender: m.name || '?', text: m.msg || '', time: m.time || 0 });
          msgCount++;
        });
      });
    }
    allMsgs.sort((a, b) => b.time - a.time);
    if (allMsgs.length > 500) allMsgs = allMsgs.slice(0, 500);
    $('adm-s-msgs').textContent = msgCount;
    $('adm-msg-badge').textContent = msgCount;
    renderMsgList();
  });

  function renderMsgList() {
    const ml = $('adm-msg-list'); if (!ml) return;
    const kw = ($('adm-msg-filter')?.value || '').toLowerCase().trim();
    let filtered = allMsgs;
    if (kw) filtered = filtered.filter(m => m.text.toLowerCase().includes(kw) || m.sender.toLowerCase().includes(kw));
    ml.innerHTML = '';
    if (!filtered.length) { ml.innerHTML = '<div class="adm-empty">No messages</div>'; return; }
    filtered.forEach(m => {
      const row = document.createElement('div'); row.className = 'adm-msg-row';
      row.innerHTML = `
        <div class="adm-msg-av" style="background:${avatarColor(m.sender)}">${avatarInitials(m.sender)}</div>
        <div class="adm-msg-body">
          <div class="adm-msg-meta">
            <span class="adm-msg-sender">${esc(m.sender)}</span>
            <span class="adm-msg-room-tag">#${esc(m.room)}</span>
          </div>
          <div class="adm-msg-text">${esc(m.text.slice(0, 200))}</div>
        </div>
        <div class="adm-msg-actions">
          <button class="adm-msg-del">Del</button>
        </div>`;
      row.querySelector('.adm-msg-del').addEventListener('click', () => {
        if (confirm('Delete this message?')) db.ref('messages/' + m.room + '/' + m.key).remove();
      });
      ml.appendChild(row);
    });
  }
  $('adm-msg-filter').addEventListener('input', renderMsgList);

  $('adm-bc-send').addEventListener('click', () => {
    const text = $('adm-bc-text').value.trim();
    if (!text) { toast('Message is empty', 'err'); return; }
    const target = $('adm-bc-room').value;
    const targets = target === '__all__' ? activeRooms() : [target];
    if (!targets.length) { toast('No active rooms', 'err'); return; }
    Promise.all(targets.map(rn => db.ref('messages/' + rn).push({
      name: bcType + ' System', msg: text, time: Date.now(), isAnnouncement: true
    }))).then(() => {
      toast('Sent to ' + targets.length + ' rooms', 'success');
      $('adm-bc-text').value = '';
    });
  });
  panel.querySelectorAll('.adm-bc-type').forEach(btn => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('.adm-bc-type').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bcType = btn.dataset.type;
    });
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