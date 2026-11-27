import { useCallback, useEffect, useRef, useState } from "react";
import { blockTime, queryAll, readMany } from "../lib/contracts.js";
import { isQuarantined, loadIncoming, loadOutgoing, loadParticipants } from "../lib/ledger.js";
import { ROLES } from "../lib/roles.js";

// Keeps one dashboard's data live: loads it now, and again shortly after every
// new block, so other people's actions appear without a refresh.
//  - A reload asked for while one is running is queued, never dropped, so the
//    screen always ends up showing the latest block.
//  - When the wallet switches account or network, `fetch` changes; data from
//    the old one is cleared at once and any late result from it is ignored.
//  - loadedAt changes on every reload, for views that fetch their own extra data.
function useLiveData(fetch, provider, empty) {
  const [data, setData] = useState({ ...empty, loading: true });
  const current = useRef(fetch);
  const running = useRef(false);
  const queued = useRef(false);

  const load = useCallback(async () => {
    if (running.current) {
      queued.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        queued.current = false;
        const f = current.current;
        if (!f) break;
        try {
          const next = await f();
          if (f === current.current) setData({ ...next, loading: false, error: null, loadedAt: Date.now() });
        } catch (e) {
          if (f === current.current) setData((d) => ({ ...d, loading: false, error: e?.shortMessage || e?.message }));
        }
      } while (queued.current);
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    current.current = fetch;
    setData({ ...empty, loading: true });
    if (!fetch) return;
    load();
    if (!provider) return;
    let timer;
    const onBlock = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 400);
    };
    provider.on("block", onBlock);
    return () => {
      clearTimeout(timer);
      provider.off("block", onBlock);
    };
    // `empty` is left out on purpose: each hook passes a module-level constant.
  }, [fetch, provider, load]);

  return { ...data, reload: load };
}

const batchFields = (b) => ({
  drugName: b.drugName,
  composition: b.composition,
  manufacturer: b.manufacturer,
  mfgDate: b.mfgDate,
  expiryDate: b.expiryDate,
  quantity: b.quantity,
  ipfsHash: b.ipfsHash,
  quarantined: isQuarantined(b),
});

// Who each batch is on its way to. Read on its own so a deployment from before
// getPendingRecipients existed still loads, just without this list.
async function pendingRecipients(supply, ids) {
  try {
    return (await readMany(ids.map((id) => [supply, "getPendingRecipients", id]))).map((list) => [...list]);
  } catch {
    return ids.map(() => []);
  }
}

// Runs `reads(id)` for every id in one batched round of reads, and hands each
// id its results in the same order.
async function readPerId(ids, reads) {
  const perId = ids.map(reads);
  const flat = await readMany(perId.flat());
  let i = 0;
  return perId.map((calls) => flat.slice(i, (i += calls.length)));
}

// Everything the manufacturer dashboard shows.
const EMPTY_MANUFACTURER = { participants: {}, batches: [], inTransit: [] };
export function useManufacturerLedger(wallet) {
  const { contracts, deployment, address, provider } = wallet;

  const fetch = useCallback(async () => {
    const { registry, supply, inventory } = contracts;
    const from = deployment.deployedBlock ?? 0;
    const [participants, made, inTransit] = await Promise.all([
      loadParticipants(registry, from),
      queryAll(registry, registry.filters.BatchRegistered(null, address), from),
      loadOutgoing(supply, address, from),
    ]);

    // The batches this manufacturer registered.
    const ids = [...new Set(made.map((e) => e.args.batchId))];
    const rows = await readPerId(ids, (id) => [
      [registry, "getBatchDetails", id],
      [inventory, "getFacilityStock", address, id],
      [inventory, "isRecalled", id],
      [inventory, "getAffectedHolders", id],
    ]);
    const pendingTo = await pendingRecipients(supply, ids);
    const batches = ids.map((id, i) => {
      const [b, stock, recalled, holders] = rows[i];
      return { id, ...batchFields(b), stock, recalled, holders: [...holders], pendingTo: pendingTo[i] };
    });
    batches.sort((a, b) => Number(b.id - a.id));

    // Who placed each current hold. A regulator's hold can only be lifted by a regulator.
    await Promise.all(
      batches
        .filter((b) => b.quarantined)
        .map(async (b) => {
          const holds = await queryAll(inventory, inventory.filters.BatchQuarantined(b.id), from);
          const last = holds.at(-1)?.args;
          b.hold = last && { by: last.issuedBy, reason: last.reason, byRegulator: participants[last.issuedBy.toLowerCase()]?.role === ROLES.REGULATOR };
        })
    );

    return { participants, batches, inTransit };
  }, [contracts, deployment, address]);

  return useLiveData(contracts ? fetch : null, provider, EMPTY_MANUFACTURER);
}

