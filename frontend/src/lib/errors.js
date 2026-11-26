import { allErrors } from "./contracts.js";
import { formatUnits } from "ethers";

// The contracts' custom errors, in words a pharmacist or manufacturer can act on.
const MESSAGES = {
  AccessControlUnauthorizedAccount: () => "Your account doesn't have the role this action needs.",
  ZeroQuantity: () => "Quantity must be more than zero.",
  EmptyField: () => "A required field is empty.",
  InvalidDates: () => "The manufacture date must be set and not in the future, and expiry must come after it and be in the future.",
  FieldTooLong: () => "A field is too long. Names and licence IDs allow 64 characters, composition 256.",
  InvalidCid: () => "That certificate link isn't an IPFS CID. It should start with Qm or b.",
  RoleManagedByRegistry: () => "Roles can't be granted directly. Use the participant tools, or invite a new admin.",
  LastAdmin: () => "You can't remove the last admin. Add another admin first.",
  BatchNotFound: (a) => `Batch #${a[0]} doesn't exist. It may be forged.`,
  AlreadyRegistered: () => "That address is already registered (or is already an admin).",
  NotRegistered: (a) => `${short(a[0])} isn't an active participant. If this is your consignment, ask the sender to cancel it.`,
  InvalidRole: () => "That isn't a valid participant role.",
  InvalidRoute: () => "That handoff isn't allowed. Stock only moves to a distributor or pharmacy.",
  InsufficientStock: (a) => `Not enough stock: you hold ${num(a.at(-2))}, tried to move ${num(a.at(-1))}.`,
  BatchIsExpired: (a) => `Batch #${a[0]} has expired. It can't be moved or dispensed.`,
  BatchIsRecalled: (a) => `Batch #${a[0]} has been recalled. It can't be moved or dispensed.`,
  TransferAlreadyPending: () => "There's already a transfer of this batch waiting for that recipient.",
  NoPendingTransfer: () => "There's no pending transfer to act on.",
  SelfTransfer: () => "You can't send stock to yourself.",
  ZeroAddress: () => "A recipient address is required.",
  NotPharmacy: () => "Only a pharmacy can dispense.",
  NotAuthorisedToRecall: () => "Only the batch's manufacturer (while still active) or a regulator can recall it.",
  AlreadyRecalled: (a) => `Batch #${a[0]} is already recalled.`,
  BatchIsQuarantined: (a) => `Batch #${a[0]} is on hold while a problem is investigated. It can't be moved or dispensed until it's released.`,
  AlreadyQuarantined: (a) => `Batch #${a[0]} is already on hold.`,
  NotQuarantined: (a) => `Batch #${a[0]} isn't on hold.`,
  NotAuthorisedToQuarantine: () => "Only the batch's manufacturer (while still active) or a regulator can place a hold. A hold placed by a regulator can only be lifted by a regulator.",
  StockNotDisposable: (a) => `Batch #${a[0]} is still good. Only recalled or expired stock can be destroyed.`,
  ReturnNotAllowed: (a) => `Batch #${a[0]} is still good, so it can't go back to the manufacturer. Returns are for recalled, on-hold or expired stock.`,
  Paused: () => "The network is paused for an emergency. Recalls, holds, returns and write-offs still work; everything else waits until an admin resumes it.",
  NotPaused: () => "The network isn't paused.",
  NotAuthorisedToPause: () => "Only an admin or a regulator can pause the network, and only an admin can resume it.",
  NoAdminProposal: () => "There's no admin invitation for that account.",
  TransferHasLapsed: () => "This consignment waited more than 30 days and has lapsed. It can only be sent back to the sender now.",
  TransferNotLapsed: () => "This consignment hasn't reached its 30-day limit yet. The recipient can still accept or reject it, or the sender can cancel it.",
  NotAuthorisedToForceReturn: () => "Only an admin or a regulator can recover stock from a revoked participant.",
  HolderStillActive: () => "That holder is still active, so their stock isn't stranded. They can ship it or send it back themselves.",
  InvalidStatusTransition: () => "That status change isn't allowed. A recall is final and can't be undone.",
};

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const num = (v) => Number(formatUnits(v, 0)).toLocaleString("en-IN");

function findRevertData(err) {
  for (const candidate of [err?.data, err?.info?.error?.data, err?.error?.data, err?.info?.error?.data?.data]) {
    if (typeof candidate === "string" && candidate.startsWith("0x") && candidate.length >= 10) return candidate;
  }
  return null;
}

// Failures that come from the wallet or the network rather than a contract rule.
const WALLET_AND_NETWORK = {
  INSUFFICIENT_FUNDS: () => "This wallet doesn't have enough ETH to pay the network fee. On Sepolia, get free test ETH from a faucet.",
  NONCE_EXPIRED: () => "Your wallet tried to reuse an old transaction slot. Reset the account's activity in MetaMask (Settings → Advanced → Clear activity) and try again.",
  REPLACEMENT_UNDERPRICED: () => "A transaction is already pending from this wallet. Wait for it, or speed it up in MetaMask.",
  NETWORK_ERROR: () => "Lost contact with the network. Check your connection. If the transaction was sent, it may still confirm: the dashboard updates when it does.",
  TIMEOUT: () => "The network didn't answer in time. If the transaction was sent, it may still confirm: the dashboard updates when it does.",
  TRANSACTION_REPLACED: (err) =>
    err.cancelled
      ? "You cancelled this in your wallet (or sent something else in its place), so it never happened."
      : "You sped this up in your wallet, but the faster copy was rejected by the contract.",
};

export function explainError(err) {
  if (err?.code === "ACTION_REJECTED" || err?.info?.error?.code === 4001) return "You cancelled it in your wallet.";
  if (err?.code === "TRANSACTION_REPLACED") return WALLET_AND_NETWORK.TRANSACTION_REPLACED(err);
  const data = findRevertData(err);
  if (data) {
    try {
      const parsed = allErrors.parseError(data);
      if (parsed) return (MESSAGES[parsed.name] ?? (() => `Rejected by the contract: ${parsed.name}.`))(parsed.args);
    } catch {
      /* not one of ours */
    }
  }
  if (err?.revert?.name) return (MESSAGES[err.revert.name] ?? (() => `Rejected: ${err.revert.name}.`))(err.revert.args);
  if (WALLET_AND_NETWORK[err?.code]) return WALLET_AND_NETWORK[err.code](err);
  if (/insufficient funds/i.test(err?.info?.error?.message ?? err?.message ?? "")) return WALLET_AND_NETWORK.INSUFFICIENT_FUNDS();
  return err?.shortMessage || err?.message || "Something went wrong.";
}
