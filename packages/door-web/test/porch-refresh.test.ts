import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/** Page node. `className` and `classList` stay in step, as a browser element does. */
class Node {
  hidden = false;
  disabled = false;
  value = "";
  dateTime = "";
  children: Node[] = [];
  parent: Node | null = null;
  private body = "";
  private readonly names = new Set<string>();
  readonly classList = {
    toggle: (name: string, force?: boolean): boolean => {
      const on = force === undefined ? !this.names.has(name) : force;
      if (on) {
        this.names.add(name);
      } else {
        this.names.delete(name);
      }
      return on;
    },
    contains: (name: string): boolean => this.names.has(name),
    add: (name: string): void => {
      this.names.add(name);
    },
    remove: (name: string): void => {
      this.names.delete(name);
    }
  };

  constructor(readonly id = "") {}

  get textContent(): string {
    return this.body;
  }

  set textContent(value: string) {
    this.body = value;
    this.children = [];
  }

  get className(): string {
    return [...this.names].join(" ");
  }

  set className(value: string) {
    this.names.clear();
    for (const part of value.split(/\s+/u)) {
      if (part.length > 0) {
        this.names.add(part);
      }
    }
  }

  get firstElementChild(): Node | null {
    return this.children[0] ?? null;
  }

  appendChild(child: Node): Node {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parent;
    if (parent === null) {
      return;
    }
    const index = parent.children.indexOf(this);
    if (index >= 0) {
      parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  addEventListener(): void {
    return;
  }

  focus(): void {
    return;
  }

  requestSubmit(): void {
    return;
  }

  setAttribute(): void {
    return;
  }

  querySelector(selector: string): Node | null {
    const want = selector.startsWith(".") ? selector.slice(1) : selector;
    for (const child of this.children) {
      if (child.classList.contains(want)) {
        return child;
      }
      const nested = child.querySelector(selector);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  scrollIntoView(): void {
    return;
  }
}

type Timer = { id: number; ms: number; fn: () => void; live: boolean };
type Stream = { listeners: Record<string, (event: { data: string }) => void> };
type ChipProof = { signed?: { epoch?: number; door_id?: string }; sig?: string };
type ReactionInput = { emoji?: string; proof?: ChipProof };

type Porch = {
  send(message: Record<string, string>): void;
  react(target: string, emoji: string, proof: ChipProof): void;
  live(): Timer[];
  flush(): Promise<void>;
  chip(emoji: string): Node;
  line(text: string): Node;
};

function texts(node: Node): string[] {
  const found = node.textContent.length > 0 ? [node.textContent] : [];
  for (const child of node.children) {
    found.push(...texts(child));
  }
  return found;
}

function findChip(node: Node, emoji: string): Node | undefined {
  if (node.classList.contains("reaction") && texts(node).includes(emoji)) {
    return node;
  }
  for (const child of node.children) {
    const found = findChip(child, emoji);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/**
 * Load `app.js` with timer and fetch fakes that throw when stolen off the host.
 * `verifyReaction` is the only verdict the reaction tests vary.
 */
async function openPorch(verifyReaction: (reaction: ReactionInput) => string): Promise<Porch> {
  const timers: Timer[] = [];
  let nextId = 1;
  const elements = new Map<string, Node>();
  for (const id of [
    "door-name",
    "door-desc",
    "status-text",
    "status-detail",
    "messages",
    "empty",
    "say",
    "name",
    "text",
    "send",
    "absent-note",
    "form-error"
  ]) {
    elements.set(id, new Node(id));
  }
  const sources: Stream[] = [];
  const host = {
    setTimeout(this: unknown, fn: () => void, ms: number): number {
      if (this !== host) {
        throw new Error("Illegal invocation");
      }
      const id = nextId;
      nextId += 1;
      timers.push({ id, ms, fn, live: true });
      return id;
    },
    clearTimeout(this: unknown, id: number): void {
      if (this !== host) {
        throw new Error("Illegal invocation");
      }
      const timer = timers.find((entry) => entry.id === id);
      if (timer !== undefined) {
        timer.live = false;
      }
    },
    setInterval(this: unknown): number {
      if (this !== host) {
        throw new Error("Illegal invocation");
      }
      return 1;
    },
    fetch(
      this: unknown,
      input: string
    ): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> {
      if (this !== host) {
        throw new Error("Illegal invocation");
      }
      return Promise.resolve({
        ok: true,
        json: (): Promise<Record<string, unknown>> =>
          Promise.resolve(
            input === "/api/verify-pins"
              ? {
                  soulPublicKey: "soul",
                  doorId: "web:test",
                  doorPublicKey: "door",
                  atlasUrl: "http://atlas.test"
                }
              : {
                  present: true,
                  door: { id: "web:test", name: "Porch", description: "" },
                  messages: []
                }
          )
      });
    }
  };
  const stolenTimeout = host.setTimeout;
  const stolenFetch = host.fetch;
  expect(() => stolenTimeout(() => undefined, 0)).toThrow(/Illegal invocation/u);
  expect(() => {
    void stolenFetch("/api/verify-pins");
  }).toThrow(/Illegal invocation/u);

  function EventSource(this: Stream): void {
    this.listeners = {};
    sources.push(this);
  }
  EventSource.prototype.addEventListener = function addListener(
    this: Stream,
    type: string,
    fn: (event: { data: string }) => void
  ): void {
    this.listeners[type] = fn;
  };
  EventSource.prototype.close = function close(): void {
    return;
  };

  const sandbox = {
    console,
    // Wrappers, not methods: a bare call keeps the right receiver.
    setTimeout: (fn: () => void, ms: number): number => host.setTimeout(fn, ms),
    clearTimeout: (id: number): void => host.clearTimeout(id),
    setInterval: (): number => host.setInterval(),
    fetch: (
      input: string
    ): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> => host.fetch(input),
    Date,
    JSON,
    Array,
    String,
    Number,
    Math,
    Object,
    Promise,
    location: { origin: "http://porch.test" },
    localStorage: { getItem: (): string => "", setItem: (): void => undefined },
    window: { innerHeight: 800, scrollY: 0 },
    document: {
      title: "",
      visibilityState: "visible",
      body: new Node("body"),
      documentElement: { scrollHeight: 0 },
      addEventListener: (): void => undefined,
      getElementById: (id: string): Node | null => elements.get(id) ?? null,
      createElement: (): Node => new Node(),
      createTextNode: (text: string): Node => {
        const node = new Node();
        node.textContent = text;
        return node;
      }
    },
    EventSource,
    WandererVerify: {
      fetchChain: (): Promise<{ etag: null; hold: { phase: "verified"; open: null } }> =>
        Promise.resolve({ etag: null, hold: { phase: "verified", open: null } }),
      verifyText: (_hold: { phase: string }, message: { text?: string }): string =>
        message.text === "newer" ? "checking" : "plain",
      verifyReaction: (
        _hold: { phase: string },
        _targetId: string,
        reaction: ReactionInput
      ): string => verifyReaction(reaction),
      lineAwaitsEpoch: (_hold: { phase: string }, message: { text?: string }): boolean =>
        message.text === "newer"
    }
  };

  runInContext(
    readFileSync(new URL("../public/app.js", import.meta.url), "utf8"),
    createContext(sandbox),
    {
      timeout: 5_000
    }
  );
  const flush = async (): Promise<void> => {
    for (let step = 0; step < 30; step += 1) {
      await Promise.resolve();
    }
  };
  await flush();
  const live = (): Timer[] => timers.filter((timer) => timer.live);
  expect(live()).toHaveLength(0);

  const source = sources[0];
  if (source === undefined) {
    throw new Error("app.js did not open an event stream");
  }
  const onMessage = source.listeners["message"];
  const onReaction = source.listeners["reaction"];
  if (onMessage === undefined || onReaction === undefined) {
    throw new Error("app.js did not listen for messages");
  }
  const messages = elements.get("messages");
  if (messages === undefined) {
    throw new Error("messages element is missing");
  }
  return {
    send(message: Record<string, string>): void {
      onMessage({ data: JSON.stringify(message) });
    },
    react(target: string, emoji: string, proof: ChipProof): void {
      onReaction({ data: JSON.stringify({ target, emoji, proof }) });
    },
    live,
    flush,
    chip(emoji: string): Node {
      const chip = findChip(messages, emoji);
      if (chip === undefined) {
        throw new Error("reaction chip was not rendered");
      }
      return chip;
    },
    line(text: string): Node {
      const found = messages.children.find((child) => texts(child).includes(text));
      if (found === undefined) {
        throw new Error("line was not rendered");
      }
      return found;
    }
  };
}

/** The first debounce, then the two short retries. */
async function fireRetries(page: Porch): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const timer = page.live()[0];
    if (timer === undefined) {
      throw new Error("missing refetch");
    }
    expect(timer.ms).toBe(attempt === 1 ? 300 : 2600);
    timer.live = false;
    timer.fn();
    await page.flush();
  }
}

describe("porch app refresh", () => {
  it("debounces an arrival and a newer line, then fails only after two retries", async () => {
    const page = await openPorch(() => "verified");
    page.send({
      id: "sys-1",
      from: "system",
      text: "The Wanderer has arrived.",
      at: "2026-01-02T00:00:00.000Z"
    });
    page.send({
      id: "w-1",
      from: "wanderer",
      name: "The Wanderer",
      text: "newer",
      at: "2026-01-02T00:00:01.000Z"
    });
    expect(page.live().map((timer) => timer.ms)).toEqual([300]);

    const line = page.line("newer");
    expect(line.classList.contains("msg-wanderer")).toBe(false);
    expect(texts(line)).toContain("checking");
    expect(texts(line)).not.toContain("verification failed");

    await fireRetries(page);
    expect(line.classList.contains("msg-unverified")).toBe(true);
    expect(line.classList.contains("msg-wanderer")).toBe(false);
    expect(texts(line)).toContain("verification failed");
    expect(page.live()).toHaveLength(0);
  });

  it("shows a future-epoch reaction as checking, then failed, never verified", async () => {
    const page = await openPorch(() => "checking");
    page.send({
      id: "web-1",
      from: "visitor",
      name: "Ada",
      text: "hi",
      at: "2026-01-02T00:00:00.000Z"
    });
    page.react("web-1", "👍", {
      signed: { epoch: 999999, door_id: "web:test" },
      sig: "garbage"
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const chip = page.chip("👍");
      expect(chip.classList.contains("reaction-checking")).toBe(true);
      expect(chip.classList.contains("reaction-failed")).toBe(false);
      expect(texts(chip)).toContain("checking");
      expect(texts(chip)).not.toContain("verification failed");
      const timer = page.live()[0];
      if (timer === undefined) {
        throw new Error("missing refetch");
      }
      expect(timer.ms).toBe(attempt === 1 ? 300 : 2600);
      timer.live = false;
      timer.fn();
      await page.flush();
    }

    const failed = page.chip("👍");
    expect(failed.classList.contains("reaction-failed")).toBe(true);
    expect(failed.classList.contains("reaction-checking")).toBe(false);
    expect(texts(failed)).toContain("verification failed");
    expect(page.live()).toHaveLength(0);
  });

  it("marks a past-epoch reaction as an earlier visit", async () => {
    const page = await openPorch(() => "earlier");
    page.send({
      id: "web-1",
      from: "visitor",
      name: "Ada",
      text: "hi",
      at: "2026-01-02T00:00:00.000Z"
    });
    page.react("web-1", "👍", { signed: { epoch: 1, door_id: "web:test" }, sig: "ok" });
    const chip = page.chip("👍");
    expect(chip.classList.contains("reaction-earlier")).toBe(true);
    expect(chip.classList.contains("reaction-checking")).toBe(false);
    expect(texts(chip)).toContain("earlier visit");
    expect(page.live()).toHaveLength(0);
  });
});
