import { ethers } from "hardhat";

async function getDeployer() {
  const networkName = (await ethers.provider.getNetwork()).name;

  if (networkName === "hardhat" || networkName === "localhost") {
    const [signer] = await ethers.getSigners();
    if (signer) {
      return signer;
    }
  }

  const value = process.env.SEPOLIA_PRIVATE_KEY_MANUFACTURER || process.env.PRIVATE_KEY;
  if (value && value.startsWith("0x") && value.length === 66) {
    return new ethers.Wallet(value, ethers.provider);
  }

  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error("No deployer account is available. Set SEPOLIA_PRIVATE_KEY_MANUFACTURER or PRIVATE_KEY for a funded wallet.");
  }

  return signer;
}

async function main() {
  const deployer = await getDeployer();

  // If a TRUSTED_FORWARDER environment variable is provided, use it, or deploy fresh forwarder
  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", deployer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log("Deployed PharmaTreeForwarder at:", forwarderAddress);
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