export type NodeError = Error & { code?: string };

export function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && "code" in error;
}

export function nodeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
