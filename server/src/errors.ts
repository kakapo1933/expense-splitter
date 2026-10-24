// HTTP-mappable errors thrown by the service layer. MoneyError (money.ts) → 400 as well.
export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  readonly status = 409;
  readonly code = "DUPLICATE_NAME";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** A settlement whose payer and payee are the same member. */
export class SameMemberError extends Error {
  readonly status = 400;
  readonly code = "SAME_MEMBER";
  constructor() {
    super("fromId and toId must be different members");
    this.name = "SameMemberError";
  }
}

/** A request that parses but references members outside the group. */
export class UnknownMemberError extends Error {
  readonly status = 400;
  readonly code = "UNKNOWN_MEMBER";
  constructor(ids: string[]) {
    super(`member(s) not in group: ${ids.join(", ")}`);
    this.name = "UnknownMemberError";
  }
}
