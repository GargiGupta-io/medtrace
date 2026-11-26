import { useMemo, useState } from "react";
import { useNetworkLedger } from "../hooks/useLedger.js";
import { ROLES, roleLabel } from "../lib/roles.js";
import { Badge, Button, Card, Stat } from "../components/ui.jsx";
import { ChangeRoleModal, RegisterParticipant, ReinstateModal, RevokeModal } from "../components/admin.jsx";
import { InviteAdmin, PauseControl } from "../components/emergency.jsx";

// The admin decides who may take part, and holds the network's emergency
// stop. Everything else (batches, transfers, recalls) belongs to the participants.
export default function AdminDashboard({ wallet, pause }) {
  const ledger = useNetworkLedger(wallet);
  const [changing, setChanging] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [reinstating, setReinstating] = useState(null);
  const registry = wallet.contracts.registry;

  const people = useMemo(
    () => Object.values(ledger.participants).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    [ledger.participants]
  );
  const count = (role) => people.filter((p) => p.active && p.role === role).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <div>
        <p className="text-sm font-medium text-teal-700">Admin</p>
        <h1 className="text-2xl font-semibold tracking-tight">Participant registry</h1>
        <p className="text-sm text-slate-500">Onboard, re-role and revoke the organisations on the network.</p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Manufacturers" value={count(ROLES.MANUFACTURER)} />
        <Stat label="Distributors" value={count(ROLES.DISTRIBUTOR)} />
        <Stat label="Pharmacies" value={count(ROLES.PHARMACY)} />
        <Stat label="Regulators" value={count(ROLES.REGULATOR)} />
      </div>

      {ledger.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-800">Couldn't load the registry: {ledger.error}</p>}

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <Card title="Participants" subtitle={`${people.length} registered. Live from the chain.`} className="lg:col-span-2">
          {ledger.loading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : people.length === 0 ? (
            <p className="text-sm text-slate-500">Nobody yet. Onboard the first participant.</p>
          ) : (
            <div className="-m-5 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-5 py-3 font-medium">Organisation</th>
                    <th className="px-3 py-3 font-medium">Role</th>
                    <th className="px-5 py-3 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {people.map((p) => (
                    <tr key={p.address} className="align-top">
                      <td className="px-5 py-3">
                        <p className={`font-medium ${p.active ? "" : "text-slate-400 line-through"}`}>{p.name}</p>
                        <p className="text-xs text-slate-500">
                          {p.licenceId} · <span className="font-mono">{p.address}</span>
                        </p>
                      </td>
                      <td className="px-3 py-3">{p.active ? <Badge tone="teal">{roleLabel(p.role)}</Badge> : <Badge tone="slate">Revoked</Badge>}</td>
                      <td className="px-5 py-3">
                        <div className="flex justify-end gap-1.5">
                          {p.active ? (
                            <>
                              <Button size="sm" variant="secondary" className="whitespace-nowrap" onClick={() => setChanging(p)}>
                                Change role
                              </Button>
                              <Button size="sm" variant="danger" onClick={() => setRevoking(p)}>
                                Revoke
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="secondary" onClick={() => setReinstating(p)}>
                              Reinstate
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="space-y-6">
          <RegisterParticipant registry={registry} onDone={ledger.reload} />
          <PauseControl registry={registry} pause={pause} canResume />
          <InviteAdmin registry={registry} />
        </div>
      </div>

      {changing && <ChangeRoleModal participant={changing} registry={registry} onClose={() => setChanging(null)} onDone={ledger.reload} />}
      {reinstating && <ReinstateModal participant={reinstating} registry={registry} onClose={() => setReinstating(null)} onDone={ledger.reload} />}
      {revoking && <RevokeModal participant={revoking} registry={registry} onClose={() => setRevoking(null)} onDone={ledger.reload} />}
    </div>
  );
}
