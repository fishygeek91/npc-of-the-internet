/* global document, window, fetch, location, EventSource, localStorage, setTimeout, clearTimeout, setInterval */
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
    sending: false,
    hold: { phase: "checking" },
    cache: null,
    refreshing: false
  };

  // One debounced refetch for an arrival and for a newer epoch, then two
  // retries. 2600ms steps outlast the porch's 5s export cache. Completions
  // are a counter, not Date.now(), so a refetch counts only after the line.
  const REFRESH_DEBOUNCE_MS = 300;
  const REFRESH_RETRY_MS = 2600;
  const REFRESH_MAX_COMPLETIONS = 3;
  let refreshSerial = 0;
  let refreshTimer = null;
  let refreshKind = "";
  let refreshAgain = false;
  const seenSerial = new Map();

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

  function holdVerdict(hold) {
    return hold.phase === "checking" ? "checking" : "failed";
  }

  function failChain() {
    state.cache = { etag: null, hold: { phase: "failed" } };
    state.hold = state.cache.hold;
  }

  function lineLabel(node) {
    for (const child of node.children) {
      if (child.classList.contains("verify-label") || child.classList.contains("epoch-label")) {
        return child;
      }
    }
    return null;
  }

  function setLineMark(node, kind) {
    const label = lineLabel(node);
    if (kind === "none") {
      if (label) {
        label.remove();
      }
      return;
    }
    let className = "epoch-label epoch-checking";
    let text = "checking";
    if (kind === "failed") {
      className = "verify-label";
      text = "verification failed";
    } else if (kind === "earlier") {
      className = "epoch-label epoch-earlier";
      text = "earlier visit";
    }
    if (!label) {
      node.appendChild(el("p", className, text));
      return;
    }
    label.className = className;
    label.textContent = text;
  }

  function paintVerdict(node, message) {
    const api = globalThis.WandererVerify;
    let verdict = "plain";
    if (message.from === "wanderer") {
      verdict = api ? api.verifyText(state.hold, message) : holdVerdict(state.hold);
      verdict = awaitingVerdict(message, verdict);
    }
    node.classList.toggle("msg-wanderer", verdict === "verified");
    node.classList.toggle("msg-unverified", verdict === "failed");
    node.classList.toggle("msg-earlier", verdict === "earlier");
    if (verdict === "failed") {
      setLineMark(node, "failed");
    } else if (verdict === "earlier") {
      setLineMark(node, "earlier");
    } else if (verdict === "checking") {
      setLineMark(node, "checking");
    } else {
      setLineMark(node, "none");
    }
  }

  /** Refetches that finished after this line or reaction was first shown. */
  function completionsAfter(id) {
    const seen = seenSerial.get(id);
    return seen === undefined ? 0 : refreshSerial - seen;
  }

  /** Drop a line and any reaction chips that were tracked for it. */
  function forgetSeen(id) {
    const prefix = `${id}\u0000`;
    for (const key of [...seenSerial.keys()]) {
      if (key === id || key.startsWith(prefix)) {
        seenSerial.delete(key);
      }
    }
  }

  /** One chip on one message. The separator cannot appear in an id. */
  function reactionKey(targetId, emoji) {
    return `${targetId}\u0000${emoji}`;
  }

  /**
   * A newer epoch stays `checking` until a refetch that finished after the
   * line was shown, plus two short retries, still has no arrival.
   * Timers are bare calls so `this` stays the page.
   */
  function awaitingVerdict(message, verdict) {
    const api = globalThis.WandererVerify;
    if (!api || typeof message.id !== "string") {
      return verdict;
    }
    const awaits =
      typeof api.lineAwaitsEpoch === "function" && api.lineAwaitsEpoch(state.hold, message);
    if (awaits) {
      if (!seenSerial.has(message.id)) {
        seenSerial.set(message.id, refreshSerial);
        armSoon();
      }
      return completionsAfter(message.id) >= REFRESH_MAX_COMPLETIONS ? "failed" : "checking";
    }
    if (
      verdict === "failed" &&
      seenSerial.has(message.id) &&
      completionsAfter(message.id) < REFRESH_MAX_COMPLETIONS &&
      (state.hold.phase === "failed" || state.hold.phase === "checking")
    ) {
      return "checking";
    }
    return verdict;
  }

  function clearRefreshTimer() {
    if (refreshTimer !== null) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
      refreshKind = "";
    }
  }

  /** Collapse arrival notices and newer lines into one short refetch. */
  function armSoon() {
    if (state.refreshing) {
      refreshAgain = true;
      return;
    }
    if (refreshTimer !== null && refreshKind === "soon") {
      return;
    }
    clearRefreshTimer();
    refreshKind = "soon";
    refreshTimer = setTimeout(fireRefresh, REFRESH_DEBOUNCE_MS);
  }

  /** One more look after a post-arrival refetch still missed the epoch. */
  function armRetry() {
    if (state.refreshing || refreshTimer !== null) {
      return;
    }
    refreshKind = "retry";
    refreshTimer = setTimeout(fireRefresh, REFRESH_RETRY_MS);
  }

  function fireRefresh() {
    refreshTimer = null;
    refreshKind = "";
    void refreshChain();
  }

  /** True when a tracked line may not be labeled failed yet. */
  function needsRetry() {
    const api = globalThis.WandererVerify;
    if (!api) {
      return false;
    }
    for (const entry of state.byId.values()) {
      const message = entry.message;
      if (!message || typeof message.id !== "string" || !seenSerial.has(message.id)) {
        continue;
      }
      if (completionsAfter(message.id) >= REFRESH_MAX_COMPLETIONS) {
        continue;
      }
      if (typeof api.lineAwaitsEpoch === "function" && api.lineAwaitsEpoch(state.hold, message)) {
        return true;
      }
      if (state.hold.phase === "failed" || state.hold.phase === "checking") {
        return true;
      }
    }
    for (const entry of state.byId.values()) {
      const message = entry.message;
      if (!message || typeof message.id !== "string" || !Array.isArray(message.reactions)) {
        continue;
      }
      for (const reaction of message.reactions) {
        if (!reaction || typeof reaction !== "object" || typeof reaction.emoji !== "string") {
          continue;
        }
        const key = reactionKey(message.id, reaction.emoji);
        if (!seenSerial.has(key) || completionsAfter(key) >= REFRESH_MAX_COMPLETIONS) {
          continue;
        }
        if (state.hold.phase === "verified") {
          if (
            typeof api.verifyReaction === "function" &&
            api.verifyReaction(state.hold, message.id, reaction) === "checking"
          ) {
            return true;
          }
          continue;
        }
        if (state.hold.phase === "failed" || state.hold.phase === "checking") {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * A newer-epoch chip stays `checking` until the same refetch budget as a line.
   * A past epoch is `earlier`, never an unmarked live chip.
   */
  function reactionVerdict(targetId, emoji, verdict) {
    const key = reactionKey(targetId, emoji);
    if (state.hold.phase === "verified" && verdict === "checking") {
      if (!seenSerial.has(key)) {
        seenSerial.set(key, refreshSerial);
        armSoon();
      }
      return completionsAfter(key) >= REFRESH_MAX_COMPLETIONS ? "failed" : "checking";
    }
    if (
      verdict === "failed" &&
      seenSerial.has(key) &&
      completionsAfter(key) < REFRESH_MAX_COMPLETIONS &&
      (state.hold.phase === "failed" || state.hold.phase === "checking")
    ) {
      return "checking";
    }
    return verdict;
  }

  function renderReactions(node, targetId, reactions) {
    let box = node.querySelector(".reactions");
    if (!Array.isArray(reactions) || reactions.length === 0) {
      if (box) {
        box.remove();
      }
      return;
    }
    if (!box) {
      box = el("div", "reactions");
      node.appendChild(box);
    }
    box.textContent = "";
    const names = [];
    const api = globalThis.WandererVerify;
    for (const reaction of reactions) {
      const emoji = typeof reaction === "string" ? reaction : String(reaction.emoji || "");
      const chip = el("span", "reaction");
      chip.appendChild(document.createTextNode(emoji));
      if (reaction && typeof reaction === "object" && reaction.proof) {
        const raw = api
          ? api.verifyReaction(state.hold, targetId, reaction)
          : holdVerdict(state.hold);
        const verdict = reactionVerdict(targetId, emoji, raw);
        if (verdict === "failed") {
          chip.classList.add("reaction-failed");
          chip.appendChild(el("span", "verify-label", "verification failed"));
        } else if (verdict === "checking") {
          chip.classList.add("reaction-checking");
          chip.appendChild(el("span", "epoch-label epoch-checking", "checking"));
        } else if (verdict === "earlier") {
          chip.classList.add("reaction-earlier");
          chip.appendChild(el("span", "epoch-label epoch-earlier", "earlier visit"));
        }
      }
      names.push(emoji);
      box.appendChild(chip);
    }
    box.setAttribute("aria-label", `The Wanderer reacted ${names.join(" ")}`);
  }

  function repaint() {
    for (const entry of state.byId.values()) {
      paintVerdict(entry.node, entry.message);
      renderReactions(entry.node, entry.message.id, entry.message.reactions);
    }
  }

  function renderMessage(message) {
    const from = ["visitor", "wanderer", "system"].includes(message.from)
      ? message.from
      : "visitor";
    const item = el("li", from === "wanderer" ? "msg" : `msg msg-${from}`);
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
    renderReactions(item, message.id, message.reactions);
    paintVerdict(item, message);
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
          forgetSeen(id);
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

  function addReaction(target, emoji, proof) {
    const entry = state.byId.get(target);
    if (!entry || typeof emoji !== "string" || !proof || typeof proof !== "object") {
      return;
    }
    const reactions = Array.isArray(entry.message.reactions) ? entry.message.reactions : [];
    if (!reactions.some((reaction) => reaction && reaction.emoji === emoji)) {
      reactions.push({ emoji, proof });
    }
    entry.message.reactions = reactions;
    renderReactions(entry.node, target, reactions);
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
      const data = parse(event);
      addMessage(data);
      if (data && data.from === "system" && data.text === "The Wanderer has arrived.") {
        armSoon();
      }
    });
    source.addEventListener("reaction", (event) => {
      const data = parse(event);
      if (data) {
        addReaction(data.target, data.emoji, data.proof);
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
  async function refreshChain() {
    if (state.refreshing) {
      refreshAgain = true;
      return;
    }
    state.refreshing = true;
    try {
      const api = globalThis.WandererVerify;
      if (!api) {
        failChain();
        return;
      }
      const response = await fetch("/api/verify-pins", { cache: "no-store" });
      if (!response.ok) {
        failChain();
        return;
      }
      const pins = await response.json();
      if (pins && typeof pins.atlasUrl === "string") {
        pins.atlasUrl = location.origin;
      }
      const next = await api.fetchChain(pins, state.cache);
      state.cache = next;
      state.hold = next.hold;
    } catch {
      failChain();
    } finally {
      state.refreshing = false;
      refreshSerial += 1;
      repaint();
      if (refreshAgain) {
        refreshAgain = false;
        armSoon();
      } else if (needsRetry()) {
        armRetry();
      }
    }
  }

  setInterval(renderStatus, 60000);
  setInterval(() => {
    if (document.visibilityState === "hidden") {
      return;
    }
    void refreshChain();
  }, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshChain();
    }
  });
  renderStatus();
  void refreshChain();
  connect();
})();
