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
  const provider = ethers.provider;
  console.log(`Deployer / Admin Wallet: ${deployer.address}`);

  const contractAddress = process.env.SEPOLIA_CONTRACT_ADDRESS || "0xa51Fe74519fFdd2f167e74780Be7AAD155eEF345";
  const contract = await ethers.getContractAt("PharmaTree", contractAddress, deployer);

  // Generate a brand new dedicated Hot Relayer wallet
  const relayerWallet = ethers.Wallet.createRandom(provider);
  console.log(`Generated Dedicated Hot Relayer Wallet: ${relayerWallet.address}`);

  // Fund Hot Relayer with 0.1 ETH from deployer for gas sponsorship
  const fundTx = await deployer.sendTransaction({
    to: relayerWallet.address,
    value: ethers.parseEther("0.1"),
  });
  console.log(`Submitted funding tx: ${fundTx.hash}`);
  await fundTx.wait(1);
  console.log(`✅ Funded Hot Relayer with 0.1 ETH. Balance: ${ethers.formatEther(await provider.getBalance(relayerWallet.address))} ETH`);

  // Verify Hot Relayer has ZERO roles on-chain
  const adminRole = await contract.DEFAULT_ADMIN_ROLE();
  const mfrRole = await contract.MANUFACTURER_ROLE();
  const handlerRole = await contract.HANDLER_ROLE();
  const dispenserRole = await contract.DISPENSER_ROLE();
  const qaRole = await contract.QA_ROLE();

  const hasAdmin = await contract.hasRole(adminRole, relayerWallet.address);
  const hasMfr = await contract.hasRole(mfrRole, relayerWallet.address);
  const hasHandler = await contract.hasRole(handlerRole, relayerWallet.address);
  const hasDispenser = await contract.hasRole(dispenserRole, relayerWallet.address);
  const hasQA = await contract.hasRole(qaRole, relayerWallet.address);

  console.log(`\n--- Verification of Relayer Role Isolation ---`);
  console.log(`Relayer has DEFAULT_ADMIN_ROLE: ${hasAdmin}`);
  console.log(`Relayer has MANUFACTURER_ROLE:  ${hasMfr}`);
  console.log(`Relayer has HANDLER_ROLE:       ${hasHandler}`);
  console.log(`Relayer has DISPENSER_ROLE:     ${hasDispenser}`);
  console.log(`Relayer has QA_ROLE:            ${hasQA}`);

  if (hasAdmin || hasMfr || hasHandler || hasDispenser || hasQA) {
    throw new Error("SECURITY FAULT: Relayer holds an on-chain role!");
  }
  console.log(`✅ CONFIRMED: Relayer holds ZERO roles on PharmaTree.sol`);

  // Update frontend/.env.local and backend/.env with RELAYER_PRIVATE_KEY
  const frontendEnv = path.resolve(__dirname, "../../frontend/.env.local");
  const backendEnv = path.resolve(__dirname, "../.env");

  await replaceEnvValue(frontendEnv, "RELAYER_PRIVATE_KEY", relayerWallet.privateKey);
  await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_RELAYER_ADDRESS", relayerWallet.address);
  await replaceEnvValue(backendEnv, "RELAYER_PRIVATE_KEY", relayerWallet.privateKey);
  await replaceEnvValue(backendEnv, "SEPOLIA_RELAYER_ADDRESS", relayerWallet.address);

  console.log(`\nKey architecture separation successfully applied:`);
  console.log(`- Admin:        ${deployer.address} (Holds DEFAULT_ADMIN_ROLE)`);
  console.log(`- Manufacturer: ${deployer.address} (Holds MANUFACTURER_ROLE)`);
  console.log(`- Hot Relayer:  ${relayerWallet.address} (Holds ZERO roles, gas sponsor only)`);
}

main().catch((err) => {
  console.error("Split roles setup failed:", err);
  process.exit(1);
});
