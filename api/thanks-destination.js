// GET /api/thanks-destination — share, or ask for money?
//
// One roll of the PETITION_SHARE_PERCENT dial, for the forms that do not
// pass through /api/petition-signup and so cannot be told inside their own
// response. Today that is the volunteer form, which posts to a form receiver
// rather than to us.
//
// The petition pages must NOT call this. They get their verdict inside the
// signup response, so that one signature rolls once; calling here as well
// would roll a second time and could land the same person on a different
// page from the one their signature was recorded against.
//
// no-store matters more than it looks. A cached verdict would pin every
// visitor behind one CDN edge to the same answer, and the split would quietly
// become a coin that always lands the same way in Sydney and the other way in
// Melbourne.

const h = require("./_lib/http");
const ab = require("./_lib/ab");

module.exports = function handler(req, res) {
  if (h.guard(req, res, "GET")) return;
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ destination: ab.rollThanksDestination() });
};
