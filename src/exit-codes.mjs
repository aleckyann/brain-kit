// Exit codes shared by every command. Where sysexits.h has a code, we use it.
export const EXIT = Object.freeze({
  OK: 0,             // completed, or an expected no-op (day already covered, lock held by a sibling run)
  FAILURE: 1,        // the command ran and found a problem, or died before doing its job
  USAGE: 2,          // bad arguments, or not inside a brain-kit vault
  DEGRADED: 3,       // partial success that needs a human step (commit made, PR not opened)
  SOURCE_UNREAD: 4,  // a source listed as required produced no evidence of being read
  UNAVAILABLE: 69,   // EX_UNAVAILABLE: no network or connector after waiting for it
  TEMPFAIL: 75,      // EX_TEMPFAIL: postponed on purpose (dirty tree, lock held); retry later
});
