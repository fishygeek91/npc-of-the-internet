/** Write a line to stdout (CLI primary output). */
export function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Write a line to stderr (CLI errors and diagnostics). */
export function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}