// For distributors and pharmacies: stock they hold rather than make.
const EMPTY_HOLDER = { participants: {}, holdings: [], incoming: [], outgoing: [], dispensed: [] };
export function useHolderLedger(wallet) {
  const { contracts, deployment, address, provider } = wallet;

  const fetch = useCallback(async () => {
    const { registry, supply, inventory } = contracts;
    const from = deployment.deployedBlock ?? 0;
    const [participants, received, incoming, outgoing, dispenses] = await Promise.all([
      loadParticipants(registry, from),
      queryAll(inventory, inventory.filters.StockUpdated(null, null, address), from),
      loadIncoming(supply, address, from),
      loadOutgoing(supply, address, from),
      // My own dispenses, straight from the events: one cached query instead
      // of reading every batch's whole dispensing log on every block.
      queryAll(inventory, inventory.filters.DrugDispensed(null, address), from),
    ]);

    // Every batch that ever reached me, with what I hold now.
    const ids = [...new Set(received.map((e) => e.args.batchId))];
    const rows = await readPerId(ids, (id) => [
      [registry, "getBatchDetails", id],
      [inventory, "getFacilityStock", address, id],
      [inventory, "isRecalled", id],
      [inventory, "getReorderThreshold", address, id],
    ]);
    const all = ids.map((id, i) => {
      const [b, stock, recalled, threshold] = rows[i];
      return { id, ...batchFields(b), stock, recalled, threshold };
    });
    const holdings = all.filter((r) => r.stock > 0n).sort((a, b) => Number(a.expiryDate - b.expiryDate));

    const nameById = Object.fromEntries(all.map((r) => [r.id.toString(), r.drugName]));
    const times = await Promise.all(dispenses.map((e) => blockTime(provider ?? inventory.runner.provider, e.blockNumber)));
    const dispensed = dispenses
      .map((e, i) => ({ batchId: e.args.batchId, drugName: nameById[e.args.batchId.toString()] ?? `Batch #${e.args.batchId}`, quantity: e.args.quantity, timestamp: times[i] }))
      .sort((a, b) => b.timestamp - a.timestamp);

    return { participants, holdings, incoming, outgoing, dispensed };
  }, [contracts, deployment, address, provider]);

  return useLiveData(contracts ? fetch : null, provider, EMPTY_HOLDER);
}

// For regulators and the admin: every batch on the network, who holds it,
// and every recall. Batch IDs run 1..batchCount with no gaps.
const EMPTY_NETWORK = { participants: {}, batches: [], recalls: [] };
export function useNetworkLedger(wallet) {
  const { contracts, deployment, provider } = wallet;

  const fetch = useCallback(async () => {
    const { registry, supply, inventory } = contracts;
    const from = deployment.deployedBlock ?? 0;
    const [participants, count, recallEvents] = await Promise.all([
      loadParticipants(registry, from),
      registry.batchCount(),
      queryAll(inventory, inventory.filters.BatchRecalled(), from),
    ]);

    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
    const rows = await readPerId(ids, (id) => [
      [registry, "getBatchDetails", id],
      [inventory, "isRecalled", id],
      [inventory, "getAffectedHolders", id],
    ]);
    // Second round: every holder's stock of every batch, all in one go.
    const holderLists = rows.map(([, , h]) => [...h]);
    const [stocks, pendingTo] = await Promise.all([
      readPerId(ids, (id, i) => holderLists[i].map((h) => [inventory, "getFacilityStock", h, id])),
      pendingRecipients(supply, ids),
    ]);

    const batches = ids.map((id, i) => {
      const [b, recalled] = rows[i];
      const holders = holderLists[i];
      return {
        id,
        ...batchFields(b),
        recalled,
        holders,
        holdings: holders.map((h, j) => ({ address: h, stock: stocks[i][j] })),
        unitsOut: stocks[i].reduce((s, v) => s + v, 0n),
        pendingTo: pendingTo[i],
      };
    });
    batches.sort((a, b) => Number(b.id - a.id));

    const rp = provider ?? inventory.runner.provider;
    const times = await Promise.all(recallEvents.map((e) => blockTime(rp, e.blockNumber)));
    const recalls = recallEvents
      .map((e, i) => ({ batchId: e.args.batchId, by: e.args.issuedBy, reason: e.args.reason, timestamp: times[i] }))
      .sort((a, b) => b.timestamp - a.timestamp);

    return { participants, batches, recalls };
  }, [contracts, deployment, provider]);

  return useLiveData(contracts ? fetch : null, provider, EMPTY_NETWORK);
}
