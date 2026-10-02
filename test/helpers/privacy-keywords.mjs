// The phrases each language pack shipped in privacy.third_party_keywords
// until 02/10/2026. Since then the packs ship an empty list: the curator
// records everything by default (docs/incidents.md, 02/10/2026), and a list
// that refused a line holding a health word would fight that default. A vault
// made before then keeps its list, and lint keeps refusing on it, so the tests
// of that backstop list these phrases explicitly instead of reading the packs.
export const LEGACY_KEYWORDS = Object.freeze({
  en: Object.freeze(['medical appointment', 'doctor\'s appointment', 'sick leave', 'teleconsultation', 'therapy session', 'medical exam', 'hospital stay', 'pregnancy']),
  'pt-BR': Object.freeze(['consulta médica', 'atestado médico', 'licença médica', 'teleconsulta', 'sessão de terapia', 'exame médico', 'internação', 'gravidez']),
});
