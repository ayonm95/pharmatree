export const PHARMA_TREE_ABI = [
  "function admin() view returns (address)",
  "function unitCounter() view returns (uint256)",
  "function isManufacturer(address) view returns (bool)",
  "function isHandler(address) view returns (bool)",
  "function isDispenser(address) view returns (bool)",
  "function isQA(address) view returns (bool)",
  "function addManufacturer(address _mfr)",
  "function addHandler(address _handler)",
  "function addDispenser(address _dispenser)",
  "function addQA(address _qa)",
  "function removeManufacturer(address _mfr)",
  "function removeHandler(address _handler)",
  "function removeDispenser(address _dispenser)",
  "function removeQA(address _qa)",
  "function recallRoot(uint256 _rootId)",
  "function unrecallRoot(uint256 _rootId)",
  "function recalledRoots(uint256) view returns (bool)",
  "function createRootUnit(uint8 _level, string _metadata, uint256 _quantity) returns (uint256)",
  "function createRootUnitWithSerial(uint8 _level, string _metadata, uint256 _quantity, string _serial, uint256 _expiry) returns (uint256)",
  "function createChildUnits(uint256 _parentId, uint8 _childLevel, string _metadata, uint256 _count)",
  "function createChildUnitsWithSerial(uint256 _parentId, uint8 _childLevel, string _metadata, uint256 _count, string _serial)",
  "function initiateTransfer(uint256 _id, address _receiver) returns (uint256)",
  "function initiatePartialTransfer(uint256 _id, address _receiver, uint256 _quantity) returns (uint256)",
  "function acceptTransfer(uint256 _id)",
  "function rejectTransfer(uint256 _id)",
  "function cancelTransfer(uint256 _id)",
  "function clearRejected(uint256 _id, bytes32 _evidenceHash)",
  "function markAsSold(uint256 _id)",
  "function sellQuantity(uint256 _id, uint256 _quantity) returns (uint256)",
  "function sellQuantityWithSerial(uint256 _id, uint256 _quantity, string _childSerial) returns (uint256)",
  "function verifySerial(uint256 _id, string _serial) view returns (bool)",
  "function getChildren(uint256 _parentId) view returns (uint256[])",
  "function getUnitDetails(uint256 _id) view returns (tuple(uint256 parentId, uint256 rootId, uint8 level, address manufacturer, address currentOwner, address pendingReceiver, uint8 status, uint256 quantity, string metadata, bytes32 serialHash, uint256 expiry))",

  "event UnitCreated(uint256 indexed id, uint256 indexed parentId, uint8 level, address indexed owner)",
  "event TransferInitiated(uint256 indexed id, address indexed from, address indexed to)",
  "event TransferCompleted(uint256 indexed id, address indexed from, address indexed to)",
  "event TransferRejected(uint256 indexed id, address indexed from, address indexed rejectedBy)",
  "event TransferCancelled(uint256 indexed id, address indexed cancelledBy)",
  "event RejectedCleared(uint256 indexed id, address indexed clearedBy, bytes32 evidenceHash)",
  "event UnitSold(uint256 indexed id, address indexed soldBy)",
  "event RootRecalled(uint256 indexed rootId, address indexed recalledBy)",
  "event RootUnrecalled(uint256 indexed rootId, address indexed unrecalledBy)"
] as const;
export const PHARMA_TREE_CONTRACT =
  process.env.NEXT_PUBLIC_PHARMA_TREE_CONTRACT || "0xbD245c7f7C8bF4A8Ec016e8C370D3e6931BeAd72";
export const PHARMA_TREE_CHAIN_ID = BigInt(process.env.NEXT_PUBLIC_CHAIN_ID || "11155111");

export const PHARMA_TREE_FORWARDER_ABI = [
  "function nonces(address owner) view returns (uint256)",
  "function verify(tuple(address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) view returns (bool)",
  "function execute(tuple(address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) payable",
  "function executeBatch(tuple(address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature)[] requests, address payable refundReceiver) payable",
] as const;

export const PHARMA_TREE_FORWARDER_CONTRACT =
  process.env.NEXT_PUBLIC_TRUSTED_FORWARDER ||
  process.env.TRUSTED_FORWARDER ||
  "0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c";

export const UNIT_LEVELS = [
  "Container",
  "Shipment",
  "Batch",
  "Box",
  "IndividualItem",
] as const;

export const UNIT_STATUS = ["Active", "PendingTransfer", "Sold", "Rejected"] as const;

export function unitLevelToName(level: number) {
  return UNIT_LEVELS[level] ?? "Unknown";
}

export function unitStatusToName(status: number) {
  return UNIT_STATUS[status] ?? "Unknown";
}
