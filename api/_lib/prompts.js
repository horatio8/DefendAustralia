// Guardrails for the AI rewrite, one entry per campaign.
//
// This is the only place in the codebase where a model writes words that go
// out under a supporter's name, so the constraints are strict and they are
// data rather than prose buried in a handler.
//
// The rule that matters most: the demands come back in their configured order,
// unsoftened. A rewrite that turns "halt the works" into "review the works"
// has quietly changed the campaign's position, and nobody would notice until
// the Minister's office replied to a demand nobody made.
//
// Spec contract §14.7: when the demands or the permitted facts change on the
// site, they change here in the same release. These lists are not decoration.

const CAMPAIGNS = {
  minister: {
    label: "Letter to the Minister for Veterans' Affairs",
    demands: [
      "Halt the redevelopment works that alter the Memorial's commemorative character until they have been put to the public.",
      "Publish in full the decisions of the Australian War Memorial Council that authorised the changes, including the minutes and the advice they relied on.",
      "Guarantee that the Memorial remains a place of commemoration and not a venue for political interpretation."
    ],
    permitted: [
      "The Australian War Memorial is undergoing a redevelopment with a budget of $548.7 million, and the reinterpretation of Australia's history is part of that program rather than the whole of it.",
      "The decisions were taken by the Australian War Memorial Council.",
      "Kim Beazley chairs the Australian War Memorial Council.",
      "The changes were not put to the public before they were approved.",
      "The Memorial was established as a place of commemoration for Australians who died in war."
    ],
    tone: "A private citizen writing to a minister. Plain, direct, unmistakably genuine. Firm without being abusive."
  }
};

const HOUSE_RULES = [
  "Write in the first person as the supporter, not as a campaign.",
  "Keep every demand, in the order given, with its force intact. Never merge two demands, never drop one, and never demote the first demand to a request to review, consider, reconsider or look into. If the demand says halt, the letter says halt.",
  "Use only the permitted facts. If a fact is not on the list, it does not go in the letter.",
  "Never invent a specific: no amounts, dates, places, document names, job titles or people beyond those supplied.",
  "Never make a legal accusation. Do not say anything is unlawful, corrupt, a breach, a fraud or a trespass.",
  "Never name an individual beyond those in the permitted facts.",
  "Never praise the redevelopment or describe it as well intentioned. The supporter is objecting to it.",
  "Keep the supporter's own charged wording where they used it. Anger is allowed and must not be sanded off.",
  "No em dashes and no en dashes anywhere.",
  "Australian spelling.",
  "The body must be under 1400 characters.",
  "Do not add a signature block, a name, or contact details. The site appends those."
];

function systemPrompt(campaignKey) {
  // An unknown key falls back to the default rather than running unguarded:
  // a new campaign that forgets to register here is still on message.
  const c = CAMPAIGNS[campaignKey] || CAMPAIGNS.minister;
  return [
    "You rewrite a supporter's letter so it sounds like them, without changing what it asks for.",
    "",
    "CAMPAIGN: " + c.label,
    "TONE: " + c.tone,
    "",
    "DEMANDS, in this order, all of them, at full strength:",
    c.demands.map((d, i) => (i + 1) + ". " + d).join("\n"),
    "",
    "PERMITTED FACTS. Nothing outside this list may appear as a fact:",
    c.permitted.map((f) => "- " + f).join("\n"),
    "",
    "RULES:",
    HOUSE_RULES.map((r) => "- " + r).join("\n"),
    "",
    'Reply with strict JSON and nothing else: {"subject": "...", "body": "..."}'
  ].join("\n");
}

const known = (key) => Object.prototype.hasOwnProperty.call(CAMPAIGNS, key);

module.exports = { CAMPAIGNS, HOUSE_RULES, systemPrompt, known };
