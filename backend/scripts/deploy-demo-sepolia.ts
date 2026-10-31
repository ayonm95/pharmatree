import fs from "node:fs/promises";
import path from "node:path";
import { ethers, run } from "hardhat";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} in backend/.env`);
  return value;
}

function privateKey(name: string): string {
  const value = required(name);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be a 32-byte private key`);
  return value;
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
  content = pattern.test(content) ? content.replace(pattern, line) : `${content.trimEnd()}\n${line}\n`;
  await fs.writeFile(filePath, content);
}

async function main() {
  const provider = ethers.provider;
  const manufacturer = new ethers.Wallet(privateKey("SEPOLIA_PRIVATE_KEY_MANUFACTURER"), provider);
  const handler = new ethers.Wallet(privateKey("SEPOLIA_PRIVATE_KEY_DISTRIBUTOR"), provider);
  const quantity = Number(process.env.MEDICINE_QUANTITY ?? "100");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("MEDICINE_QUANTITY must be a positive integer");

  let forwarderAddress = process.env.TRUSTED_FORWARDER || process.env.NEXT_PUBLIC_TRUSTED_FORWARDER;
  if (!forwarderAddress || forwarderAddress === ethers.ZeroAddress) {
    const ForwarderFactory = await ethers.getContractFactory("PharmaTreeForwarder", manufacturer);
    const forwarder = await ForwarderFactory.deploy("PharmaTreeForwarder");
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
  }

  const Factory = await ethers.getContractFactory("PharmaTree");
  const contract = await Factory.connect(manufacturer).deploy(forwarderAddress);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  if (!(await contract.isManufacturer(manufacturer.address))) {
    await (await contract.addManufacturer(manufacturer.address)).wait();
  }
  if (!(await contract.isHandler(handler.address))) {
    await (await contract.addHandler(handler.address)).wait();
  }

  const createTx = await contract.createRootUnit(0, "Amoxicillin, demo deployment", quantity);
  const createReceipt = await createTx.wait();
  const unitId = Number(await contract.unitCounter());
  const transferTx = await contract.initiateTransfer(unitId, handler.address);
  const transferReceipt = await transferTx.wait();
  const handlerContract = contract.connect(handler);
  const acceptTx = await handlerContract.acceptTransfer(unitId);
  const acceptReceipt = await acceptTx.wait();

  const backendEnv = path.resolve(process.cwd(), ".env");
  const frontendEnv = path.resolve(process.cwd(), "../frontend/.env.local");
  await replaceEnvValue(backendEnv, "SEPOLIA_CONTRACT_ADDRESS", address);
  await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_PHARMA_TREE_CONTRACT", address);
  await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_RPC_URL", required("SEPOLIA_RPC_URL"));
  await replaceEnvValue(frontendEnv, "NEXT_PUBLIC_CHAIN_ID", "11155111");

  console.log(JSON.stringify({
    contract: address,
    manufacturer: manufacturer.address,
    handler: handler.address,
    unitId,
    quantity,
    createTx: createReceipt?.hash ?? createTx.hash,
    transferTx: transferReceipt?.hash ?? transferTx.hash,
    acceptTx: acceptReceipt?.hash ?? acceptTx.hash,
  }, null, 2));

  try {
    await run("verify:verify", { address, constructorArguments: [] });
    console.log("Etherscan verification completed.");
  } catch (error) {
    console.warn("Etherscan verification was not completed:", error instanceof Error ? error.message : String(error));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
