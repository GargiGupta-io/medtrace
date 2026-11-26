import { useEffect, useState } from "react";
import { useTx } from "../hooks/useTx.js";
import { units } from "../lib/format.js";
import { Button, Field, Modal, TxStatus, inputClass } from "./ui.jsx";
import { isQuantity, quantityProblem } from "../lib/validate.js";

// What happens to unsafe stock: a temporary hold while something is checked,
// sending units back to the manufacturer, and writing off dead stock.
// All of these keep working while the network is paused.

const closeSoon = (onDone, onClose) => () => {
  onDone();
  setTimeout(onClose, 900);
};

// Places a hold on a batch, or lifts one. Open to the batch's manufacturer and
// to regulators; a hold a regulator placed can only be lifted by a regulator.
export function HoldModal({ batch, inventory, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const tx = useTx(closeSoon(onDone, onClose));

  if (batch.quarantined) {
    return (
      <Modal title={`Lift the hold · batch #${batch.id} · ${batch.drugName}`} onClose={onClose}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            The batch goes back to normal: it can be shipped, accepted and dispensed again. Only lift the hold once the problem is ruled out. If it's confirmed, recall the batch instead.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={tx.busy} onClick={() => tx.run("Lift hold", () => inventory.releaseQuarantine(batch.id))}>
              {tx.busy ? "Lifting…" : "Lift the hold"}
            </Button>
          </div>
          <TxStatus state={tx.state} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Put batch #${batch.id} on hold · ${batch.drugName}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          tx.run("Place hold", () => inventory.quarantineBatch(batch.id, reason.trim()));
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600">
          Stops every shipment, acceptance and dispense of this batch while you investigate. Unlike a recall, it can be lifted if the batch turns out fine.
        </p>
        <Field label="Reason" hint="Every holder, and anyone who scans the batch, sees this.">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer report of discoloured tablets" required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={tx.busy || !reason.trim()}>
            {tx.busy ? "Placing hold…" : "Put on hold"}
          </Button>
        </div>
        <TxStatus state={tx.state} />
      </form>
    </Modal>
  );
}

// A quantity field that refuses anything the holder doesn't have, so the
// wallet is never asked to sign a transaction that's bound to fail.
function useQuantity(max) {
  const [value, setValue] = useState("");
  const problem = quantityProblem(value, max);
  return { value, setValue, ok: isQuantity(value, max), hint: problem ? <span className="text-rose-700">{problem}</span> : `You hold ${units(max)} units.` };
}

// Sends recalled, on-hold or expired units straight back to the manufacturer.
// No acceptance step: the manufacturer can't refuse its own unsafe stock.
export function ReturnModal({ batch, supply, nameOf, onClose, onDone }) {
  const qty = useQuantity(batch.stock);
  const [reason, setReason] = useState("");
  const tx = useTx(closeSoon(onDone, onClose));
  return (
    <Modal title={`Send back · batch #${batch.id} · ${batch.drugName}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          tx.run("Send back", () => supply.returnToManufacturer(batch.id, BigInt(qty.value), reason.trim()));
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600">The units go straight back to {nameOf(batch.manufacturer)} and leave your stock now. The return is recorded in the custody trail.</p>
        <Field label="Units to send back" hint={qty.hint}>
          <input type="number" min="1" max={batch.stock.toString()} step="1" className={inputClass} value={qty.value} onChange={(e) => qty.setValue(e.target.value)} required />
        </Field>
        <Field label="Reason">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Returned under recall notice" required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => qty.setValue(batch.stock.toString())}>
            All of it
          </Button>
          <Button type="submit" disabled={tx.busy || !qty.ok || !reason.trim()}>
            {tx.busy ? "Sending…" : "Send back"}
          </Button>
        </div>
        <TxStatus state={tx.state} />
      </form>
    </Modal>
  );
}

// Records that units of a recalled or expired batch were destroyed.
export function WriteOffModal({ batch, inventory, onClose, onDone }) {
  const qty = useQuantity(batch.stock);
  const [reason, setReason] = useState("");
  const tx = useTx(closeSoon(onDone, onClose));
  return (
    <Modal title={`Write off · batch #${batch.id} · ${batch.drugName}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          tx.run("Write off", () => inventory.destroyStock(batch.id, BigInt(qty.value), reason.trim()));
        }}
        className="space-y-4"
      >
        <p className="text-sm text-slate-600">
          For units you have physically destroyed. They leave your stock for good and count towards the recall being closed. This <span className="font-medium">can't be undone.</span>
        </p>
        <Field label="Units destroyed" hint={qty.hint}>
          <input type="number" min="1" max={batch.stock.toString()} step="1" className={inputClass} value={qty.value} onChange={(e) => qty.setValue(e.target.value)} required />
        </Field>
        <Field label="How they were destroyed">
          <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Incinerated by licensed waste contractor, cert. 4471" required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => qty.setValue(batch.stock.toString())}>
            All of it
          </Button>
          <Button type="submit" variant="danger" disabled={tx.busy || !qty.ok || !reason.trim()}>
            {tx.busy ? "Writing off…" : "Write off"}
          </Button>
        </div>
        <TxStatus state={tx.state} />
      </form>
    </Modal>
  );
}

// Where every unit of a batch has gone: dispensed, destroyed, or still out
// there. Read from the chain each time the batch's holdings change.
export function RecallProgress({ batchId, inventory, refreshKey }) {
  const [p, setP] = useState(null);
  useEffect(() => {
    let live = true;
    inventory
      .getRecallProgress(batchId)
      .then((r) => live && setP(r))
      .catch(() => live && setP(undefined));
    return () => {
      live = false;
    };
  }, [batchId, inventory, refreshKey]);

  if (p === undefined) return <p className="text-xs text-slate-500">Progress isn't available on this deployment.</p>;
  if (!p) return <p className="text-xs text-slate-500">Loading progress…</p>;

  const pct = (v) => (p.produced === 0n ? 0 : Number((v * 1000n) / p.produced) / 10);
  const closed = p.outstanding === 0n;
  return (
    <div className="space-y-1.5">
      <div className="flex h-2 overflow-hidden rounded-full bg-rose-100" role="img" aria-label={`${pct(p.dispensed + p.destroyed)}% of units accounted for`}>
        <div className="bg-slate-400" style={{ width: `${pct(p.dispensed)}%` }} />
        <div className="bg-emerald-600" style={{ width: `${pct(p.destroyed)}%` }} />
      </div>
      <p className="text-xs text-slate-600">
        {closed ? (
          <span className="font-medium text-emerald-700">Every unit is accounted for. </span>
        ) : (
          <span className="font-medium text-rose-700">{units(p.outstanding)} units still out there. </span>
        )}
        {units(p.destroyed)} destroyed · {units(p.dispensed)} already dispensed · {units(p.produced)} made
      </p>
    </div>
  );
}
