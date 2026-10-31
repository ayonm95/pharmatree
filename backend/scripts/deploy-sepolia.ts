import { ethers } from "hardhat";

function getManufacturerKey(): string {
  const value = process.env.SEPOLIA_PRIVATE_KEY_MANUFACTURER || process.env.PRIVATE_KEY;
  if (!value || !value.startsWith("0x") || value.length !== 66) {
    throw new Error("Missing or invalid manufacturer private key. Set SEPOLIA_PRIVATE_KEY_MANUFACTURER or PRIVATE_KEY before deploying.");
  }
  return value;
}

async function main() {
  const manufacturerKey = getManufacturerKey();
  const provider = ethers.provider;
  const deployer = new ethers.Wallet(manufacturerKey, provider);

  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", deployer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log(`PharmaTreeForwarder deployed to: ${forwarderAddress}`);
  }

  const PharmaTree = await ethers.getContractFactory("PharmaTree");
  const pharmaTree = await PharmaTree.connect(deployer).deploy(forwarderAddress);
  await pharmaTree.waitForDeployment();

  const contractAddress = await pharmaTree.getAddress();

  const hasManufacturerRole = await pharmaTree.isManufacturer(deployer.address);
  const hasAdminRole = await pharmaTree.hasRole(await pharmaTree.DEFAULT_ADMIN_ROLE(), deployer.address);

  if (!hasManufacturerRole) {
    const tx = await pharmaTree.connect(deployer).addManufacturer(deployer.address);
    await tx.wait();
  }

  if (!hasAdminRole) {
    const tx = await pharmaTree.connect(deployer).grantRole(await pharmaTree.DEFAULT_ADMIN_ROLE(), deployer.address);
    await tx.wait();
  }

  console.log(contractAddress);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});