import { queryAll } from "./contracts.js";
import { daysUntil, shortAddr } from "./format.js";

export const EXPIRY_WARNING_DAYS = 30;

// SupplyChain.TRANSFER_TTL: a consignment not accepted within 30 days lapses,
// and anyone can send it back to the sender.
export const TRANSFER_TTL_SECONDS = 30 * 24 * 60 * 60;
export const lapsesAt = (initiatedAt) => Number(initiatedAt) + TRANSFER_TTL_SECONDS;
export const hasLapsed = (initiatedAt) => Date.now() / 1000 >= lapsesAt(initiatedAt);

// DrugRegistry.BatchStatus, in contract order. Quarantined was added last.
export const BATCH_STATUS = { Active: 0, Recalled: 1, Quarantined: 2 };
export const isQuarantined = (b) => Number(b.status) === BATCH_STATUS.Quarantined;

// Every participant ever registered, with their CURRENT name, licence, role and status.
export async function loadParticipants(registry, fromBlock) {
  const joined = await queryAll(registry, registry.filters.ParticipantRegistered(), fromBlock);
  const accounts = [...new Set(joined.map((e) => e.args.account))];
  const records = await Promise.all(accounts.map((a) => registry.getParticipant(a)));
  const directory = {};
  records.forEach((p, i) => {
    directory[accounts[i].toLowerCase()] = { address: accounts[i], name: p.name, licenceId: p.licenceId, role: p.role, active: p.active };
  });
  return directory;
}

// Open transfers matching an event filter (sent by me, or sent to me).
async function loadPending(supply, filter, fromBlock) {
  const events = await queryAll(supply, filter, fromBlock);
  const pairs = [...new Map(events.map((e) => [`${e.args.batchId}-${e.args.to}`, e.args])).values()];
  const open = await Promise.all(
    pairs.map(async ({ batchId, to }) =>
      (await supply.hasPendingTransfer(batchId, to)) ? { batchId, to, ...(await supply.getPendingTransfer(batchId, to)).toObject() } : null
    )
  );
  return open.filter(Boolean);
}

// Consignments I dispatched that nobody has accepted, rejected or cancelled yet.
export const loadOutgoing = (supply, address, fromBlock) => loadPending(supply, supply.filters.CustodyTransferInitiated(null, address), fromBlock);

// Consignments waiting for ME to accept or reject.
export const loadIncoming = (supply, address, fromBlock) => loadPending(supply, supply.filters.CustodyTransferInitiated(null, null, address), fromBlock);

// Turns an address into a readable name. The zero address means "manufactured",
// and the SupplyChain contract's own address is stock in transit (escrow).
export function makeNameOf(participants, escrowAddress) {
  const escrow = escrowAddress.toLowerCase();
  return (addr) => {
    if (!addr || /^0x0+$/.test(addr)) return "Manufactured";
    if (addr.toLowerCase() === escrow) return "In transit";
    return participants[addr.toLowerCase()]?.name ?? shortAddr(addr);
  };
}

// Only dead stock can be written off: recalled, or past its expiry date.
// Stock on hold may yet be released, so it can only be sent back.
export const isDisposable = (b) => b.recalled || daysUntil(b.expiryDate) <= 0;

export function batchStatus({ recalled, quarantined, expiryDate }) {
  if (recalled) return { tone: "red", label: "Recalled", frozen: true };
  if (quarantined) return { tone: "amber", label: "On hold", frozen: true };
  const days = daysUntil(expiryDate);
  if (days <= 0) return { tone: "red", label: "Expired", frozen: true };
  if (days <= EXPIRY_WARNING_DAYS) return { tone: "amber", label: `Expires in ${days}d`, frozen: false };
  return { tone: "green", label: "Active", frozen: false };
}
