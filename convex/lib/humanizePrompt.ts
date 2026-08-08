// Distilled no-ai-slop rules adapted for YouTube metadata generation.
// Based on: https://github.com/petergyang/no-ai-slop
// Applied when the user has enabled "Humanize Writing" for a generation.

export const HUMANIZE_METADATA_RULES = `
HUMANIZE WRITING — apply these rules to every word you output:

BANNED WORDS — never use: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, this is huge, this changes everything, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, game-changing, revolutionary, innovative, groundbreaking, comprehensive, dive deep, ultimate guide, unlock.

PATTERNS TO CUT:
- Binary contrasts: "not just X, but Y" / "it's not X, it's Y" — state Y directly
- Colon reveals: "The result: pure gold" / "The secret: consistency" — rewrite as plain sentences
- Importance puffery: "marks a pivotal moment", "stands as a testament", "plays a vital role" — state the fact, let the reader judge
- Throat-clearing openers: "In this video, we dive into..." / "Here's the thing" — cut and start with the actual point
- Faux-insight setups: "What most people get wrong", "The part nobody tells you" — cut the setup, make the claim stand alone
- Fake-profound kickers: don't end with a poetic metaphor or mic-drop line — end on the clearest concrete sentence
- Weasel attribution: "experts agree", "studies show", "many argue" — name the source or cut the claim
- Summary-recap endings: no "In conclusion", "Ultimately", "Overall"

WRITING RULES:
- Be concrete and specific: "cut deploy time from 40 min to 4" beats "significantly improved efficiency"
- Use the portability test: if a sentence could appear unchanged on any other creator's channel, cut it or replace it with something specific to this video
- Active voice: "the team shipped it" beats "the decision was made"
- Make verbs do the work: "decided" beats "made a decision", "can" beats "has the ability to"
- No empty adverbs when they add nothing: just, literally, honestly, simply, actually, truly, fundamentally, importantly, crucially
- Titles and descriptions should sound like a person who actually made and watched this video — not a content marketing bot
`.trim();
