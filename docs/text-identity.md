# PharmaCart bilingual text and product identity (B5)

Status: implemented, unit-tested, no interface attached
Scope: keeping a product identifier the same thing when it is stored, displayed beside Arabic text, and searched for
Source input: *PharmaCart Builder Master Plan*, sections 16 and 24 and 34; acceptance criterion AC-018

`packages/text-identity` holds two halves that must never be confused with each other. One is strict and governs identity. The other is lossy and governs search. The whole package exists to keep the line between them visible.

## 1. Right-to-left rendering must not alter identity

AC-018 says an Arabic, keyboard-only user must reach the same approved result, and that right-to-left layout must not alter product identity. The second half is not a layout concern. It is a text-content concern, and it has a known attack.

Unicode carries characters that change how later text is displayed without changing the text itself. The override and embedding characters in the U+202A to U+202E range can make a string render in an order that differs from the order it is stored in, so a screen reading `SKU-123` can hold `SKU-321`. This is the same mechanism as the Trojan Source source-code attack, and in a procurement system it means a purchaser approving a code they can see and an order carrying a code they cannot.

`inspectBidirectionalText` refuses every bidirectional formatting character in incoming data: the overrides and embeddings, the isolates, and the invisible left-to-right and right-to-left marks. None of them has a legitimate place in a vendor's product name or code. Refusing all of them is simpler than reasoning about which combinations are safe, and a vendor whose feed contains one has a defect worth telling them about.

The inspection also reports which scripts are actually present, so a caller can tell a purely Arabic label from a mixed one without re-scanning.

## 2. Isolation is produced, never accepted

Formatting characters are refused on the way in and added on the way out. `isolateIdentifier` wraps a code in an isolate pair so that placing it beside Arabic text cannot reorder it on screen.

Isolates are used rather than the older embedding and override characters because an isolate cannot influence text outside itself. A label assembled from several isolated parts therefore stays predictable no matter what order the parts arrive in, which an override cannot promise.

The safety property is asserted as a round trip: stripping the formatting from an isolated identifier returns the original string exactly. Wrapping is presentation, and presentation must be reversible without loss. `isolateIdentifier` refuses to wrap anything that failed identifier inspection, so a hostile string cannot acquire a veneer of safety by passing through the display path.

## 3. Identity is strict about digits

`inspectIdentifierText` refuses non-ASCII digits. Arabic-Indic `٥٠٠` and Persian `۵۰۰` are different code points from `500`, and a catalogue holding both spellings of one code holds two products.

It does not refuse Arabic letters. Source codes are opaque vendor strings and a vendor is entitled to use its own script for them. The line is drawn at characters that are confusable or invisible rather than at script, so visible letters pass and zero-width joiners, word joiners and directional marks do not.

## 4. Search folds what identity refuses

`normaliseForSearch` does the opposite job on purpose. It folds the alef variants a typist chooses between, strips decorative tatweel elongation and diacritics, unifies teh marbuta with heh and alef maqsura with yeh, converts Arabic-Indic and Persian digits to ASCII, lowercases, and collapses whitespace. Two honest spellings of one product name then meet.

It is idempotent, so a normalised query can be normalised again without drifting.

Its output must never be stored, compared as, or converted into an identity. The function that folds `SKU-٥٠٠` into `sku-500` sits beside the function that refuses `SKU-٥٠٠` as an identifier, and the test asserts both behaviours in one place so the distinction cannot quietly erode. Folding for matching is a convenience. Folding for identity is how a pharmacy orders the wrong product.

## 5. Boundary

AC-018 remains NOT RUN, and most of it is still ahead. The criterion names a manual device and accessibility review with an Arabic keyboard-only user completing a purchase through reachable controls, retaining a checklist, screenshots and the resulting order comparison. None of the four clients exists, so there is no keyboard path to walk and no rendering to review.

What exists is the part a manual review cannot establish: that identity survives the trip through display and search. A reviewer can confirm a screen looks right. Only a test can confirm that what the screen shows is what the order will carry.

Three limits are deliberate. This package does not implement the Unicode bidirectional algorithm and must not be read as doing so; it refuses the characters that make the algorithm produce a misleading result, and leaves the layout itself to the platform. Arabic search folding covers the common orthographic choices and not stemming, synonyms or transliteration between scripts, which is a catalogue search concern rather than a text safety one. Nothing here addresses right-to-left layout, focus order or screen-reader labelling, which are genuine parts of AC-018 and belong to whichever client is built first.
