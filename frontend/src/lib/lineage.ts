import { UnitRecord } from "@/types/pharmatree";

export function getPartitionBranchStats(partitionUnit: UnitRecord, allUnits: UnitRecord[], account: string) {
  const branchUnits: UnitRecord[] = [partitionUnit];
  const queue = [partitionUnit.id];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const kids = allUnits.filter((u) => u.parentId === currentId && u.id !== currentId);
    for (const kid of kids) {
      branchUnits.push(kid);
      queue.push(kid.id);
    }
  }

  const isDirectlyRejected = partitionUnit.status === 3;
  const isDirectlyPending = partitionUnit.status === 1;
  const isDirectlySold = partitionUnit.status === 2;
  const soldUnits = branchUnits.filter((u) => u.status === 2);
  const soldQty = soldUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
  const activeUnits = branchUnits.filter((u) => u.status === 0);
  const activeQty = activeUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
  const pendingUnits = branchUnits.filter((u) => u.status === 1);
  const pendingQty = pendingUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
  const rejectedUnits = branchUnits.filter((u) => u.status === 3);
  const rejectedQty = rejectedUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
  const totalBranchQty = branchUnits.reduce((sum, u) => sum + Number(u.quantity || 0), 0);
  const partitionQty = Number(partitionUnit.quantity || 0);

  let statusText = "Transferred";
  let variant: "success" | "warning" | "danger" | "info" = "info";
  let displayQty = partitionQty;

  const lowerAccount = account.toLowerCase();

  if (isDirectlyRejected || (rejectedQty === totalBranchQty && totalBranchQty > 0)) {
    statusText = "Rejected";
    variant = "danger";
    displayQty = partitionQty;
  } else if (isDirectlyPending || (pendingQty === totalBranchQty && totalBranchQty > 0)) {
    statusText = "Pending transfer";
    variant = "warning";
    displayQty = partitionQty;
  } else if (isDirectlySold || (soldQty === totalBranchQty && totalBranchQty > 0)) {
    statusText = "Sold";
    variant = "info";
    displayQty = totalBranchQty;
  } else if (soldQty > 0) {
    statusText = "Partially sold";
    variant = "warning";
    displayQty = activeQty;
  } else if (partitionUnit.currentOwner.toLowerCase() === lowerAccount && partitionUnit.status === 0) {
    statusText = "In stock";
    variant = "success";
    displayQty = partitionQty;
  } else {
    statusText = "Transferred";
    variant = "info";
    displayQty = activeQty > 0 ? activeQty : partitionQty;
  }

  return {
    soldQty,
    activeQty,
    pendingQty,
    rejectedQty,
    totalBranchQty,
    displayQty,
    statusText,
    variant,
  };
}
