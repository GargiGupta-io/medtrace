import { Contract, Interface } from "ethers";
import IDrugRegistry from "../abi/IDrugRegistry.json";
import ISupplyChain from "../abi/ISupplyChain.json";
import IInventoryManager from "../abi/IInventoryManager.json";

export const ABIS = { IDrugRegistry, ISupplyChain, IInventoryManager };

// One contract object per contract, talking through the interface ABIs.
export function getContracts(deployment, runner) {
  const c = deployment.contracts;
  return {
    registry: new Contract(c.DrugRegistry, IDrugRegistry, runner),
    supply: new Contract(c.SupplyChain, ISupplyChain, runner),
    inventory: new Contract(c.InventoryManager, IInventoryManager, runner),
  };
}

// Every custom error across all three contracts. A revert raised inside one
// contract can surface through a call to another, so decode against all.
export const allErrors = new Interface([
  ...IDrugRegistry.filter((x) => x.type === "error"),
  ...ISupplyChain.filter((x) => x.type === "error"),
  ...IInventoryManager.filter((x) => x.type === "error"),
]);

// Blocks this deep are treated as final and cached for good. Anything newer
// is re-read on every query, so a chain reorganisation can't leave a stale
// event in the cache.
const CONFIRMATIONS = 12;
const logCache = new Map();

// Reads every matching event from the deployment block onward. Public RPCs
// cap how many blocks one log query may span, so long ranges go in chunks.
// The first call reads the whole range; later calls with the same filter
// read only the blocks since, so a dashboard reloading on every block stays
// cheap however long the contracts have been live.
export async function queryAll(contract, filter, fromBlock = 0, chunk = 9000) {
  const provider = contract.runner.provider;
  const [latest, { chainId }, address, topics] = await Promise.all([
    provider.getBlockNumber(),
    provider.getNetwork(),
    contract.getAddress(),
    filter?.getTopicFilter ? filter.getTopicFilter() : filter,
  ]);
  const key = JSON.stringify([chainId.toString(), address, topics, fromBlock]);

  // cached.events holds every match from fromBlock to cached.through, all final.
  let cached = logCache.get(key);
  if (cached && latest < cached.through) cached = null; // a restarted local node

  const start = cached ? cached.through + 1 : fromBlock;
  const fresh = [];
  for (let s = start; s <= latest; s += chunk + 1) {
    fresh.push(...(await contract.queryFilter(filter, s, Math.min(s + chunk, latest))));
  }

  const through = Math.max(cached ? cached.through : fromBlock - 1, latest - CONFIRMATIONS);
  const settled = [...(cached?.events ?? []), ...fresh.filter((e) => e.blockNumber <= through)];
  logCache.set(key, { events: settled, through });
  return [...settled, ...fresh.filter((e) => e.blockNumber > through)];
}

// Block timestamps never change once a block is final, so each is fetched once.
const blockTimes = new Map();
export async function blockTime(provider, blockNumber) {
  const { chainId } = await provider.getNetwork();
  const key = `${chainId}:${blockNumber}`;
  if (!blockTimes.has(key)) blockTimes.set(key, provider.getBlock(blockNumber).then((b) => b.timestamp));
  try {
    return await blockTimes.get(key);
  } catch (e) {
    blockTimes.delete(key);
    throw e;
  }
}

// Multicall3 lives at the same address on Sepolia, mainnet and most other
// chains. It runs many read calls inside one eth_call, so a page of 200 reads
// costs one round trip instead of 200.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const multicallPresent = new WeakMap();
const MULTICALL_PAGE = 200;

function hasMulticall(provider) {
  if (!multicallPresent.has(provider)) {
    multicallPresent.set(
      provider,
      provider.getCode(MULTICALL3).then(
        (code) => code !== "0x",
        () => false
      )
    );
  }
  return multicallPresent.get(provider);
}

// Runs [contract, "method", ...args] reads and returns their results in order,
// shaped exactly as calling contract.method(...args) would return them. Uses
// Multicall3 where it exists (Sepolia); elsewhere (a local Hardhat node) it
// falls back to ordinary parallel calls. Fails as a whole if any read fails,
// like Promise.all.
export async function readMany(calls) {
  if (calls.length === 0) return [];
  const provider = calls[0][0].runner.provider;
  const direct = () => Promise.all(calls.map(([c, method, ...args]) => c[method](...args)));
  if (calls.length === 1 || !(await hasMulticall(provider))) return direct();

  const out = [];
  for (let i = 0; i < calls.length; i += MULTICALL_PAGE) {
    const page = calls.slice(i, i + MULTICALL_PAGE);
    const encoded = await Promise.all(
      page.map(async ([c, method, ...args]) => ({ target: await c.getAddress(), allowFailure: true, callData: c.interface.encodeFunctionData(method, args) }))
    );
    const data = await provider.call({ to: MULTICALL3, data: multicallAbi.encodeFunctionData("aggregate3", [encoded]) });
    const [results] = multicallAbi.decodeFunctionResult("aggregate3", data);
    results.forEach(([success, returnData], j) => {
      const [c, method] = page[j];
      if (!success) {
        // Re-run that one read directly, so the caller gets ethers' normal
        // error with the decoded revert reason.
        out.push(c[method](...page[j].slice(2)));
        return;
      }
      const decoded = c.interface.decodeFunctionResult(method, returnData);
      out.push(decoded.length === 1 ? decoded[0] : decoded);
    });
  }
  return Promise.all(out);
}
