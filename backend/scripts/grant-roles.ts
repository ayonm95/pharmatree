import { ethers } from "hardhat";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing ${name} in .env`);
  }
  return value;
}

function requireAddress(name: string): string {
  const value = requireEnv(name);
  if (!ethers.isAddress(value)) {
    throw new Error(`${name} is not a valid Ethereum address: ${value}`);
  }
  return value;
}

function requirePrivateKey(name: string): string {
  const value = requireEnv(name);
  if (!value.startsWith("0x")) {
    throw new Error(`${name} must start with 0x`);
  }
  if (value.length !== 66) {
    throw new Error(`${name} must be 64 hex chars long after 0x`);
  }
  return value;
}

async function main() {
  const rpcUrl = requireEnv("SEPOLIA_RPC_URL");
  const contractAddress = requireAddress("SEPOLIA_CONTRACT_ADDRESS");
  const manufacturerPrivateKey = requirePrivateKey("SEPOLIA_PRIVATE_KEY_MANUFACTURER");
  const distributorPrivateKey = requirePrivateKey("SEPOLIA_PRIVATE_KEY_DISTRIBUTOR");

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const manufacturerWallet = new ethers.Wallet(manufacturerPrivateKey, provider);
  const distributorWallet = new ethers.Wallet(distributorPrivateKey, provider);
  const adminWallet = manufacturerWallet;

  const manufacturerAddress = process.env.SEPOLIA_MANUFACTURER_ADDRESS
    ? requireAddress("SEPOLIA_MANUFACTURER_ADDRESS")
    : manufacturerWallet.address;

  if (manufacturerWallet.address.toLowerCase() !== manufacturerAddress.toLowerCase()) {
    throw new Error(
      `SEPOLIA_MANUFACTURER_ADDRESS must match SEPOLIA_PRIVATE_KEY_MANUFACTURER wallet. Expected ${manufacturerWallet.address}, received ${manufacturerAddress}`
    );
  }

  const distributorAddress = process.env.SEPOLIA_DISTRIBUTOR_ADDRESS
    ? requireAddress("SEPOLIA_DISTRIBUTOR_ADDRESS")
    : distributorWallet.address;

  if (distributorWallet.address.toLowerCase() !== distributorAddress.toLowerCase()) {
    throw new Error(
      `SEPOLIA_DISTRIBUTOR_ADDRESS must match SEPOLIA_PRIVATE_KEY_DISTRIBUTOR wallet. Expected ${distributorWallet.address}, received ${distributorAddress}`
    );
  }

  const PharmaTree = await ethers.getContractFactory("PharmaTree");
  const contract = PharmaTree.connect(adminWallet).attach(contractAddress);

  const currentManufacturer = await contract.isManufacturer(manufacturerAddress);
  const currentDistributor = await contract.isHandler(distributorAddress);

  if (!currentManufacturer) {
    const tx = await contract.addManufacturer(manufacturerAddress);
    await tx.wait();
    console.log(`Granted Manufacturer role to ${manufacturerAddress}`);
  } else {
    console.log(`Manufacturer role already present for ${manufacturerAddress}`);
  }

  if (!currentDistributor) {
    const tx = await contract.addHandler(distributorAddress);
    await tx.wait();
    console.log(`Granted Handler role to ${distributorAddress}`);
  } else {
    console.log(`Handler role already present for ${distributorAddress}`);
  }

  // A retail pharmacy requires DISPENSER_ROLE in addition to HANDLER_ROLE to sell stock
  const currentDispenser = await contract.isDispenser(distributorAddress);
  if (!currentDispenser) {
    const tx = await contract.addDispenser(distributorAddress);
    await tx.wait();
    console.log(`Granted Dispenser role to ${distributorAddress}`);
  } else {
    console.log(`Dispenser role already present for ${distributorAddress}`);
  }

  // Grant QA role to admin/manufacturer wallet for recall and clearRejected management
  const currentQA = await contract.isQA(adminWallet.address);
  if (!currentQA) {
    const tx = await contract.addQA(adminWallet.address);
    await tx.wait();
    console.log(`Granted QA role to ${adminWallet.address}`);
  } else {
    console.log(`QA role already present for ${adminWallet.address}`);
  }

  console.log("Done.");
  console.log("Rule: The deployer wallet is always manufacturer/admin until you build a real admin panel.");
  console.log("adminWallet:", adminWallet.address || "not set");
  console.log("contractAddress:", contractAddress || "not set");
  console.log("manufacturerAddress:", manufacturerAddress || "not set");
  console.log("distributorAddress:", distributorAddress || "not set");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
