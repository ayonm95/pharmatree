export function formatAddress(addr?: string, len = 4): string {
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return "—";
  if (addr.length <= len * 2 + 2) return addr;
  return `${addr.slice(0, len + 2)}…${addr.slice(-len)}`;
}

export function formatDate(timestamp?: number): string {
  if (!timestamp) return "Recorded on-chain";
  return new Date(timestamp * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatDateOnly(timestamp?: number): string {
  if (!timestamp) return "Not recorded";
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    dateStyle: "medium",
  });
}

export function formatQuantity(qty?: string | number): string {
  if (qty === undefined || qty === null || qty === "") return "0";
  const num = Number(qty);
  return isNaN(num) ? String(qty) : num.toLocaleString();
}
