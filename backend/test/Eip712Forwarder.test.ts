import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { UnitLevel, Status } from "./fixtures/pharmaTreeFixture";

describe("EIP-712 Meta-Transactions & ERC-2771 Forwarder (Phase 5 & Relayer Decoupling)", function () {
  async function deployWithForwarderFixture() {
    const [admin, manufacturer, pharmacy, relayer, attacker] = await ethers.getSigners();

    // 1. Deploy PharmaTreeForwarder
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", admin);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();

    // 2. Deploy PharmaTree with trustedForwarder
    const PharmaTreeFactory = await ethers.getContractFactory("PharmaTree", admin);
    const pharmaTree = await PharmaTreeFactory.deploy(forwarderAddress);
    await pharmaTree.waitForDeployment();
    const pharmaTreeAddress = await pharmaTree.getAddress();

    // 3. Setup roles: manufacturer and pharmacy (handler)
    await pharmaTree.connect(admin).addManufacturer(manufacturer.address);
    await pharmaTree.connect(admin).addHandler(pharmacy.address);

    // CRITICAL SECURITY INVARIANT: Relayer has ZERO roles in PharmaTree
    // Verify relayer is completely unprivileged
    expect(await pharmaTree.hasRole(await pharmaTree.DEFAULT_ADMIN_ROLE(), relayer.address)).to.be.false;
    expect(await pharmaTree.hasRole(await pharmaTree.MANUFACTURER_ROLE(), relayer.address)).to.be.false;
    expect(await pharmaTree.hasRole(await pharmaTree.HANDLER_ROLE(), relayer.address)).to.be.false;

    // 4. Create an item and transfer it to the pharmacy
    await pharmaTree.connect(manufacturer).createRootUnit(
      UnitLevel.IndividualItem,
      "Paracetamol 500mg, 10 tablets",
      10
    );
    const unitId = 1;
    await pharmaTree.connect(manufacturer).initiateTransfer(unitId, pharmacy.address);
    await pharmaTree.connect(pharmacy).acceptTransfer(unitId);

    return {
      pharmaTree,
      pharmaTreeAddress,
      forwarder,
      forwarderAddress,
      admin,
      manufacturer,
      pharmacy,
      relayer,
      attacker,
      unitId,
    };
  }

  it("Should record trusted forwarder address accurately", async function () {
    const { pharmaTree, forwarderAddress } = await loadFixture(deployWithForwarderFixture);
    expect(await pharmaTree.trustedForwarder()).to.equal(forwarderAddress);
    expect(await pharmaTree.isTrustedForwarder(forwarderAddress)).to.be.true;
  });

  it("Should reject direct sale attempt from an unprivileged relayer without signed authorization", async function () {
    const { pharmaTree, relayer, unitId } = await loadFixture(deployWithForwarderFixture);
    // Relayer tries to call sellQuantity directly
    await expect(
      pharmaTree.connect(relayer).sellQuantity(unitId, 1)
    ).to.be.revertedWith("Not the current owner");
  });

  it("Should reject direct admin action attempt from an unprivileged relayer", async function () {
    const { pharmaTree, relayer, attacker } = await loadFixture(deployWithForwarderFixture);
    await expect(
      pharmaTree.connect(relayer).addManufacturer(attacker.address)
    ).to.be.revertedWith("Not admin");
  });

  it("Should allow direct calls from legitimate owner when not using forwarder", async function () {
    const { pharmaTree, pharmacy, unitId } = await loadFixture(deployWithForwarderFixture);
    // Direct call from owner still works (fallback to msg.sender)
    await expect(pharmaTree.connect(pharmacy).sellQuantity(unitId, 2)).to.emit(
      pharmaTree,
      "UnitSold"
    );
  });

  it("Should execute a valid EIP-712 signed meta-transaction relayed by an unprivileged relayer", async function () {
    const {
      pharmaTree,
      pharmaTreeAddress,
      forwarder,
      forwarderAddress,
      pharmacy,
      relayer,
      unitId,
    } = await loadFixture(deployWithForwarderFixture);

    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId;

    const domain = {
      name: "PharmaTreeForwarder",
      version: "1",
      chainId: chainId,
      verifyingContract: forwarderAddress,
    };

    const types = {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    };

    // Encoded calldata for markAsSold(unitId)
    const calldata = pharmaTree.interface.encodeFunctionData("markAsSold", [unitId]);
    const nonce = await forwarder.nonces(pharmacy.address);
    const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour validity

    const message = {
      from: pharmacy.address,
      to: pharmaTreeAddress,
      value: 0,
      gas: 500000,
      nonce: nonce,
      deadline: deadline,
      data: calldata,
    };

    // Pharmacy signs the EIP-712 typed data
    const signature = await pharmacy.signTypedData(domain, types, message);

    const forwardRequest = {
      from: pharmacy.address,
      to: pharmaTreeAddress,
      value: 0,
      gas: 500000,
      deadline: deadline,
      data: calldata,
      signature: signature,
    };

    // Verify forwarder validates request
    expect(await forwarder.verify(forwardRequest)).to.be.true;

    // Relayer submits the request paying the gas fee
    const tx = await forwarder.connect(relayer).execute(forwardRequest);
    await tx.wait();

    // Verify on-chain state
    const unit = await pharmaTree.getUnitDetails(unitId);
    expect(unit.status).to.equal(Status.Sold);

    // Verify relayer still holds ZERO roles
    expect(await pharmaTree.hasRole(await pharmaTree.DEFAULT_ADMIN_ROLE(), relayer.address)).to.be.false;
  });

  it("Should revert if forward request signature is forged or signed by unauthorized party", async function () {
    const {
      pharmaTree,
      pharmaTreeAddress,
      forwarder,
      forwarderAddress,
      pharmacy,
      relayer,
      attacker,
      unitId,
    } = await loadFixture(deployWithForwarderFixture);

    const network = await ethers.provider.getNetwork();
    const domain = {
      name: "PharmaTreeForwarder",
      version: "1",
      chainId: network.chainId,
      verifyingContract: forwarderAddress,
    };

    const types = {
      ForwardRequest: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "gas", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "data", type: "bytes" },
      ],
    };

    const calldata = pharmaTree.interface.encodeFunctionData("markAsSold", [unitId]);
    const nonce = await forwarder.nonces(pharmacy.address);
    const deadline = Math.floor(Date.now() / 1000) + 3600;

    const message = {
      from: pharmacy.address,
      to: pharmaTreeAddress,
      value: 0,
      gas: 500000,
      nonce: nonce,
      deadline: deadline,
      data: calldata,
    };

    // Attacker signs forged payload claiming to be pharmacy
    const badSignature = await attacker.signTypedData(domain, types, message);

    const badRequest = {
      from: pharmacy.address,
      to: pharmaTreeAddress,
      value: 0,
      gas: 500000,
      deadline: deadline,
      data: calldata,
      signature: badSignature,
    };

    // Forwarder verify returns false
    expect(await forwarder.verify(badRequest)).to.be.false;

    // Execution reverts with ERC2771ForwarderInvalidSigner
    await expect(
      forwarder.connect(relayer).execute(badRequest)
    ).to.be.revertedWithCustomError(forwarder, "ERC2771ForwarderInvalidSigner");
  });
});
