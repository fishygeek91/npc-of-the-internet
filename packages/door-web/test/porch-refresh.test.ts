import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

/** Page node. `className` and `classList` stay in step, as a browser element does. */
class Node {
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  dateTime = "";
  children: Node[] = [];
  parent: Node | null = null;
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

  querySelector(): null {
    return null;
  }

  scrollIntoView(): void {
    return;
  }
}

type Timer = { id: number; ms: number; fn: () => void; live: boolean };
type Stream = { listeners: Record<string, (event: { data: string }) => void> };

function texts(node: Node): string[] {
  const found = node.textContent.length > 0 ? [node.textContent] : [];
  for (const child of node.children) {
    found.push(...texts(child));
  }
  return found;
}

describe("porch app refresh", () => {
  it("debounces an arrival and a newer line, then fails only after two retries", async () => {
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
      }
    };
    const stolen = host.setTimeout;
    expect(() => stolen(() => undefined, 0)).toThrow(/Illegal invocation/u);

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
        createElement: (): Node => new Node()
      },
      EventSource,
      fetch: (
        input: string
      ): Promise<{ ok: boolean; json: () => Promise<Record<string, unknown>> }> =>
        Promise.resolve({
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
        }),
      WandererVerify: {
        fetchChain: (): Promise<{ etag: null; hold: { phase: "verified"; open: null } }> =>
          Promise.resolve({ etag: null, hold: { phase: "verified", open: null } }),
        verifyText: (_hold: { phase: string }, message: { text?: string }): string =>
          message.text === "newer" ? "checking" : "plain",
        verifyReaction: (): string => "verified",
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
    if (onMessage === undefined) {
      throw new Error("app.js did not listen for messages");
    }
    const send = (message: Record<string, string>): void => {
      onMessage({ data: JSON.stringify(message) });
    };
    send({
      id: "sys-1",
      from: "system",
      text: "The Wanderer has arrived.",
      at: "2026-01-02T00:00:00.000Z"
    });
    send({
      id: "w-1",
      from: "wanderer",
      name: "The Wanderer",
      text: "newer",
      at: "2026-01-02T00:00:01.000Z"
    });
    expect(live().map((timer) => timer.ms)).toEqual([300]);

    const line = elements.get("messages")?.children.find((child) => texts(child).includes("newer"));
    if (line === undefined) {
      throw new Error("newer line was not rendered");
    }
    expect(line.classList.contains("msg-wanderer")).toBe(false);
    expect(texts(line)).toContain("checking");
    expect(texts(line)).not.toContain("verification failed");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const timer = live()[0];
      if (timer === undefined) {
        throw new Error("missing refetch");
      }
      expect(timer.ms).toBe(attempt === 1 ? 300 : 2600);
      timer.live = false;
      timer.fn();
      await flush();
    }
    expect(line.classList.contains("msg-unverified")).toBe(true);
    expect(line.classList.contains("msg-wanderer")).toBe(false);
    expect(texts(line)).toContain("verification failed");
    expect(live()).toHaveLength(0);
  });
});
