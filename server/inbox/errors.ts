/** An /api/inbox refusal: an HTTP status, a message, and an optional machine code and fields. */
export class InboxError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, message: string, readonly code?: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "InboxError";
  }

  body() {
    return { error: this.message, ...(this.code ? { code: this.code } : {}), ...this.extra };
  }
}
