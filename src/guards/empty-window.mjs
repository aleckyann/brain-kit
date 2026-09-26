// Nothing to curate. The undated incident in docs/incidents.md, "the
// acceptance criterion demanded facts no round could produce": a Sunday
// with no events is a normal day, not a failure, and a round that demands
// facts on it can never pass. When no source keeps a single file for the
// window, `curate` does not wake the model: it exits 0 saying "nothing to
// curate for <days>", and each source's watermark advances vacuously
// (src/guards/watermark.mjs, `vacuous: true`, which still demands the
// source's evidence to show it expected nothing).
//
// `plans` is `{ [id]: plan }`. A plan whose `files` is not an array is not
// empty: an answer that cannot be read is never "nothing". Nor is a plan
// that lists an unreadable file (controller ruling, fix round 1 of task 6):
// a session nobody could open is not an empty day, and the round goes on
// to exit 4 on it, keeping the day open. Whether a source
// is misconfigured (and so must not advance at all) is the caller's check
// for a required one, made before this one (curate step 11,
// plan.misconfigured, exit 1), and, for any source, its evidence: a plan
// that found nothing to read because nothing is there never counts as read,
// so no vacuous advance moves its mark (ruling R-A9).
export function emptyWindow(plans) {
  if (plans === null || typeof plans !== 'object') return false;
  return Object.values(plans).every((plan) => plan !== null && typeof plan === 'object' && Array.isArray(plan.files) && plan.files.length === 0
    && !(Array.isArray(plan.unreadable) && plan.unreadable.length > 0));
}
