// -----------------------------
// 1️⃣ 初始化 Supabase
// -----------------------------
const SUPABASE_URL = "https://你的專案網址.supabase.co"; // 你的 Supabase Project URL
const SUPABASE_ANON_KEY = "你的 Publishable key";       // 你的 anon public key
const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// -----------------------------
// 2️⃣ 取得 DOM 元素
// -----------------------------
const messagesDiv = document.getElementById("messages");
const nameInput = document.getElementById("name");
const messageInput = document.getElementById("message");
const sendBtn = document.getElementById("send");

// -----------------------------
// 3️⃣ 送出訊息
// -----------------------------
sendBtn.addEventListener("click", async () => {
  const name = nameInput.value || "匿名";
  const message = messageInput.value.trim();
  if (!message) return;

  const { data, error } = await supabase
    .from("messages")
    .insert([{ name, message }]);

  if (error) {
    console.error("送出訊息失敗:", error);
  } else {
    messageInput.value = ""; // 清空輸入框
  }
});

// -----------------------------
// 4️⃣ 載入歷史訊息
// -----------------------------
async function loadMessages() {
  const { data, error } = await supabase
    .from("messages")
    .select()
    .order("id", { ascending: true });

  if (error) {
    console.error("載入訊息失敗:", error);
    return;
  }

  messagesDiv.innerHTML = data
    .map(m => `<b>${m.name}:</b> ${m.message}`)
    .join("<br>");
}

loadMessages();

// -----------------------------
// 5️⃣ 即時訂閱新訊息
// -----------------------------
supabase
  .channel('messages_channel')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload => {
    const m = payload.new;
    messagesDiv.innerHTML += `<br><b>${m.name}:</b> ${m.message}`;
    messagesDiv.scrollTop = messagesDiv.scrollHeight; // 自動捲動到底
  })
  .subscribe();
