import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserProvider, JsonRpcProvider } from "ethers";
import { deployments, LOCAL_CHAIN_ID, LOCAL_RPC } from "../lib/config.js";
import { getContracts } from "../lib/contracts.js";

const DISCONNECTED = { status: "disconnected", mode: null, provider: null, signer: null, address: null, chainId: null };

// Two ways in:
//  - MetaMask: the real thing, used on Sepolia and for the demo.
//  - Local test account: only on a local Hardhat chain. Hardhat's node holds
//    the keys of its 20 test accounts, so the app can act as any of them with
//    no wallet. For development and quick demos only.
export function useWallet() {
  const [state, setState] = useState(DISCONNECTED);
  const [error, setError] = useState(null);
  const listening = useRef(false);
  // Account and network events can arrive in bursts; only the newest wins,
  // so a slow lookup for an old account can't overwrite the current one.
  const generation = useRef(0);
  // The live provider, so a replaced one can be shut down (it polls the chain).
  const current = useRef(null);
  const adopt = useCallback((next) => {
    if (current.current && current.current.provider !== next.provider) current.current.provider?.destroy();
    current.current = next.provider ? next : null;
    setState(next);
  }, []);

  // Builds the connection from accounts MetaMask has already shared. With
  // ask=true it may open the MetaMask prompt; without, it never does.
  const fromMetaMask = useCallback(async (ask) => {
    const gen = ++generation.current;
    const provider = new BrowserProvider(window.ethereum);
    const accounts = await provider.send(ask ? "eth_requestAccounts" : "eth_accounts", []);
    if (gen !== generation.current) return;
    if (!accounts.length) {
      // Locked, or the site was disconnected from inside MetaMask.
      provider.destroy();
      adopt(DISCONNECTED);
      setError(ask ? "MetaMask didn't share an account." : "MetaMask disconnected or locked. Connect again to continue.");
      return;
    }
    const signer = await provider.getSigner(accounts[0]);
    const [address, { chainId }] = await Promise.all([signer.getAddress(), provider.getNetwork()]);
    if (gen !== generation.current) return provider.destroy();
    // The old provider was built for the old account or network; ethers
    // refuses to keep using it after a network switch, so adopt retires it.
    adopt({ status: "ready", mode: "metamask", provider, signer, address, chainId: Number(chainId) });
  }, [adopt]);

  const connectMetaMask = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("MetaMask isn't installed in this browser.");
      return;
    }
    try {
      setState((s) => ({ ...s, status: "connecting" }));
      await fromMetaMask(true);
    } catch (e) {
      adopt(DISCONNECTED);
      setError(e?.code === "ACTION_REJECTED" || e?.code === 4001 ? "Connection request was cancelled." : e?.shortMessage || e?.message);
    }
  }, [fromMetaMask, adopt]);

  const connectLocal = useCallback(async (index) => {
    setError(null);
    generation.current++;
    try {
      const provider = new JsonRpcProvider(LOCAL_RPC, LOCAL_CHAIN_ID, { staticNetwork: true });
      provider.pollingInterval = 1000;
      const signer = await provider.getSigner(index);
      const address = await signer.getAddress();
      adopt({ status: "ready", mode: "local", provider, signer, address, chainId: LOCAL_CHAIN_ID });
    } catch (e) {
      setError(`Can't reach the local chain at ${LOCAL_RPC}. Is "npm run node" running?`);
    }
  }, [adopt]);

  // Forgets the connection in the app, stops polling the chain, and asks
  // MetaMask to drop this site's permission, so the next connect asks again
  // and can pick a different account. Older MetaMask versions can't revoke;
  // the app disconnects anyway.
  const disconnect = useCallback(() => {
    generation.current++;
    if (current.current?.mode === "metamask") {
      window.ethereum?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
    }
    adopt(DISCONNECTED);
    setError(null);
  }, [adopt]);

  // MetaMask: follow account and network switches made in the extension,
  // without opening a new prompt.
  useEffect(() => {
    if (state.mode !== "metamask" || !window.ethereum || listening.current) return;
    listening.current = true;
    const onChange = () =>
      fromMetaMask(false).catch((e) => {
        adopt(DISCONNECTED);
        setError(e?.shortMessage || e?.message);
      });
    window.ethereum.on("accountsChanged", onChange);
    window.ethereum.on("chainChanged", onChange);
    return () => {
      window.ethereum.removeListener("accountsChanged", onChange);
      window.ethereum.removeListener("chainChanged", onChange);
      listening.current = false;
    };
  }, [state.mode, fromMetaMask, adopt]);

  const switchChain = useCallback(async (chainId) => {
    const hex = `0x${chainId.toString(16)}`;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e?.code === 4902 && chainId === LOCAL_CHAIN_ID) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hex, chainName: "Hardhat Local", rpcUrls: [LOCAL_RPC], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
        });
      } else {
        setError(e?.message);
      }
    }
  }, []);

  const deployment = state.chainId ? deployments[state.chainId] : null;
  const contracts = useMemo(() => (deployment && state.signer ? getContracts(deployment, state.signer) : null), [deployment, state.signer]);

  return { ...state, error, deployment, contracts, connectMetaMask, connectLocal, disconnect, switchChain };
}
