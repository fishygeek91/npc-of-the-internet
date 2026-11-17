/**
 * Matching-view normalization for the static screen.
 *
 * The output is only ever matched against heuristics (`screenText` returns
 * categories, never text), so it may be lossy: it folds away everything an
 * attacker can use to break a pattern while the text still *reads* the same.
 */

/**
 * Characters rendered as (or in place of) blank space that compatibility
 * normalization does not map to U+0020: Hangul fillers (U+115F, U+1160, U+3164,
 * U+FFA0) and the Braille blank (U+2800). Mapped to a space so
 * "ignore<filler>previous" still splits into words.
 */
const BLANK_LIKE_PATTERN = /[ᅟᅠㅤﾠ⠀]/gu;

/**
 * Invisible characters removed outright: Unicode format characters (Cf) and
 * Default_Ignorable_Code_Point (adds e.g. combining grapheme joiner U+034F,
 * variation selectors U+FE00–FE0F / U+E0100–E01EF).
 */
const IGNORABLE_PATTERN = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/** Combining marks (Mn/Mc/Me), stripped after compatibility decomposition. */
const MARK_PATTERN = /\p{M}/gu;

/** Decimal digits (Nd) from any script. */
const DECIMAL_DIGIT_PATTERN = /\p{Nd}/gu;
const SINGLE_DECIMAL_DIGIT = /^\p{Nd}$/u;

/**
 * Compact confusables map: Cyrillic, Greek and a few Latin-extension letters that
 * render like the ASCII letters used by the screen's patterns. Each source string
 * pairs position-by-position with its target (escapes keep homoglyphs reviewable).
 */
const CONFUSABLE_SOURCES: readonly (readonly [string, string])[] = [
  // Cyrillic lowercase: а е і ј к о р с у х ѕ ԁ ԛ ԝ ү һ ӏ ѵ
  [
    "\u0430\u0435\u0456\u0458\u043A\u043E\u0440\u0441\u0443\u0445\u0455\u0501\u051B\u051D\u04AF\u04BB\u04CF\u0475",
    "aeijkopcyxsdqwyhlv"
  ],
  // Cyrillic uppercase: А В Е К М Н О Р С Т У Х І Ј Ѕ Ԛ Ԝ Һ Ӏ
  [
    "\u0410\u0412\u0415\u041A\u041C\u041D\u041E\u0420\u0421\u0422\u0423\u0425\u0406\u0408\u0405\u051A\u051C\u04BA\u04C0",
    "ABEKMHOPCTYXIJSQWHI"
  ],
  // Greek lowercase: α ο ρ ι κ ν υ χ γ ϲ ϳ
  ["\u03B1\u03BF\u03C1\u03B9\u03BA\u03BD\u03C5\u03C7\u03B3\u03F2\u03F3", "aopikvuxycj"],
  // Greek uppercase: Α Β Ε Ζ Η Ι Κ Μ Ν Ο Ρ Τ Υ Χ Ϲ
  [
    "\u0391\u0392\u0395\u0396\u0397\u0399\u039A\u039C\u039D\u039F\u03A1\u03A4\u03A5\u03A7\u03F9",
    "ABEZHIKMNOPTYXC"
  ],
  // Latin letters that compatibility decomposition leaves alone: ı ɡ ɑ
  ["\u0131\u0261\u0251", "iga"]
];

const CONFUSABLES: ReadonlyMap<string, string> = new Map(
  CONFUSABLE_SOURCES.flatMap(([from, to]) => {
    if (from.length !== to.length) {
      throw new Error("immune: confusable source/target length mismatch");
    }
    return [...from].map((char, index): [string, string] => [char, to.charAt(index)]);
  })
);

const CONFUSABLE_PATTERN = new RegExp(`[${[...CONFUSABLES.keys()].join("")}]`, "gu");

/**
 * ASCII value of a decimal digit from any script. Unicode encodes Nd digits in
 * contiguous runs of ten starting at zero (runs may be adjacent), so the value is
 * the offset from the start of the run, modulo 10.
 */
function asciiDigit(digit: string): string {
  const codePoint = digit.codePointAt(0);
  if (codePoint === undefined || codePoint <= 0x39) {
    return digit;
  }
  let runStart = codePoint;
  for (let steps = 0; steps < 100; steps += 1) {
    if (!SINGLE_DECIMAL_DIGIT.test(String.fromCodePoint(runStart - 1))) {
      break;
    }
    runStart -= 1;
  }
  return String((codePoint - runStart) % 10);
}

/**
 * Normalize untrusted text into the matching view used by the static screen.
 *
 * Steps: compatibility decomposition (NFKD: fullwidth, math alphanumerics,
 * ligatures, accented letters split into base + mark); blank-like fillers → space;
 * remove format / default-ignorable characters and combining marks; any-script
 * decimal digits → ASCII; Cyrillic/Greek homoglyphs → Latin; recompose (NFKC).
 * Idempotent. Lossy by design — match against it, never display or store it.
 */
export function normalizeScreenText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(BLANK_LIKE_PATTERN, " ")
    .replace(IGNORABLE_PATTERN, "")
    .replace(MARK_PATTERN, "")
    .replace(DECIMAL_DIGIT_PATTERN, asciiDigit)
    .replace(CONFUSABLE_PATTERN, (char) => CONFUSABLES.get(char) ?? char)
    .normalize("NFKC");
}
