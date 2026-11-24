import { useCallback, useEffect, useState } from "react";
import { ROLES } from "../lib/roles.js";

// Who the connected address is, according to DrugRegistry.
export function useProfile(contracts, address) {
  const [profile, setProfile] = useState({ loading: true });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!contracts || !address) return;
    let live = true;
    (async () => {
      setProfile({ loading: true });
      try {
        const [p, isAdmin, adminInvited] = await Promise.all([
          contracts.registry.getParticipant(address),
          contracts.registry.hasRole(ROLES.ADMIN, address),
          // Older deployments have no invitations; treat that as "not invited".
          contracts.registry.isAdminProposed(address).catch(() => false),
        ]);
        if (live) setProfile({ loading: false, name: p.name, licenceId: p.licenceId, role: p.role, active: p.active, isAdmin, adminInvited, reload });
      } catch (e) {
        if (live) setProfile({ loading: false, error: "Couldn't read the registry. Are the contracts deployed on this network?" });
      }
    })();
    return () => { live = false; };
  }, [contracts, address, version, reload]);

  return profile;
}
