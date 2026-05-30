import { createContext, useContext, type ReactNode } from "react";

interface BalanceMask {
  hidden: boolean;
  toggle: () => void;
}

const BalanceCtx = createContext<BalanceMask>({ hidden: false, toggle: () => {} });

export function BalanceProvider({
  value,
  children,
}: {
  value: BalanceMask;
  children: ReactNode;
}) {
  return <BalanceCtx.Provider value={value}>{children}</BalanceCtx.Provider>;
}

export function useBalanceMask(): BalanceMask {
  return useContext(BalanceCtx);
}

/** Masks its children with dots when hide-balance is on. */
export function Masked({
  children,
  dots = "••••••",
}: {
  children: ReactNode;
  dots?: string;
}) {
  const { hidden } = useBalanceMask();
  return hidden ? <span style={{ letterSpacing: ".06em" }}>{dots}</span> : <>{children}</>;
}
