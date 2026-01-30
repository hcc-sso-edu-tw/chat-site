// 1. Replace with your Supabase info
const SUPABASE_URL = "https://your-project.supabase.co";
const SUPABASE_ANON_KEY = "your-anon-key";

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const messagesDiv = document.getElementById("messages");
const nameInput = document.getElementById("name");
const messageInput = document.getElementById("message");
const sendBtn = document.getElementById("send");

// 2. Send a message
sendBtn.addEventListener("click", async () => {
  const name = nameInput.value || "Anonymous";
  const message = messageInput.value;
  if (!message) return;

  await supabase.from("messages").insert([{ name, message }]);
  messageInput.value = "";
});

// 3. Load chat history
async function loadMessages() {
  const { data } = await supabase.from("messages").select().order("id");
  messagesDiv.innerHTML = data.map(m => `<b>${m.name}:</b> ${m.message}`).join("<br>");
}
loadMessages();

// 4. Subscribe to new messages in realtime
supabase.from("messages").on("INSERT", payload => {
  const m = payload.new;
  messagesDiv.innerHTML += `<br><b>${m.name}:</b> ${m.message}`;
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}).subscribe();
