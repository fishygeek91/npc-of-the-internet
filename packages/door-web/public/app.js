/* global document, window, fetch, EventSource, localStorage, setTimeout, setInterval */
// The Wanderer's web Door — vanilla browser client. All visitor and Wanderer text is
// rendered with textContent only, never parsed as HTML.
"use strict";

(() => {
  const NAME_KEY = "door-web.name";
  const MAX_ON_PAGE = 200;

  const $ = (id) => document.getElementById(id);
  const els = {
    doorName: $("door-name"),
    doorDesc: $("door-desc"),
    statusText: $("status-text"),
    statusDetail: $("status-detail"),
    messages: $("messages"),
    empty: $("empty"),
    form: $("say"),
    name: $("name"),
    text: $("text"),
    send: $("send"),
    absentNote: $("absent-note"),
    error: $("form-error")
  };

  const state = {
    loaded: false,
    present: false,
    connected: false,
    doorId: null,
    lastSeenHere: null,
    whereabouts: null,
    byId: new Map(),
    sending: false
  };

  function loadName() {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch {
      return "";
    }
  }

  function saveName(value) {
    try {
      localStorage.setItem(NAME_KEY, value);
    } catch {
      // Private mode or blocked storage: the name just isn't remembered.
    }
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined) {
      node.textContent = text;
    }
    return node;
  }

  function validDate(iso) {
    const date = new Date(typeof iso === "string" ? iso : "");
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function clock(iso) {
    const date = validDate(iso);
    return date ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }

  function ago(iso) {
    const date = validDate(iso);
    if (!date) {
      return "";
    }
    const minutes = Math.round((Date.now() - date.getTime()) / 60000);
    if (minutes < 1) {
      return "just now";
    }
    if (minutes < 60) {
      return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
    }
    const hours = Math.round(minutes / 60);
    if (hours < 24) {
      return hours === 1 ? "an hour ago" : `${hours} hours ago`;
    }
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }

  function snippet(text, max) {
    const chars = Array.from(String(text));
    return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
  }

  function nearBottom() {
    const doc = document.documentElement;
    return window.innerHeight + window.scrollY >= doc.scrollHeight - 160;
  }

  function renderReactions(node, reactions) {
    let box = node.querySelector(".reactions");
    if (!Array.isArray(reactions) || reactions.length === 0) {
      return;
    }
    if (!box) {
      box = el("div", "reactions");
      node.appendChild(box);
    }
    box.textContent = reactions.join(" ");
    box.setAttribute("aria-label", `The Wanderer reacted ${reactions.join(" ")}`);
  }

  function renderMessage(message) {
    const from = ["visitor", "wanderer", "system"].includes(message.from)
      ? message.from
      : "visitor";
    const item = el("li", `msg msg-${from}`);
    if (from === "system") {
      item.textContent = String(message.text);
      return item;
    }
    const meta = el("div", "meta");
    meta.appendChild(el("span", "who", String(message.name || "Someone")));
    const when = el("time", "when", clock(message.at));
    if (validDate(message.at)) {
      when.dateTime = message.at;
    }
    meta.appendChild(when);
    item.appendChild(meta);
    if (typeof message.reply_to === "string") {
      const parent = state.byId.get(message.reply_to);
      if (parent) {
        const who = parent.message.name ? `${parent.message.name}: ` : "";
        item.appendChild(el("p", "quote", `↪ ${who}${snippet(parent.message.text, 90)}`));
      }
    }
    item.appendChild(el("p", "text", String(message.text)));
    renderReactions(item, message.reactions);
    return item;
  }

  function addMessage(message) {
    if (!message || typeof message.id !== "string" || state.byId.has(message.id)) {
      return;
    }
    const stick = nearBottom();
    const node = renderMessage(message);
    state.byId.set(message.id, { message, node });
    els.messages.appendChild(node);
    while (els.messages.children.length > MAX_ON_PAGE) {
      const first = els.messages.firstElementChild;
      for (const [id, entry] of state.byId) {
        if (entry.node === first) {
          state.byId.delete(id);
          break;
        }
      }
      first.remove();
    }
    els.empty.hidden = els.messages.children.length > 0;
    if (stick) {
      node.scrollIntoView({ block: "end" });
    }
  }

  function addReaction(target, emoji) {
    const entry = state.byId.get(target);
    if (!entry || typeof emoji !== "string") {
      return;
    }
    const reactions = Array.isArray(entry.message.reactions) ? entry.message.reactions : [];
    if (!reactions.includes(emoji)) {
      reactions.push(emoji);
    }
    entry.message.reactions = reactions;
    renderReactions(entry.node, reactions);
  }

  function renderStatus() {
    document.body.classList.toggle("present", state.present);
    document.body.classList.toggle("absent", !state.present);
    const canSend = state.present && !state.sending;
    els.name.disabled = !state.present;
    els.text.disabled = !state.present;
    els.send.disabled = !canSend;
    if (!state.loaded) {
      return;
    }
    els.absentNote.hidden = state.present;

    if (state.present) {
      els.statusText.textContent = "The Wanderer is here.";
      els.statusDetail.textContent = state.connected ? "" : "Reconnecting…";
      return;
    }
    const lastSeen = state.lastSeenHere ? ` — last seen here ${ago(state.lastSeenHere)}` : "";
    els.statusText.textContent = `The Wanderer is elsewhere${lastSeen}.`;
    const where = state.whereabouts;
    let detail = "";
    if (where && where.status === "present" && where.door_id && where.door_id !== state.doorId) {
      detail = `Now visiting ${where.door_id}`;
      detail += where.since ? ` (since ${ago(where.since)}).` : ".";
    } else if (where && where.status === "traveling") {
      detail = "It is travelling between places right now.";
    } else if (where && where.status === "sleeping") {
      detail = "It is resting right now.";
    }
    if (!state.connected) {
      detail = detail ? `${detail} Reconnecting…` : "Reconnecting…";
    }
    els.statusDetail.textContent = detail;
  }

  async function loadState() {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      if (data.door) {
        state.doorId = String(data.door.id);
        els.doorName.textContent = String(data.door.name);
        els.doorDesc.textContent = String(data.door.description);
        document.title = String(data.door.name);
      }
      state.loaded = true;
      state.present = data.present === true;
      state.lastSeenHere = data.wanderer ? data.wanderer.last_seen_here || null : null;
      state.whereabouts = data.wanderer || null;
      if (Array.isArray(data.messages)) {
        for (const message of data.messages) {
          addMessage(message);
        }
      }
      renderStatus();
    } catch {
      // Network hiccup: the event stream reconnect will try again.
    }
  }

  function parse(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  }

  let backoffMs = 1000;
  function connect() {
    const source = new EventSource("/api/events");
    source.addEventListener("open", () => {
      backoffMs = 1000;
      state.connected = true;
      void loadState();
    });
    source.addEventListener("message", (event) => {
      addMessage(parse(event));
    });
    source.addEventListener("reaction", (event) => {
      const data = parse(event);
      if (data) {
        addReaction(data.target, data.emoji);
      }
    });
    source.addEventListener("presence", (event) => {
      const data = parse(event);
      if (!data) {
        return;
      }
      const changed = state.present !== (data.present === true);
      state.loaded = true;
      state.present = data.present === true;
      state.lastSeenHere = data.last_seen_here || state.lastSeenHere;
      renderStatus();
      if (changed && !state.present) {
        void loadState();
      }
    });
    source.addEventListener("error", () => {
      source.close();
      state.connected = false;
      renderStatus();
      const wait = backoffMs + Math.floor(Math.random() * 1000);
      backoffMs = Math.min(backoffMs * 2, 60000);
      setTimeout(connect, wait);
    });
  }

  function showError(message) {
    els.error.textContent = message;
  }

  async function send(event) {
    event.preventDefault();
    if (state.sending || !state.present) {
      return;
    }
    const name = els.name.value.trim();
    const text = els.text.value.trim();
    if (!name) {
      showError("Please choose a name first.");
      els.name.focus();
      return;
    }
    if (!text) {
      els.text.focus();
      return;
    }
    saveName(name);
    showError("");
    state.sending = true;
    renderStatus();
    try {
      const response = await fetch("/api/say", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, text })
      });
      if (response.status === 202) {
        els.text.value = "";
        return;
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.status === 429 && body && body.error && body.error.code === "quiet_hours") {
        showError(`The porch is quiet for today: ${body.error.message}.`);
      } else if (response.status === 429) {
        const seconds = body && Number.isFinite(body.retry_after_s) ? body.retry_after_s : 3;
        showError(`You're speaking quickly — please wait ${seconds}s and try again.`);
      } else if (response.status === 409) {
        showError("The Wanderer has just left, so your message wasn't sent.");
        void loadState();
      } else if (body && body.error && typeof body.error.message === "string") {
        showError(`Couldn't send: ${body.error.message}.`);
      } else {
        showError("Couldn't send just now. Please try again in a moment.");
      }
    } catch {
      showError("Couldn't reach the porch. Check your connection and try again.");
    } finally {
      state.sending = false;
      renderStatus();
      if (state.present) {
        els.text.focus();
      }
    }
  }

  els.name.value = loadName();
  els.form.addEventListener("submit", (event) => {
    void send(event);
  });
  els.text.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });
  setInterval(renderStatus, 60000);
  renderStatus();
  connect();
})();
