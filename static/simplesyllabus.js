// Runs on Simple Syllabus pages, including when Canvas shows them inside an iframe.
// Adds a "Save to Syllabus Chat" button that sends the syllabus text you're viewing
// to the extension. Nothing is read until you click it.
(() => {
  // Only the outermost Simple Syllabus frame gets a button.
  try {
    if (window !== window.top && window.parent.location.hostname.endsWith("simplesyllabus.com")) return;
  } catch {
    // Parent is Canvas (cross-origin), so this is the outermost Simple Syllabus frame.
  }
  if (document.getElementById("syllabus-chat-save")) return;

  const LABEL = "Save to Syllabus Chat";
  const button = document.createElement("button");
  button.id = "syllabus-chat-save";
  button.textContent = LABEL;
  Object.assign(button.style, {
    position: "fixed", right: "16px", bottom: "16px", zIndex: "2147483647",
    padding: "10px 14px", border: "none", borderRadius: "8px",
    background: "#bf5700", color: "#fff", font: "600 14px system-ui, sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,.25)", cursor: "pointer",
  });

  const flash = (message) => {
    button.textContent = message;
    button.disabled = false;
    setTimeout(() => (button.textContent = LABEL), 5000);
  };

  button.addEventListener("click", async () => {
    const root = document.querySelector("main") || document.body;
    const text = root.innerText.replace(LABEL, "").trim();
    if (text.length < 200) {
      flash("Open a syllabus first, then click again");
      return;
    }
    const heading = root.querySelector("h1")?.innerText.trim();
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "simple-syllabus-capture",
        title: heading || document.title || "Syllabus",
        url: location.href,
        text,
      });
      flash(res?.message || "Saved");
    } catch {
      flash("Couldn't reach the extension — reload this page");
    }
  });

  const attach = () => (document.body ? document.body.append(button) : setTimeout(attach, 200));
  attach();
})();
