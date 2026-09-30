import { PASSPHRASE_WORDS } from "./wordlist";

/**
 * The value generator (vault plan §6.7): characters, hex or base64url tokens, and passphrases, from
 * `crypto.getRandomValues` with rejection sampling, so every symbol is equally likely. It runs in
 * the browser only; nothing is sent anywhere until the person saves. Strength is shown as entropy
 * bits of the generated value (there is no zxcvbn: people do not choose these). No breach check
 * (V-O8): it would add a third-party request, and generated values are not in breach lists.
 */

export type GeneratorKind = "characters" | "hex" | "base64url" | "passphrase";
export type CharacterSets = { lower: boolean; upper: boolean; digits: boolean; symbols: boolean };
export type GeneratorOptions = {
  kind: GeneratorKind;
  /** Characters: 8–128 characters. */
  length: number;
  sets: CharacterSets;
  /** Hex and base64url: 16–64 random bytes. */
  bytes: number;
  /** Passphrases: 3–12 words. */
  words: number;
  separator: "-" | "." | " " | "_";
};

export const GENERATOR_BOUNDS = { length: [8, 128], bytes: [16, 64], words: [3, 12] } as const;
export const DEFAULT_GENERATOR: GeneratorOptions = {
  kind: "characters", length: 32, sets: { lower: true, upper: true, digits: true, symbols: true }, bytes: 32, words: 6, separator: "-"
};

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
/** Symbols that survive shells, URLs, and .env files without quoting surprises. */
const SYMBOLS = "!#%+-.:=@^_~";

type RandomSource = (array: Uint32Array) => Uint32Array;
const defaultRandom: RandomSource = (array) => crypto.getRandomValues(array);

/** A uniform integer in [0, max): values in the biased top slice of 2^32 are drawn again. */
export function randomBelow(max: number, random: RandomSource = defaultRandom): number {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError("max out of range");
  const limit = Math.floor(2 ** 32 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    random(buffer);
    if (buffer[0]! < limit) return buffer[0]! % max;
  }
}

const clamp = (value: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

export function alphabetFor(sets: CharacterSets) {
  return `${sets.lower ? LOWER : ""}${sets.upper ? UPPER : ""}${sets.digits ? DIGITS : ""}${sets.symbols ? SYMBOLS : ""}`;
}

export function generate(options: GeneratorOptions, random: RandomSource = defaultRandom): { value: string; bits: number } {
  if (options.kind === "passphrase") {
    const count = clamp(options.words, GENERATOR_BOUNDS.words);
    const words = Array.from({ length: count }, () => PASSPHRASE_WORDS[randomBelow(PASSPHRASE_WORDS.length, random)]!);
    return { value: words.join(options.separator), bits: count * Math.log2(PASSPHRASE_WORDS.length) };
  }
  if (options.kind === "hex" || options.kind === "base64url") {
    const count = clamp(options.bytes, GENERATOR_BOUNDS.bytes);
    const bytes = Array.from({ length: count }, () => randomBelow(256, random));
    const value = options.kind === "hex"
      ? bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")
      : btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { value, bits: count * 8 };
  }
  const alphabet = alphabetFor(options.sets) || LOWER + UPPER + DIGITS;
  const length = clamp(options.length, GENERATOR_BOUNDS.length);
  const value = Array.from({ length }, () => alphabet[randomBelow(alphabet.length, random)]).join("");
  return { value, bits: length * Math.log2(alphabet.length) };
}

/** "128 bits · very strong": a plain reading of the entropy of a generated value. */
export function strengthLabel(bits: number) {
  const rounded = Math.floor(bits);
  const word = bits >= 128 ? "very strong" : bits >= 80 ? "strong" : bits >= 60 ? "fair" : "weak";
  return `${rounded} bits · ${word}`;
}
