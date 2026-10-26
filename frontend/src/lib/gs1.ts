import bwipjs from "bwip-js";

export interface Gs1Identifiers {
  gtin?: string;
  lot?: string;
  serial?: string;
  expiry?: string;
}

/**
 * Calculates the modulo 10 Luhn-style check digit for a 13-digit GTIN base
 */
export function calculateGtin14CheckDigit(digits13: string): number {
  const cleaned = digits13.replace(/\D/g, "");
  if (cleaned.length !== 13) {
    throw new Error(`GTIN base must be exactly 13 digits, received ${cleaned.length}`);
  }

  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const digit = parseInt(cleaned[i], 10);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * Validates a 14-digit GTIN (Global Trade Item Number)
 */
export function isValidGtin14(gtin: string): boolean {
  const cleaned = gtin.replace(/\D/g, "");
  if (cleaned.length !== 14) return false;

  const base13 = cleaned.slice(0, 13);
  const expectedCheckDigit = calculateGtin14CheckDigit(base13);
  const actualCheckDigit = parseInt(cleaned[13], 10);

  return expectedCheckDigit === actualCheckDigit;
}

/**
 * Normalizes and formats a string into a valid 14-digit GTIN with leading zeroes
 */
export function formatGtin14(raw: string): string {
  const cleaned = raw.replace(/\D/g, "");
  if (cleaned.length === 14 && isValidGtin14(cleaned)) {
    return cleaned;
  }
  if (cleaned.length === 13) {
    return cleaned + calculateGtin14CheckDigit(cleaned);
  }
  if (cleaned.length < 13) {
    const padded = cleaned.padStart(13, "0");
    return padded + calculateGtin14CheckDigit(padded);
  }
  return cleaned.slice(0, 14);
}

/**
 * Constructs a standard GS1 Digital Link conforming to the URI standard:
 * https://pharmatree.io/01/{GTIN}/10/{Batch}/21/{Serial}?17={YYMMDD}
 *
 * (Note: Key qualifiers 10 and 21 belong in path; expiry 17 belongs in query string)
 */
export function buildGs1DigitalLink(options: {
  gtin: string;
  lot: string;
  serial: string;
  expiry?: string;
  baseUrl?: string;
}): string {
  const base = options.baseUrl?.replace(/\/$/, "") || "https://pharmatree.io";
  const gtin = formatGtin14(options.gtin);
  const lot = encodeURIComponent(options.lot.trim());
  const serial = encodeURIComponent(options.serial.trim());

  let url = `${base}/01/${gtin}/10/${lot}/21/${serial}`;
  if (options.expiry) {
    const cleanedExpiry = options.expiry.replace(/\D/g, "").slice(0, 6);
    if (cleanedExpiry.length === 6) {
      url += `?17=${cleanedExpiry}`;
    }
  }

  return url;
}

/**
 * Parses a GS1 Digital Link URL or URI path
 */
export function parseGs1DigitalLink(urlOrPath: string): Gs1Identifiers | null {
  try {
    const url = urlOrPath.startsWith("http") ? new URL(urlOrPath) : new URL(`https://pharmatree.io${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`);
    const pathname = url.pathname;

    const match = pathname.match(/\/01\/(\d{14})\/10\/([^\/\?]+)\/21\/([^\/\?]+)/);
    if (!match) return null;

    const gtin = match[1];
    const lot = decodeURIComponent(match[2]);
    const serial = decodeURIComponent(match[3]);
    const expiry = url.searchParams.get("17") || undefined;

    return {
      gtin,
      lot,
      serial,
      expiry,
    };
  } catch {
    return null;
  }
}

/**
 * Parses raw GS1 element string formatted with bracketed AIs or ASCII \x1d group separators
 */
export function parseGs1ElementString(raw: string): Gs1Identifiers | null {
  if (!raw || typeof raw !== "string") return null;

  // 1. Bracketed format: e.g. (01)00300123456789(17)261231(10)LOT123\x1d(21)SN456
  const gtinBracket = raw.match(/\(01\)(\d{14})/);
  const lotBracket = raw.match(/\(10\)([^\(\x1d]+)/);
  const serialBracket = raw.match(/\(21\)([^\(\x1d]+)/);
  const expiryBracket = raw.match(/\(17\)(\d{6})/);

  if (gtinBracket || lotBracket || serialBracket) {
    return {
      gtin: gtinBracket ? gtinBracket[1] : undefined,
      lot: lotBracket ? lotBracket[1] : undefined,
      serial: serialBracket ? serialBracket[1] : undefined,
      expiry: expiryBracket ? expiryBracket[1] : undefined,
    };
  }

  // 2. Continuous element string with ASCII GS (0x1D) separators
  const parts = raw.split(/\x1d/);
  const result: Gs1Identifiers = {};

  for (const part of parts) {
    if (part.startsWith("01") && part.length >= 16) {
      result.gtin = part.slice(2, 16);
      let remainder = part.slice(16);
      if (remainder.startsWith("17") && remainder.length >= 8) {
        result.expiry = remainder.slice(2, 8);
        remainder = remainder.slice(8);
      }
      if (remainder.startsWith("10")) {
        result.lot = remainder.slice(2);
      } else if (remainder.startsWith("21")) {
        result.serial = remainder.slice(2);
      }
    } else if (part.startsWith("10")) {
      result.lot = part.slice(2);
    } else if (part.startsWith("21")) {
      result.serial = part.slice(2);
    } else if (part.startsWith("17") && part.length >= 8) {
      result.expiry = part.slice(2, 8);
      const remainder = part.slice(8);
      if (remainder.startsWith("10")) {
        result.lot = remainder.slice(2);
      } else if (remainder.startsWith("21")) {
        result.serial = remainder.slice(2);
      }
    }
  }

  if (result.gtin || result.lot || result.serial) {
    return result;
  }

  return null;
}

/**
 * Formats GS1 data into element string formatted for GS1 DataMatrix
 */
export function formatGs1ElementDataMatrixString(options: {
  gtin: string;
  lot: string;
  serial: string;
  expiry?: string;
}): string {
  const gtin = formatGtin14(options.gtin);
  let str = `(01)${gtin}`;
  if (options.expiry) {
    str += `(17)${options.expiry}`;
  }
  str += `(10)${options.lot}\x1d(21)${options.serial}`;
  return str;
}

/**
 * Generates an SVG string representation of a GS1 DataMatrix 2D barcode
 */
export function generateGs1DataMatrixSvg(data: string): string {
  return (bwipjs as any).toSVG({
    bcid: "datamatrix",
    text: data,
    scale: 3,
    includetext: false,
  });
}

/**
 * Generates a base64 PNG data URL of a GS1 DataMatrix 2D barcode
 */
export async function generateGs1DataMatrixBase64(data: string): Promise<string> {
  const buffer = await bwipjs.toBuffer({
    bcid: "datamatrix",
    text: data,
    scale: 3,
    includetext: false,
  });
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
