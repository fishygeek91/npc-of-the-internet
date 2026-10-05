import { spawn } from "node:child_process";
import { once } from "node:events";

/**
 * Run `fn` with the PID of a real, live child process (another process, not ours).
 * The child is SIGKILLed afterwards.
 */
export async function withLiveChildPid<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore"
  });
  await once(child, "spawn");
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("child process has no pid");
  }
  try {
    return await fn(pid);
  } finally {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
}
