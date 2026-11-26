import { useCallback, useEffect, useRef, useState } from "react";
import { isError } from "ethers";
import { explainError } from "../lib/errors.js";

// How long before the app tells the user a step is taking unusually long.
// Nothing is cancelled: a slow transaction can still confirm.
export const SLOW_WALLET_MS = 60_000;
export const SLOW_BLOCK_MS = 90_000;

// The lifecycle of one transaction, for the UI:
//   wallet → waiting for the user to sign
//   mining → sent, waiting for a block
//   done / error
// `slow` is set on wallet or mining when that step drags on.
//
// If the user speeds the transaction up in their wallet, the wallet sends a
// replacement with the same contents and a higher fee. ethers reports that as
// TRANSACTION_REPLACED; the replacement's receipt is the real result, so it
// counts as done. If they cancel it (or send something else with the same
// nonce), the action never happened, and that is reported as such.
export function useTx(onConfirmed) {
  const [state, setState] = useState({ status: "idle" });
  const timer = useRef(null);
  const runId = useRef(0);

  // Don't flag a stale step as slow after the component has gone.
  useEffect(() => () => clearTimeout(timer.current), []);

  const flagSlowAfter = (ms, id) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (runId.current === id) setState((s) => (s.status === "wallet" || s.status === "mining" ? { ...s, slow: true } : s));
    }, ms);
  };

  const run = useCallback(
    async (label, send) => {
      const id = ++runId.current;
      const mine = (next) => runId.current === id && setState(next);

      mine({ status: "wallet", label });
      flagSlowAfter(SLOW_WALLET_MS, id);
      try {
        const tx = await send();
        mine({ status: "mining", label, hash: tx.hash, chainId: tx.chainId });
        flagSlowAfter(SLOW_BLOCK_MS, id);

        let receipt;
        let hash = tx.hash;
        let spedUp = false;
        try {
          receipt = await tx.wait();
        } catch (e) {
          if (!isError(e, "TRANSACTION_REPLACED") || e.cancelled) throw e;
          receipt = e.receipt;
          hash = e.replacement?.hash ?? receipt?.hash ?? hash;
          spedUp = true;
          if (receipt?.status === 0) throw e;
        }

        clearTimeout(timer.current);
        mine({ status: "done", label, hash, chainId: tx.chainId, block: receipt.blockNumber, spedUp });
        if (runId.current === id) onConfirmed?.(receipt);
        return receipt;
      } catch (e) {
        clearTimeout(timer.current);
        mine({ status: "error", label, message: explainError(e) });
        return null;
      }
    },
    [onConfirmed]
  );

  // Clears the status line. Any transaction already sent still runs.
  const reset = useCallback(() => {
    runId.current++;
    clearTimeout(timer.current);
    setState({ status: "idle" });
  }, []);

  const busy = state.status === "wallet" || state.status === "mining";
  return { state, run, reset, busy };
}
