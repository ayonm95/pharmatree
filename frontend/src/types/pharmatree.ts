export type UnitRecord = {
  id: string;
  displayId: string;
  parentId: string;
  rootId: string;
  level: number;
  status: number;
  manufacturer: string;
  currentOwner: string;
  pendingReceiver: string;
  metadata: string;
  quantity: string;
  ownerLabel: string;
  createdAt?: number;
  initiatedAt?: number;
  acceptedAt?: number;
  rejectedAt?: number;
  soldAt?: number;
  rejectedBy?: string;
  rejectedFrom?: string;
  initiatedTo?: string;
  initiatedFrom?: string;
  acceptedTo?: string;
  acceptedFrom?: string;
};

export type HistoryEntry = {
  id: string;
  type: string;
  from?: string;
  to?: string;
  rejectedBy?: string;
  txHash: string;
  blockNumber: number;
  timestamp?: number;
  quantity?: string;
};

export type UnitActivity = {
  createdAt?: number;
  initiatedAt?: number;
  acceptedAt?: number;
  rejectedAt?: number;
  soldAt?: number;
  rejectedBy?: string;
  rejectedFrom?: string;
  initiatedTo?: string;
  initiatedFrom?: string;
  acceptedTo?: string;
  acceptedFrom?: string;
};

export type ViewMode = "overview" | "transfers" | "inventory" | "create" | "admin";
