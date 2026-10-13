import * as dotenv from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config();
const LOCAL_DEPLOYER_KEY = process.env.PRIVATE_KEY || "";
const SEPOLIA_DEPLOYER_KEY = process.env.SEPOLIA_PRIVATE_KEY_MANUFACTURER || "";

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.24",
        settings: {
          evmVersion: "cancun",
        },
      },
    ],
  },
  networks: {
    localhost: {
      url: "http://127.0.0.1:8545",
      accounts: LOCAL_DEPLOYER_KEY ? [LOCAL_DEPLOYER_KEY] : [],
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: SEPOLIA_DEPLOYER_KEY ? [SEPOLIA_DEPLOYER_KEY] : [],
      chainId: Number(process.env.SEPOLIA_CHAIN_ID || 11155111),
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};

export default config;