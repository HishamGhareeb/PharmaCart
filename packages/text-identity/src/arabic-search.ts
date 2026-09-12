const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

const TATWEEL = /ـ/gu;
const ARABIC_DIACRITICS = /[\u064b-\u065f\u0670]/gu;
const ALEF_VARIANTS = /[أإآٱٲٵ]/gu;
const TEH_MARBUTA = /ة/gu;
const ALEF_MAQSURA = /ى/gu;
const INVISIBLE_AND_DIRECTIONAL = /[\u200b-\u200f\u2066-\u2069\u202a-\u202e\u2060\ufeff\u061c]/gu;
const ARABIC_INDIC_DIGITS = /[٠-٩]/gu;
const EXTENDED_ARABIC_INDIC_DIGITS = /[۰-۹]/gu;
const WHITESPACE_RUNS = /\s+/gu;

/**
 * Folds the spelling choices that separate two honest renderings of one product
 * name so a search can match across them. It is deliberately lossy and must
 * never be stored, compared as, or converted into an identity. Identifiers go
 * through inspectIdentifierText instead, which refuses exactly what this folds.
 */
export function normaliseForSearch(value: string): string {
  return value
    .normalize('NFKC')
    .replace(INVISIBLE_AND_DIRECTIONAL, '')
    .replace(TATWEEL, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(ALEF_VARIANTS, 'ا')
    .replace(TEH_MARBUTA, 'ه')
    .replace(ALEF_MAQSURA, 'ي')
    .replace(ARABIC_INDIC_DIGITS, (digit) => asciiDigit(digit, ARABIC_INDIC_ZERO))
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) => asciiDigit(digit, EXTENDED_ARABIC_INDIC_ZERO))
    .toLowerCase()
    .replace(WHITESPACE_RUNS, ' ')
    .trim();
}

function asciiDigit(digit: string, zeroCodePoint: number): string {
  return String((digit.codePointAt(0) ?? zeroCodePoint) - zeroCodePoint);
}
