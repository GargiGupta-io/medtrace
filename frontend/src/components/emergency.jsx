import { useCallback, useEffect, useState } from "react";
import { isAddress } from "ethers";
import { useTx } from "../hooks/useTx.js";
import { queryAll } from "../lib/contracts.js";
import { Button, Card, Field, TxStatus, inputClass } from "./ui.jsx";

// Whether the network's emergency stop is on, and the reason given for it.
// Re-checked every 20 seconds so every open dashboard notices a pause.
export function usePauseState(wallet) {
  const registry = wallet.contracts?.registry;
  const from = wallet.deployment?.deployedBlock ?? 0;
  const [state, setState] = useState({ paused: false });

  const reload = useCallback(async () => {
    if (!registry) return;
    try {
      const paused = await registry.paused();
      if (!paused) return setState({ paused: false });
      const events = await queryAll(registry, registry.filters.SystemPaused(), from);
      const last = events.at(-1);
      setState({ paused: true, reason: last?.args.reason, by: last?.args.by });
    } catch {
      /* an older deployment without pause support: treat as running */
    }
  }, [registry, from]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 20000);
    return () => clearInterval(id);
  }, [reload]);

  return { ...state, reload };
}

export function PauseBanner({ pause }) {
  if (!pause.paused) return null;
  return (
    <div className="border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 sm:px-6" role="alert">
      <p className="mx-auto max-w-6xl">
        <span className="font-semibold">The network is paused.</span> {pause.reason ? `"${pause.reason}". ` : ""}
        New batches, shipments, acceptances and dispensing are stopped. Recalls, holds, returns and write-offs still work.
      </p>
    </div>
  );
}

// Admins and regulators can pause; only admins can resume.
export function PauseControl({ registry, pause, canResume }) {
  const [reason, setReason] = useState("");
  const tx = useTx(() => {
    setReason("");
    pause.reload();
  });

  if (pause.paused) {
    return (
      <Card title="Emergency stop" subtitle={canResume ? "The network is paused. Resume it once the problem is dealt with." : "The network is paused. Only an admin can resume it."}>
        {canResume && (
          <Button className="w-full" disabled={tx.busy} onClick={() => tx.run("Resume network", () => registry.unpause())}>
            {tx.busy ? "Resuming…" : "Resume the network"}
          </Button>
        )}
        <TxStatus state={tx.state} />
      </Card>
    );
  }

  return (
    <Card title="Emergency stop" subtitle="Freezes new batches, shipments and dispensing everywhere at once. Safety actions keep working.">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          tx.run("Pause network", () => registry.pause(reason.trim()));
        }}
      >
        <Field label="Reason" hint="Everyone on the network sees this.">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Suspected key compromise at a distributor" required />
        </Field>
        <Button type="submit" variant="danger" className="w-full" disabled={tx.busy || !reason.trim()}>
          {tx.busy ? "Pausing…" : "Pause the network"}
        </Button>
        <TxStatus state={tx.state} />
      </form>
    </Card>
  );
}

// A new admin is invited here and must accept from their own wallet, so the
// role can never land on a mistyped address.
export function InviteAdmin({ registry }) {
  const [address, setAddress] = useState("");
  const tx = useTx(() => setAddress(""));
  const trimmed = address.trim();
  const valid = isAddress(trimmed);

  return (
    <Card title="Invite another admin" subtitle="Nothing changes until they accept from their own wallet.">
      <div className="space-y-4">
        <Field label="Wallet address" hint={trimmed && !valid ? "That isn't a valid Ethereum address." : "They'll see an invitation when they connect."}>
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" />
        </Field>
        <div className="flex gap-2">
          <Button className="flex-1" disabled={tx.busy || !valid} onClick={() => tx.run("Invite admin", () => registry.proposeAdmin(trimmed))}>
            Invite
          </Button>
          <Button variant="secondary" className="flex-1" disabled={tx.busy || !valid} onClick={() => tx.run("Withdraw invitation", () => registry.cancelAdminProposal(trimmed))}>
            Withdraw
          </Button>
        </div>
        <TxStatus state={tx.state} />
      </div>
    </Card>
  );
}

export function AcceptAdminInvite({ registry, onAccepted }) {
  const tx = useTx(onAccepted);
  return (
    <div className="mx-auto max-w-6xl px-4 pt-6 sm:px-6">
      <Card title="You've been invited to be an admin" subtitle="Accepting lets this wallet onboard, re-role and revoke participants, and pause or resume the network.">
        <Button disabled={tx.busy} onClick={() => tx.run("Accept admin role", () => registry.acceptAdmin())}>
          {tx.busy ? "Accepting…" : "Accept invitation"}
        </Button>
        <TxStatus state={tx.state} />
      </Card>
    </div>
  );
}
