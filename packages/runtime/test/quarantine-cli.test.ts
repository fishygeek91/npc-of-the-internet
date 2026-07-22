import { describe, expect, it } from "vitest";

import { EXIT_USAGE, runWandererCli } from "../src/cli.js";

const CANDIDATE_CID = "bafyreihdwdcefgh4rqzijwrehiwkjqijwreh25adwvfuihqyz2hfmeandhu";

describe("quarantine CLI", () => {
  it("runWandererCli quarantine commit delegates to injected runQuarantineCommit", async () => {
    const lines: string[] = [];
    const exitCode = await runWandererCli(["node", "wanderer", "quarantine", "commit"], {
      runQuarantineCommit: async () => ({
        committedCount: 3,
        ripeningCount: 2
      }),
      writeStdout: (line) => {
        lines.push(line);
      },
      writeStderr: () => {
        // no-op
      }
    });

    expect(exitCode).toBe(0);
    expect(lines).toEqual(["Committed 3 shard(s)", "Ripening 2 candidate(s)"]);
  });

  it("runWandererCli quarantine commit exits 2 without injected runQuarantineCommit", async () => {
    const stderr: string[] = [];
    const exitCode = await runWandererCli(["node", "wanderer", "quarantine", "commit"], {
      writeStderr: (line) => {
        stderr.push(line);
      }
    });

    expect(exitCode).toBe(EXIT_USAGE);
    expect(stderr.some((line) => line.includes("runQuarantineCommit"))).toBe(true);
  });

  it("runWandererCli quarantine flag delegates to injected runQuarantineFlag", async () => {
    const lines: string[] = [];
    let flaggedCid: string | undefined;
    let flaggedCategory: string | undefined;

    const exitCode = await runWandererCli(
      [
        "node",
        "wanderer",
        "quarantine",
        "flag",
        CANDIDATE_CID,
        "--category",
        "injection.role_marker"
      ],
      {
        runQuarantineFlag: async (candidateCid, category) => {
          flaggedCid = candidateCid;
          flaggedCategory = category;
        },
        writeStdout: (line) => {
          lines.push(line);
        },
        writeStderr: () => {
          // no-op
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(flaggedCid).toBe(CANDIDATE_CID);
    expect(flaggedCategory).toBe("injection.role_marker");
    expect(lines).toEqual([`Flagged candidate ${CANDIDATE_CID}`]);
  });

  it("runWandererCli quarantine flag without --category passes undefined category", async () => {
    let flaggedCategory: string | undefined = "unset";

    const exitCode = await runWandererCli(
      ["node", "wanderer", "quarantine", "flag", CANDIDATE_CID],
      {
        runQuarantineFlag: async (_candidateCid, category) => {
          flaggedCategory = category;
        },
        writeStdout: () => {
          // no-op
        },
        writeStderr: () => {
          // no-op
        }
      }
    );

    expect(exitCode).toBe(0);
    expect(flaggedCategory).toBeUndefined();
  });

  it("runWandererCli quarantine flag exits 2 without injected runQuarantineFlag", async () => {
    const stderr: string[] = [];
    const exitCode = await runWandererCli(
      ["node", "wanderer", "quarantine", "flag", CANDIDATE_CID],
      {
        writeStderr: (line) => {
          stderr.push(line);
        }
      }
    );

    expect(exitCode).toBe(EXIT_USAGE);
    expect(stderr.some((line) => line.includes("runQuarantineFlag"))).toBe(true);
  });

  it("runWandererCli quarantine flag exits 2 when candidate CID is missing", async () => {
    const exitCode = await runWandererCli(["node", "wanderer", "quarantine", "flag"], {
      runQuarantineFlag: async () => {
        // should not be called
      },
      writeStderr: () => {
        // no-op
      }
    });

    expect(exitCode).toBe(EXIT_USAGE);
  });
});
