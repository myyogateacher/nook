/**
 * The computable palette checks of the data-viz method (validate_palette.js), ported for tests: OKLab
 * from linear sRGB, OKLCH lightness and chroma, the Machado–Oliveira–Fernandes (2009) severity-1.0 CVD
 * simulation, ΔE as OKLab distance ×100, and WCAG contrast. The thresholds are the validator's.
 */

export const PALETTE_THRESHOLDS = {
  band: { light: [0.43, 0.77], dark: [0.48, 0.67] } as Record<"light" | "dark", [number, number]>,
  chromaFloor: 0.1,
  cvdTarget: 8,
  cvdFloor: 6,
  normalFloor: 15,
  contrastMin: 3
};

const MACHADO = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]]
} as const;
type Kind = keyof typeof MACHADO;

const hex2srgb = (hex: string) => { const h = hex.trim().replace(/^#/, ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); };
const s2lin = (c: number) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lin = (hex: string) => hex2srgb(hex).map(s2lin) as [number, number, number];
const relLum = (hex: string) => { const [r, g, b] = lin(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export function contrast(a: string, b: string): number {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function oklabFromLin([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}

export const oklch = (hex: string): [number, number] => { const [L, a, b] = oklabFromLin(lin(hex)); return [L, Math.hypot(a, b)]; };

function simulate(hex: string, kind: Kind): [number, number, number] {
  const [r, g, b] = lin(hex);
  const M = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b), clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b), clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b)];
}

/** OKLab ΔE ×100 between two colours, under a simulated deficiency or (no kind) normal vision. */
export function deltaE(a: string, b: string, kind?: Kind): number {
  const x = oklabFromLin(kind ? simulate(a, kind) : lin(a));
  const y = oklabFromLin(kind ? simulate(b, kind) : lin(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export type PaletteReport = {
  offBand: string[];
  lowChroma: string[];
  /** Worst min(protan, deutan) ΔE on the pair list. */
  worstCvd: number;
  /** Worst ΔE under normal vision on the pair list. */
  worstNormal: number;
  /** Slots below 3:1 against the surface (the relief rule applies). */
  lowContrast: string[];
};

/** The validator's checks for a categorical palette: adjacent pairs, or every pair (scatter). */
export function checkPalette(palette: readonly string[], mode: "light" | "dark", surface: string, pairs: "adjacent" | "all" = "adjacent"): PaletteReport {
  const [lo, hi] = PALETTE_THRESHOLDS.band[mode];
  const n = palette.length;
  const list = pairs === "all"
    ? Array.from({ length: n }, (_, i) => Array.from({ length: n - i - 1 }, (_, k) => [i, i + 1 + k] as const)).flat()
    : Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as const);
  let worstCvd = Infinity;
  let worstNormal = Infinity;
  for (const [i, j] of list) {
    for (const kind of ["protan", "deutan"] as const) worstCvd = Math.min(worstCvd, deltaE(palette[i]!, palette[j]!, kind));
    worstNormal = Math.min(worstNormal, deltaE(palette[i]!, palette[j]!));
  }
  return {
    offBand: palette.filter((color) => { const L = oklch(color)[0]; return L < lo || L > hi; }),
    lowChroma: palette.filter((color) => oklch(color)[1] < PALETTE_THRESHOLDS.chromaFloor),
    worstCvd,
    worstNormal,
    lowContrast: palette.filter((color) => contrast(color, surface) < PALETTE_THRESHOLDS.contrastMin)
  };
}
