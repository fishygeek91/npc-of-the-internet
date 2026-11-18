import { describe, expect, it } from "vitest";

import {
  DOOR_ERROR_CODES,
  defaultHttpStatusForDoorError,
  doorErrorFromWire
} from "../src/errors.js";

describe("DoorError codes", () => {
  it("pins every Door error code to its HTTP status", () => {
    expect(DOOR_ERROR_CODES.map((code) => [code, defaultHttpStatusForDoorError(code)])).toEqual([
      ["unsupported_version", 400],
      ["unsupported_kind", 400],
      ["invalid_request", 400],
      ["core_invalid", 400],
      ["message_too_large", 400],
      ["payload_too_large", 413],
      ["signature_invalid", 401],
      ["session_invalid", 401],
      ["timestamp_stale", 401],
      ["not_hosting", 403],
      ["not_found", 404],
      ["epoch_closed", 409],
      ["epoch_mismatch", 409],
      ["epoch_replay", 409],
      ["seq_replay", 409],
      ["msg_replay", 409],
      ["session_closed", 409],
      ["witness_declined", 422],
      ["rate_limited", 503],
      ["door_unavailable", 503],
      ["witness_unavailable", 503],
      ["internal_error", 500]
    ]);
  });

  it("keeps a known wire code", () => {
    const error = doorErrorFromWire("signature_invalid", "bad sig", 401, { field: "sig" });
    expect(error.code).toBe("signature_invalid");
    expect(error.message).toBe("bad sig");
    expect(error.httpStatus).toBe(401);
    expect(error.details).toEqual({ field: "sig" });
  });

  it("does not treat an unrecognized wire code as a known discriminant", () => {
    const error = doorErrorFromWire("signatur_invalid", "bad sig", 401, { field: "sig" });
    expect(error.code).toBe("door_unavailable");
    expect(error.message).toBe("bad sig");
    expect(error.httpStatus).toBe(401);
    expect(error.details).toEqual({
      field: "sig",
      unrecognized_code: "signatur_invalid"
    });
  });
});
