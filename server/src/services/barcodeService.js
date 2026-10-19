/**
 * Barcode generation — Code128 and EAN-13, PNG buffers for label sheets.
 * bwip-js renders purely in Node (no native deps, works offline).
 */
import bwipjs from 'bwip-js';

/** EAN-13 check digit over 12 digits. */
export function ean13CheckDigit(first12) {
  const digits = first12.split('').map(Number);
  let sum = 0;
  digits.forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 1 : 3); // positions 1..12 alternate 1,3
  });
  return (10 - (sum % 10)) % 10;
}

/**
 * Normalise a barcode value for its symbology.
 * - CODE128: anything non-empty (we auto-derive one if missing)
 * - EAN13: must be 12 digits (we append the check digit) or 13 valid digits
 * Returns { value } or { error }.
 */
export function normalizeBarcode(raw, type, fallbackSeed) {
  if (type === 'EAN13') {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 12) return { value: digits + ean13CheckDigit(digits) };
    if (digits.length === 13) {
      const expected = ean13CheckDigit(digits.slice(0, 12));
      if (Number(digits[12]) === expected) return { value: digits };
      return { error: `Invalid EAN-13 check digit (expected ${expected})` };
    }
    return { error: 'EAN-13 requires 12 or 13 digits' };
  }

  // CODE128
  const value = String(raw || '').trim() || autoCode128(fallbackSeed);
  if (!/^[\x20-\x7E]+$/.test(value)) {
    return { error: 'Barcode may only contain printable ASCII characters' };
  }
  return { value };
}

/** Derive a stable Code128 value from a SKU: UGR + SKU (alnum only). */
export const autoCode128 = (sku) => {
  const clean = String(sku || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return `UGR${clean || Date.now().toString(36).toUpperCase()}`;
};

/** Render a barcode to a PNG buffer. */
export async function renderPng(value, type, { height = 40, scale = 2, includetext = true } = {}) {
  const opts =
    type === 'EAN13'
      ? {
          bcid: 'ean13',
          text: includetext ? value : undefined,
          height,
          scale,
          includetext,
          padding: 2,
          paddingtop: 2,
          paddingbottom: 2,
        }
      : {
          bcid: 'code128',
          text: includetext ? value : undefined,
          height,
          scale,
          includetext,
          padding: 2,
          paddingtop: 2,
          paddingbottom: 2,
        };
  return bwipjs.toBuffer(opts);
}

/** Inline SVG string (crisper on label sheets; scales without re-render). */
export async function renderSvg(value, type, { height = 40 } = {}) {
  const opts =
    type === 'EAN13'
      ? { bcid: 'ean13', text: value, height, includetext: true }
      : { bcid: 'code128', text: value, height, includetext: true };
  return bwipjs.toSVG(opts);
}
