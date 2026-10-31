import { ethers } from "hardhat";
import fs from "node:fs/promises";
import path from "node:path";

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
  console.log(`Using deployer: ${deployer.address}`);

  const forwarderAddress = "0x2d24b5b481d0981AE7904790e9d8BF4c162b6c8c";
  const contractAddress = process.env.SEPOLIA_CONTRACT_ADDRESS || "0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345";

  const contract = await ethers.getContractAt("PharmaTree", contractAddress, deployer);

  // 1. Check & Grant MANUFACTURER_ROLE to deployer
  const isMfr = await contract.isManufacturer(deployer.address);
  if (!isMfr) {
    console.log(`Granting MANUFACTURER_ROLE to ${deployer.address}...`);
    const tx = await contract.addManufacturer(deployer.address);
    await tx.wait(1);
    console.log(`✅ Granted MANUFACTURER_ROLE`);
  } else {
    console.log(`Deployer already has MANUFACTURER_ROLE.`);
  }

  // 2. Check & Grant HANDLER_ROLE and DISPENSER_ROLE to dispensary / distributor wallets
  const handlers = [
    "0xe88a5608B536BCc9d557823234BacA9a00F2540B",
    "0x1589df48e9F04926E260Bf813c42dFb4a71893A3",
  ];
  for (const h of handlers) {
    const isH = await contract.isHandler(h);
    if (!isH) {
      console.log(`Granting HANDLER_ROLE to ${h}...`);
      const tx = await contract.addHandler(h);
      await tx.wait(1);
      console.log(`✅ Granted HANDLER_ROLE to ${h}`);
    } else {
      console.log(`${h} already has HANDLER_ROLE.`);
    }

    const isDisp = await contract.isDispenser(h);
    if (!isDisp) {
      console.log(`Granting DISPENSER_ROLE to ${h}...`);
      const tx = await contract.addDispenser(h);
      await tx.wait(1);
      console.log(`✅ Granted DISPENSER_ROLE to ${h}`);
    } else {
      console.log(`${h} already has DISPENSER_ROLE.`);
    }
  }

  // 3. Seed Units 1 to 8 if fresh contract
  const currentUnits = await contract.unitCounter();
  console.log(`Current unitCounter: ${currentUnits.toString()}`);

  const defaultExpiry = Math.floor(Date.now() / 1000) + 730 * 86400; // 2 years
  const nextHash = (seed: string) => ethers.keccak256(ethers.toUtf8Bytes(seed));

  if (currentUnits === BigInt(0)) {
    console.log("Seeding Units 1 through 8 on Sepolia...");

    // Unit #1: Genesis Paracetamol 500mg, Active (50 tablets)
    const tx1 = await contract.createRootUnit(4, "Paracetamol 500mg, 50 tablets", 50, nextHash("CD360DWJZHAXPCNRDVF7"), defaultExpiry);
    await tx1.wait(1);
    console.log("✅ Unit #1 created (Active)");

    // Unit #2: Amoxicillin 250mg, Sold (Anti-replay test)
    const tx2 = await contract.createRootUnit(4, "Amoxicillin 250mg, 10 capsules", 10, nextHash("SGGJ9W55VG8HTN8N0NMM"), defaultExpiry);
    await tx2.wait(1);
    const tx2Sold = await contract.markAsSold(2);
    await tx2Sold.wait(1);
    console.log("✅ Unit #2 created (Sold - Anti-Replay)");

    // Units #3-#6: Pallet -> Case -> Box -> Pack
    const tx3 = await contract.createRootUnit(0, "Demo Pallet Alpha", 1, nextHash("X9Y4ZDHJHV2ZD567PF1A"), defaultExpiry);
    await tx3.wait(1);
    const tx4 = await contract.createRootUnit(1, "Demo Case 01", 1, nextHash("0XMRF9BQW7B9VVYKXY8F"), defaultExpiry);
    await tx4.wait(1);
    const tx5 = await contract.createRootUnit(2, "Demo Box 01", 1, nextHash("S7NY46QGMKAFTSCK1K0N"), defaultExpiry);
    await tx5.wait(1);
    const tx6 = await contract.createRootUnit(3, "Demo Blister Pack 01", 1, nextHash("R7969E2E20YV677N0J5Q"), defaultExpiry);
    await tx6.wait(1);
    console.log("✅ Units #3-#6 created (Hierarchy Pallet/Case/Box/Pack)");

    // Unit #7: Fractional Stock (100 units)
    const tx7 = await contract.createRootUnit(4, "Azithromycin 500mg, 100 units", 100, nextHash("E5S0X2Y35Z55X1N13N7N"), defaultExpiry);
    await tx7.wait(1);
    console.log("✅ Unit #7 created (Fractional Stock, 100 units)");

    // Unit #8: Transferred to pharmacy 0xe88a5608b536bcc9d557823234baca9a00f2540b
    const pharmacyAddr = "0xe88a5608B536BCc9d557823234BacA9a00F2540B";
    const tx8 = await contract.createRootUnit(4, "Ibuprofen 400mg, 20 packs", 20, nextHash("113V48CVM7K194W2E7P7"), defaultExpiry);
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
        console.log(`✅ Unit #8 transferred and accepted by ${pharmacyAddr}`);
      } catch (err: any) {
        console.warn(`Could not accept transfer: ${err.message}`);
      }
    } else {
      console.log(`✅ Unit #8 created and transferred to ${pharmacyAddr}`);
    }
  }

  // 4. Update environment variables
  const envPaths = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../frontend/.env.local"),
  ];

  for (const envPath of envPaths) {
    if (envPath.endsWith(".env.local")) {
      await replaceEnvValue(envPath, "NEXT_PUBLIC_PHARMA_TREE_CONTRACT", contractAddress);
      await replaceEnvValue(envPath, "NEXT_PUBLIC_TRUSTED_FORWARDER", forwarderAddress);
      await replaceEnvValue(envPath, "NEXT_PUBLIC_DEPLOYMENT_BLOCK", "12033849");
      await replaceEnvValue(envPath, "NEXT_PUBLIC_CHAIN_ID", "11155111");
    } else {
      await replaceEnvValue(envPath, "SEPOLIA_CONTRACT_ADDRESS", contractAddress);
      await replaceEnvValue(envPath, "TRUSTED_FORWARDER", forwarderAddress);
      await replaceEnvValue(envPath, "SEPOLIA_CHAIN_ID", "11155111");
    }
  }

  console.log("Environment synchronization complete!");
}

main().catch((err) => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
