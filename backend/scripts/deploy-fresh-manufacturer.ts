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
  await fs.writeFile(filePath, content);
}

function requiredPrivateKey(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a valid 32-byte private key in backend/.env.`);
  }
  return value;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer wallet is configured for this network.");

  const manufacturerKey = requiredPrivateKey("SEPOLIA_PRIVATE_KEY_MANUFACTURER");
  const defaultManufacturerAddress = new ethers.Wallet(manufacturerKey).address;
  const targetAddress = process.env.NEW_MANUFACTURER_ADDRESS?.trim() || defaultManufacturerAddress;
  if (!ethers.isAddress(targetAddress)) {
    throw new Error("NEW_MANUFACTURER_ADDRESS must be a valid Ethereum address.");
  }
  if (deployer.address.toLowerCase() !== defaultManufacturerAddress.toLowerCase()) {
    throw new Error(
      `The configured deployer must match SEPOLIA_PRIVATE_KEY_MANUFACTURER (${defaultManufacturerAddress}).`
    );
  }

  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", deployer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
  }

  const Factory = await ethers.getContractFactory("PharmaTree", deployer);
  const contract = await Factory.deploy(forwarderAddress);
  const deploymentReceipt = await contract.deploymentTransaction()?.wait();
  const contractAddress = await contract.getAddress();

  const isAlreadyManufacturer = await contract.isManufacturer(targetAddress);
  let roleTransactionHash: string | undefined;
  if (!isAlreadyManufacturer) {
    const roleTransaction = await contract.addManufacturer(targetAddress);
    await roleTransaction.wait();
    roleTransactionHash = roleTransaction.hash;
  }

  const backendEnv = path.resolve(process.cwd(), ".env");
  const frontendEnv = path.resolve(process.cwd(), "../frontend/.env.local");
  await replaceEnvValue(backendEnv, "SEPOLIA_CONTRACT_ADDRESS", contractAddress);
  await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_PHARMA_TREE_CONTRACT", contractAddress);
  if (deploymentReceipt?.blockNumber !== undefined) {
    await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_DEPLOYMENT_BLOCK", String(deploymentReceipt.blockNumber));
  }

  console.log(JSON.stringify({
    contract: contractAddress,
    deployer: deployer.address,
    manufacturer: targetAddress,
    deploymentBlock: deploymentReceipt?.blockNumber,
    roleTransactionHash,
    network: (await ethers.provider.getNetwork()).chainId.toString(),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
