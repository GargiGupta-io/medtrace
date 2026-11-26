import { units } from "./format.js";

// Checks run in the browser before anything is sent, so the wallet is never
// asked to sign a transaction the contract is bound to reject. The contract
// still enforces every rule; these only catch mistakes early and say why.

// Same limits as DrugRegistry. They count bytes, not characters, so "é" or
// "µ" count double, exactly as Solidity's bytes(s).length does.
export const MAX_NAME_BYTES = 64;
export const MAX_COMPOSITION_BYTES = 256;
export const MAX_CID_BYTES = 100;

export const byteLength = (s) => new TextEncoder().encode(s).length;

// A CIDv0 (Qm + 44 base58 characters) or a base32 CIDv1 (b + lowercase
// a–z and 2–7, as Pinata returns). Stricter than the contract, which only
// checks the first characters, so a half-pasted CID is caught here.
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^b[a-z2-7]{50,99}$/;
export const isCid = (s) => CID_V0.test(s) || CID_V1.test(s);

export function cidProblem(value) {
  const v = value.trim();
  if (!v) return null;
  if (/\s/.test(v)) return "A CID has no spaces.";
  if (v.startsWith("http") || v.includes("/")) return "Paste just the CID, not a link. It's the part after /ipfs/.";
  if (!isCid(v)) return "That doesn't look like a complete IPFS CID. It should start with Qm (46 characters) or b (usually bafy… or bafkrei…).";
  return null;
}

// A whole number of units from 1 up to max (max omitted: no upper limit).
export function quantityProblem(value, max) {
  if (value === "") return null;
  if (!/^\d+$/.test(value) || BigInt(value) === 0n) return "Enter a whole number of units, 1 or more.";
  if (max !== undefined && BigInt(value) > max) return `You only hold ${units(max)} units.`;
  return null;
}

export const isQuantity = (value, max) => value !== "" && quantityProblem(value, max) === null;

export function textProblem(value, maxBytes) {
  const n = byteLength(value.trim());
  return n > maxBytes ? `Too long: ${n} of ${maxBytes} bytes. Accented letters and symbols count double.` : null;
}

// Dates as yyyy-mm-dd from date inputs, compared as UTC midnight like the contract sees them.
export function datesProblem(mfg, expiry, today) {
  if (!mfg || !expiry) return null;
  if (mfg > today) return "The manufacture date can't be in the future.";
  if (expiry <= mfg) return "Expiry must come after the manufacture date.";
  if (expiry <= today) return "This batch would already be expired. Expiry must be after today.";
  return null;
}
