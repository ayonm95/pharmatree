import { ethers } from "hardhat";

export enum UnitLevel {
  Container = 0,
  Shipment = 1,
  Batch = 2,
  Box = 3,
  IndividualItem = 4,
}

export enum Status {
  Active = 0,
  PendingTransfer = 1,
  Sold = 2,
  Rejected = 3,
}

export async function deployPharmaTreeFixture() {
  const [admin, manufacturer, distributor1, distributor2, pharmacy, unauthorized] =
    await ethers.getSigners();

  const PharmaTreeFactory = await ethers.getContractFactory("PharmaTree", admin);
  const pharmaTree = await PharmaTreeFactory.deploy();
  await pharmaTree.waitForDeployment();

  // Register roles
  await pharmaTree.connect(admin).addManufacturer(manufacturer.address);
  await pharmaTree.connect(admin).addHandler(distributor1.address);
  await pharmaTree.connect(admin).addHandler(distributor2.address);
  await pharmaTree.connect(admin).addHandler(pharmacy.address);

  return {
    pharmaTree,
    admin,
    manufacturer,
    distributor1,
    distributor2,
    distributor: distributor1, // alias for backwards compatibility
    pharmacy,
    unauthorized,
  };
}

export async function deployPharmaTreeWithUnitsFixture() {
  const base = await deployPharmaTreeFixture();
  const { pharmaTree, manufacturer, distributor1, pharmacy } = base;

  // 1. activeUnit (ID 1): Batch of 100 Ibuprofen owned by manufacturer
  await pharmaTree.connect(manufacturer).createRootUnit(
    UnitLevel.Batch,
    "Ibuprofen 400mg, 100 tablets",
    100
  );

  // 2. distributorUnit (ID 2): Transferred to and accepted by distributor1
  await pharmaTree.connect(manufacturer).createRootUnit(
    UnitLevel.Box,
    "Amoxicillin 500mg, 50 capsules",
    50
  );
  await pharmaTree.connect(manufacturer).initiateTransfer(2, distributor1.address);
  await pharmaTree.connect(distributor1).acceptTransfer(2);

  // 3. soldUnit (ID 3): Created, transferred to pharmacy, and sold
  await pharmaTree.connect(manufacturer).createRootUnit(
    UnitLevel.IndividualItem,
    "Aspirin 81mg, 1 pack",
    1
  );
  await pharmaTree.connect(manufacturer).initiateTransfer(3, pharmacy.address);
  await pharmaTree.connect(pharmacy).acceptTransfer(3);
  await pharmaTree.connect(pharmacy).markAsSold(3);

  // 4. rejectedUnit (ID 4): Created, transfer initiated to distributor1, rejected by distributor1
  await pharmaTree.connect(manufacturer).createRootUnit(
    UnitLevel.Box,
    "Damaged Box",
    20
  );
  await pharmaTree.connect(manufacturer).initiateTransfer(4, distributor1.address);
  await pharmaTree.connect(distributor1).rejectTransfer(4);

  // 5. pendingTransferUnit (ID 5): Created, transfer initiated to pharmacy, still pending
  await pharmaTree.connect(manufacturer).createRootUnit(
    UnitLevel.IndividualItem,
    "Pending Cold Chain Box",
    10
  );
  await pharmaTree.connect(manufacturer).initiateTransfer(5, pharmacy.address);

  return {
    ...base,
    activeUnitId: 1,
    distributorUnitId: 2,
    soldUnitId: 3,
    rejectedUnitId: 4,
    pendingTransferUnitId: 5,
  };
}
