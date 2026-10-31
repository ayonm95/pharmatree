import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ethers } from "hardhat";
import { resetDatabase } from "./reset-db";

const SEAL_PEPPER = process.env.SEAL_PEPPER || "pharmatree-tamper-seal-pepper-sepolia-v1";
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCrockford(length = 12): string {
  const bytes = crypto.randomBytes(length);
  let res = "";
  for (let i = 0; i < length; i++) {
    res += CROCKFORD_ALPHABET[bytes[i] % 32];
  }
  return res;
}

function normalizeSerial(serial: string): string {
  return serial.toUpperCase().trim().replace(/[\s-]+/g, "");
}

function computeSealVerifier(unitId: number | string, secret: string, version = "v1"): string {
  const normalized = secret
    .toUpperCase()
    .trim()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const hmac = crypto
    .createHmac("sha256", SEAL_PEPPER)
    .update(`${unitId}:${normalized}`)
    .digest("hex");
  return `${version}:${hmac}`;
}

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
  console.log("==================================================");
  console.log("🚀 Starting PharmaTree Hardened Sepolia Deployment");
  console.log("==================================================\n");

  // Step 1: Reset database / storage tables
  await resetDatabase();

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer wallet configured for Sepolia.");

  const deployerAddress = deployer.address;
  console.log(`Deployer Address: ${deployerAddress}`);
  const balance = await ethers.provider.getBalance(deployerAddress);
  console.log(`Deployer Balance: ${ethers.formatEther(balance)} Sepolia ETH\n`);

  // Step 2: Deploy or bind PharmaTreeForwarder
  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    console.log("Deploying new PharmaTreeForwarder...");
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", deployer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log(`✅ PharmaTreeForwarder deployed to: ${forwarderAddress}`);
  } else {
    console.log(`Using existing PharmaTreeForwarder: ${forwarderAddress}`);
  }

  // Step 3: Deploy fresh PharmaTree contract
  console.log("\nDeploying fresh PharmaTree smart contract with calldata hardening...");
  const Factory = await ethers.getContractFactory("PharmaTree", deployer);
  const contract = await Factory.deploy(forwarderAddress);
  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();
  const deploymentReceipt = await deploymentTx?.wait(1);

  console.log(`✅ PharmaTree deployed to: ${contractAddress}`);
  console.log(`   Block Number: ${deploymentReceipt?.blockNumber}`);
  console.log(`   Tx Hash: ${deploymentTx?.hash}\n`);

  // Step 4: Grant Roles on Sepolia
  console.log("Configuring RBAC Roles on Sepolia...");

  // Deployer as Manufacturer
  const isMfr = await contract.isManufacturer(deployerAddress);
  if (!isMfr) {
    const tx = await contract.addManufacturer(deployerAddress);
    await tx.wait(1);
    console.log(`✅ Granted MANUFACTURER_ROLE to deployer: ${deployerAddress}`);
  }

  // Deployer as Dispenser (for self-verification)
  const isDeployerDisp = await contract.isDispenser(deployerAddress);
  if (!isDeployerDisp) {
    const tx = await contract.addDispenser(deployerAddress);
    await tx.wait(1);
    console.log(`✅ Granted DISPENSER_ROLE to deployer: ${deployerAddress}`);
  }

  // Deployer as QA
  const isDeployerQA = await contract.isQA(deployerAddress);
  if (!isDeployerQA) {
    const tx = await contract.addQA(deployerAddress);
    await tx.wait(1);
    console.log(`✅ Granted QA_ROLE to deployer: ${deployerAddress}`);
  }

  // Pharmacy / Distributor Wallet
  const pharmacyAddress = "0xe88a5608B536BCc9d557823234BacA9a00F2540B";
  const isPharmacyHandler = await contract.isHandler(pharmacyAddress);
  if (!isPharmacyHandler) {
    const tx = await contract.addHandler(pharmacyAddress);
    await tx.wait(1);
    console.log(`✅ Granted HANDLER_ROLE to pharmacy: ${pharmacyAddress}`);
  }

  const isPharmacyDispenser = await contract.isDispenser(pharmacyAddress);
  if (!isPharmacyDispenser) {
    const tx = await contract.addDispenser(pharmacyAddress);
    await tx.wait(1);
    console.log(`✅ Granted DISPENSER_ROLE to pharmacy: ${pharmacyAddress}`);
  }

  // Step 5: Seed Units #1 to #10 with Scheme 1 HMAC seals
  console.log("\nSeeding demo units #1 through #10 with Scheme 1 HMAC seals & 2-year expiries...");
  const defaultExpiry = Math.floor(Date.now() / 1000) + 730 * 86400; // 2 years future
  const seededUnits: any[] = [];
  const sealRecords: Record<string, any> = {};

  const distKey = process.env.SEPOLIA_PRIVATE_KEY_DISTRIBUTOR?.trim();
  let pharmacyWallet: any = null;
  if (distKey) {
    pharmacyWallet = new ethers.Wallet(distKey, ethers.provider);
  }

  // Helper to mint unit with off-chain hash and register seal
  async function seedUnit(
    unitId: number,
    level: number,
    metadata: string,
    quantity: number
  ) {
    const serial = generateCrockford(20);
    const normalizedSerial = normalizeSerial(serial);
    const serialHash = ethers.keccak256(ethers.toUtf8Bytes(normalizedSerial));

    const sealSecret = generateCrockford(12);
    const verifier = computeSealVerifier(unitId, sealSecret, "v1");

    sealRecords[String(unitId)] = {
      unitId: String(unitId),
      verifier,
      scheme: 1,
      state: "SEALED",
      failedAttempts: 0,
      secretForTesting: sealSecret,
      serialForTesting: serial,
    };

    console.log(`Minting Unit #${unitId}: ${metadata} (Qty: ${quantity})...`);
    const tx = await contract.createRootUnit(level, metadata, quantity, serialHash, defaultExpiry);
    await tx.wait(1);

    seededUnits.push({
      unitId,
      level,
      metadata,
      quantity,
      serial,
      sealSecret,
      verifier,
    });
    console.log(`  -> Minted Unit #${unitId} (Serial: ${serial})`);
  }

  // 1. Unit #1: Genesis item (Paracetamol 500mg, active in stock)
  await seedUnit(1, 4, "Paracetamol 500mg, 50 tablets", 50);

  // 2. Unit #2: Sold item (Amoxicillin 250mg, marked sold to demonstrate anti-replay)
  await seedUnit(2, 4, "Amoxicillin 250mg, 10 capsules", 10);
  const tx2Sold = await contract.markAsSold(2);
  await tx2Sold.wait(1);
  console.log("  -> Marked Unit #2 as SOLD (Anti-Replay / Double-Spend test)");

  // 3-6. Units #3-#6: Pallet -> Case -> Box -> Pack
  await seedUnit(3, 0, "Demo Pallet Alpha", 1);
  await seedUnit(4, 1, "Demo Case 01", 1);
  await seedUnit(5, 2, "Demo Box 01", 1);
  await seedUnit(6, 3, "Demo Blister Pack 01", 1);

  // 7. Unit #7: Bulk item (Azithromycin 500mg, 100 units for fractional dispensing demo)
  await seedUnit(7, 4, "Azithromycin 500mg, 100 units", 100);

  // 8. Unit #8: Transferred to & accepted by dispensary wallet
  await seedUnit(8, 4, "Ibuprofen 400mg, 20 packs", 20);
  const tx8Transfer = await contract.initiateTransfer(8, pharmacyAddress);
  await tx8Transfer.wait(1);
  if (pharmacyWallet) {
    const pharmacyContract = contract.connect(pharmacyWallet) as any;
    const tx8Accept = await pharmacyContract.acceptTransfer(8);
    await tx8Accept.wait(1);
    console.log(`  -> Transferred & Accepted Unit #8 by Pharmacy: ${pharmacyAddress}`);
  }

  // 9. Unit #9: Cold-chain Insulin Glargine, in-transit pending delivery
  await seedUnit(9, 4, "Cold-Chain Insulin Glargine, 10 vials", 10);
  const tx9Transfer = await contract.initiateTransfer(9, pharmacyAddress);
  await tx9Transfer.wait(1);
  console.log(`  -> Initiated Transfer of Unit #9 to Pharmacy (Status: PendingTransfer)`);

  // 10. Unit #10: Contaminated / Rejected Shipment in Quarantine
  await seedUnit(10, 4, "Doxycycline 100mg, 30 capsules", 30);
  const tx10Transfer = await contract.initiateTransfer(10, pharmacyAddress);
  await tx10Transfer.wait(1);
  if (pharmacyWallet) {
    const pharmacyContract = contract.connect(pharmacyWallet) as any;
    const tx10Reject = await pharmacyContract.rejectTransfer(10);
    await tx10Reject.wait(1);
    console.log(`  -> Transfer of Unit #10 REJECTED by Pharmacy (Status: Rejected Quarantine)`);
  }

  // Step 6: Persist Tamper Seal Verifiers to local file storage & database
  const storagePaths = [
    path.resolve(__dirname, "../../frontend/.data/seals.json"),
    path.resolve(__dirname, "../../.data/seals.json"),
    "/tmp/.pharmatree-data/seals.json",
  ];

  for (const sPath of storagePaths) {
    try {
      await fs.mkdir(path.dirname(sPath), { recursive: true });
      await fs.writeFile(sPath, JSON.stringify(sealRecords, null, 2), "utf8");
      console.log(`✅ Saved seal records to: ${sPath}`);
    } catch (e: any) {
      console.warn(`Could not write seals to ${sPath}:`, e.message);
    }
  }

  // If Neon database is configured, insert seal records
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (dbUrl) {
    try {
      const { Pool } = await import("@neondatabase/serverless");
      const pool = new Pool({ connectionString: dbUrl });
      const client = await pool.connect();
      try {
        for (const [uId, rec] of Object.entries(sealRecords)) {
          await client.query(
            `INSERT INTO seal_secrets (unit_id, verifier, scheme, state, failed_attempts)
             VALUES ($1, $2, $3, $4, 0)
             ON CONFLICT (unit_id) DO UPDATE SET verifier = EXCLUDED.verifier, scheme = EXCLUDED.scheme;`,
            [uId, rec.verifier, rec.scheme, rec.state]
          );
        }
        console.log("✅ Seeded seal verifiers into Neon database.");
      } finally {
        client.release();
        await pool.end();
      }
    } catch (dbErr: any) {
      console.warn("Neon seal insert skipped:", dbErr.message);
    }
  }

  // Step 7: Update .env files
  console.log("\nUpdating configuration environment files...");
  const envPaths = [
    path.resolve(__dirname, "../.env"),
    path.resolve(__dirname, "../../frontend/.env.local"),
  ];

  for (const envPath of envPaths) {
    if (envPath.endsWith(".env.local")) {
      await replaceEnvValue(envPath, "NEXT_PUBLIC_PHARMA_TREE_CONTRACT", contractAddress);
      await replaceEnvValue(envPath, "NEXT_PUBLIC_TRUSTED_FORWARDER", forwarderAddress);
      if (deploymentReceipt?.blockNumber !== undefined) {
        await replaceEnvValue(
          envPath,
          "NEXT_PUBLIC_DEPLOYMENT_BLOCK",
          String(deploymentReceipt.blockNumber)
        );
      }
      await replaceEnvValue(envPath, "NEXT_PUBLIC_CHAIN_ID", "11155111");
    } else {
      await replaceEnvValue(envPath, "SEPOLIA_CONTRACT_ADDRESS", contractAddress);
      await replaceEnvValue(envPath, "TRUSTED_FORWARDER", forwarderAddress);
      await replaceEnvValue(envPath, "SEPOLIA_CHAIN_ID", "11155111");
    }
  }

  // Step 8: Save deployment manifest
  const result = {
    network: "sepolia",
    chainId: 11155111,
    contracts: {
      PharmaTree: {
        address: contractAddress,
        deploymentBlock: deploymentReceipt?.blockNumber,
        deploymentTx: deploymentTx?.hash,
      },
      PharmaTreeForwarder: {
        address: forwarderAddress,
      },
    },
    deployer: deployerAddress,
    manufacturer: deployerAddress,
    pharmacy: pharmacyAddress,
    seededUnitsCount: 10,
    deployedAt: new Date().toISOString(),
  };

  const deploymentJsonPaths = [
    path.resolve(__dirname, "../deployments/sepolia.json"),
    path.resolve(__dirname, "../../deployments/sepolia.json"),
  ];

  for (const p of deploymentJsonPaths) {
    try {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, JSON.stringify(result, null, 2), "utf8");
      console.log(`✅ Saved deployment manifest to: ${p}`);
    } catch (dErr) {
      console.warn(`Could not save deployment manifest to ${p}:`, dErr);
    }
  }

  // Save seeded units verification secrets for automated tests
  const testSecretsPath = path.resolve(__dirname, "../deployments/sepolia-units.json");
  await fs.writeFile(testSecretsPath, JSON.stringify(seededUnits, null, 2), "utf8");
  console.log(`✅ Saved unit test secrets to: ${testSecretsPath}`);

  console.log("\n==================================================");
  console.log("🎉 SEPOLIA HARDENED DEPLOYMENT COMPLETE");
  console.log("==================================================");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Deployment failed:", error);
  process.exitCode = 1;
});
