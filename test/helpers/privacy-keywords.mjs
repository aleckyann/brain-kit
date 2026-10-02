// The phrases each language pack shipped in privacy.third_party_keywords
// until 02/10/2026. Since then the packs ship an empty list: the curator
// records everything by default (docs/incidents.md, 02/10/2026), and a list
// that refused a line holding a health word would fight that default. A vault
// made before then keeps its list, and lint keeps refusing on it, so the tests
// of that backstop list these phrases explicitly instead of reading the packs.
// Their one source is src/rules/privacy-keywords.mjs, which doctor reads to
// tell such a list from one a person chose (fix round 1, M1).
export { LEGACY_PACK_KEYWORDS as LEGACY_KEYWORDS } from '../../src/rules/privacy-keywords.mjs';
