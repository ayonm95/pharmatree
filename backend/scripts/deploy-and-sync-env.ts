import fs from "node:fs/promises";
import path from "node:path";
import { ethers } from "hardhat";

async function replaceEnvValue(filePath: string, key: string, value: string) {
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  content = pattern.test(content)
    ? content.replace(pattern, line)
    : `${content.trimEnd()}\n${line}\n`;
  await fs.writeFile(filePath, content, "utf8");
  console.log(`Updated ${key} in ${filePath}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer wallet configured for Sepolia.");

  const targetManufacturer = deployer.address;
  console.log(`Deploying PharmaTree with deployer: ${deployer.address}`);

  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", deployer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log(`PharmaTreeForwarder deployed to: ${forwarderAddress}`);
  }

  const Factory = await ethers.getContractFactory("PharmaTree", deployer);
  const contract = await Factory.deploy(forwarderAddress);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();
  const deploymentReceipt = await deploymentTx?.wait(1);

  console.log(`PharmaTree deployed to: ${contractAddress}`);
  console.log(`Deployment Block: ${deploymentReceipt?.blockNumber}`);

  const isMfr = await contract.isManufacturer(targetManufacturer);
  let roleTxHash: string | undefined;
  if (!isMfr) {
    const roleTx = await contract.addManufacturer(targetManufacturer);
    await roleTx.wait(1);
    roleTxHash = roleTx.hash;
    console.log(`Granted MANUFACTURER_ROLE to ${targetManufacturer}`);
  }

  const defaultHandlers = [
    "0xe88a5608B536BCc9d557823234BacA9a00F2540B",
    "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
  ];
  for (const handlerAddr of defaultHandlers) {
    try {
      const isH = await contract.isHandler(handlerAddr);
      if (!isH) {
        const tx = await contract.addHandler(handlerAddr);
        await tx.wait(1);
        console.log(`Granted HANDLER_ROLE to ${handlerAddr}`);
      }
    } catch (e: any) {
      console.warn(`Could not add handler ${handlerAddr}:`, e.message);
    }
  }

  // Seed demo units for POS and Invariant testing
  const unitCount = await contract.unitCounter();
  if (unitCount === BigInt(0)) {
    console.log("Seeding Sepolia demo units for 5-tier verification suite...");

    // Unit #1: Genesis item (Paracetamol 500mg, active in stock)
    const tx1 = await contract.createRootUnit(4, "Paracetamol 500mg, 50 tablets", 50);
    await tx1.wait(1);
    console.log("✅ Seeded Unit #1 (Paracetamol 500mg, Active)");

    // Unit #2: Sold item (Amoxicillin 250mg, marked sold to demonstrate anti-replay)
    const tx2 = await contract.createRootUnit(4, "Amoxicillin 250mg, 10 capsules", 10);
    await tx2.wait(1);
    const tx2Sold = await contract.markAsSold(2);
    await tx2Sold.wait(1);
    console.log("✅ Seeded Unit #2 (Amoxicillin 250mg, Sold / Anti-Replay)");

    // Units #3-#6: Pallet -> Case -> Box -> Pack
    const tx3 = await contract.createRootUnit(0, "Demo Pallet Alpha", 1);
    await tx3.wait(1);
    const tx4 = await contract.createRootUnit(1, "Demo Case 01", 1);
    await tx4.wait(1);
    const tx5 = await contract.createRootUnit(2, "Demo Box 01", 1);
    await tx5.wait(1);
    const tx6 = await contract.createRootUnit(3, "Demo Blister Pack 01", 1);
    await tx6.wait(1);
    console.log("✅ Seeded Units #3-#6 (Hierarchy Pallet/Case/Box/Pack)");

    // Unit #7: Bulk item (Azithromycin 500mg, 100 units for fractional dispensing demo)
    const tx7 = await contract.createRootUnit(4, "Azithromycin 500mg, 100 units", 100);
    await tx7.wait(1);
    console.log("✅ Seeded Unit #7 (Azithromycin 500mg, 100 units Fractional)");

    // Unit #8: Transferred to dispensary wallet 0xe88a5608b536bcc9d557823234baca9a00f2540b
    const pharmacyAddr = "0xe88a5608B536BCc9d557823234BacA9a00F2540B";
    const tx8 = await contract.createRootUnit(4, "Ibuprofen 400mg, 20 packs", 20);
    await tx8.wait(1);
    const tx8Transfer = await contract.initiateTransfer(8, pharmacyAddr);
    await tx8Transfer.wait(1);

    const distKey = process.env.SEPOLIA_PRIVATE_KEY_DISTRIBUTOR?.trim();
    if (distKey) {
      try {
        const distWallet = new ethers.Wallet(distKey, ethers.provider);
        const distContract = contract.connect(distWallet) as any;
        const tx8Accept = await distContract.acceptTransfer(8);
        await tx8Accept.wait(1);
        console.log(`✅ Seeded Unit #8 (Transferred & Accepted by dispensary ${pharmacyAddr})`);
      } catch (err: any) {
        console.warn(`Could not auto-accept transfer on unit 8: ${err.message}`);
      }
    } else {
      console.log(`✅ Seeded Unit #8 (Initiated transfer to ${pharmacyAddr})`);
    }
  }

  const envPaths = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../frontend/.env.local"),
  ];

  for (const envPath of envPaths) {
    if (envPath.endsWith(".env.local")) {
      await replaceEnvValue(envPath, "NEXT_PUBLIC_PHARMA_TREE_CONTRACT", contractAddress);
      await replaceEnvValue(envPath, "NEXT_PUBLIC_TRUSTED_FORWARDER", forwarderAddress);
      if (deploymentReceipt?.blockNumber !== undefined) {
        await replaceEnvValue(envPath, "NEXT_PUBLIC_DEPLOYMENT_BLOCK", String(deploymentReceipt.blockNumber));
      }
      await replaceEnvValue(envPath, "NEXT_PUBLIC_CHAIN_ID", "11155111");
    } else {
      await replaceEnvValue(envPath, "SEPOLIA_CONTRACT_ADDRESS", contractAddress);
      await replaceEnvValue(envPath, "TRUSTED_FORWARDER", forwarderAddress);
      await replaceEnvValue(envPath, "SEPOLIA_CHAIN_ID", "11155111");
    }
  }

  const result = {
    contractAddress,
    deployer: deployer.address,
    manufacturer: targetManufacturer,
    deploymentBlock: deploymentReceipt?.blockNumber,
    roleTxHash,
    network: (await ethers.provider.getNetwork()).chainId.toString(),
  };

  console.log("\n--- DEPLOYMENT SUCCESSFUL ---");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
