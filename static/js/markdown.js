// Markdown rendering for assistant messages.
//  - marked      : Markdown -> HTML (GitHub-flavoured)
//  - DOMPurify   : strips anything dangerous from that HTML (model output is untrusted)
//  - highlight.js: syntax colours for code blocks
// If the CDN scripts fail to load we fall back to escaped plain text.

import { icon } from "./icons.js";

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let configured = false;
function configure() {
  if (configured || !window.marked) return;
  window.marked.setOptions({ gfm: true, breaks: false });
  configured = true;
}

export function renderMarkdown(text) {
  if (!text) return "";
  if (!window.marked || !window.DOMPurify) {
    return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
  configure();
  const html = window.marked.parse(text);
  return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
export { copyText };

export function flashCopied(button, label = "Copied") {
  const original = button.innerHTML;
  button.innerHTML = `${icon("check")}${button.classList.contains("code-copy") ? `<span>${label}</span>` : ""}`;
  setTimeout(() => {
    button.innerHTML = original;
  }, 1400);
}

/**
 * Post-process rendered Markdown inside `root`:
 * wraps code blocks with a header (language + copy button), highlights them,
 * makes links open in a new tab and makes wide tables scroll.
 * `highlight` is false while streaming to keep rendering cheap.
 */
export function enhanceContent(root, { highlight = true } = {}) {
  root.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (pre.parentElement?.classList.contains("code-block")) return;

    const lang = (code.className.match(/language-([\w+#.-]+)/) || [])[1] || "";
    if (highlight && window.hljs && lang && window.hljs.getLanguage(lang)) {
      try {
        window.hljs.highlightElement(code);
      } catch {
        /* ignore highlighting errors */
      }
    }

    const wrapper = document.createElement("div");
    wrapper.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    head.innerHTML = `<span>${escapeHtml(lang || "text")}</span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.innerHTML = `${icon("copy")}<span>Copy</span>`;
    btn.addEventListener("click", async () => {
      if (await copyText(code.innerText)) flashCopied(btn);
    });
    head.appendChild(btn);
    pre.replaceWith(wrapper);
    wrapper.append(head, pre);
  });

  root.querySelectorAll("a[href]").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });

  root.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.classList.contains("table-wrap")) return;
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
}
