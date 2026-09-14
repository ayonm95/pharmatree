import { ethers } from "ethers";

const DEFAULT_SEPOLIA_CHAIN_ID = 11155111;
const DEFAULT_SEPOLIA_NETWORK = { chainId: DEFAULT_SEPOLIA_CHAIN_ID, name: "sepolia" };

const PUBLIC_SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://gateway.tenderly.co/public/sepolia",
  "https://1rpc.io/sepolia",
  "https://sepolia.infura.io/v3/ab602f75684b462da53b56b8e765e5a2",
];

function getRpcEndpoints(): string[] {
  const envUrl = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  const rawList = [
    envUrl,
    ...PUBLIC_SEPOLIA_RPCS,
  ].filter((url): url is string => Boolean(url && url.startsWith("http")));

  return Array.from(new Set(rawList));
}

let cachedProvider: ethers.FallbackProvider | null = null;

export function getReadonlyProvider(): ethers.FallbackProvider {
  if (cachedProvider) return cachedProvider;

  const endpoints = getRpcEndpoints();
  const configs = endpoints.map((url, index) => {
    const jsonProvider = new ethers.JsonRpcProvider(
      url,
      DEFAULT_SEPOLIA_NETWORK,
      {
        staticNetwork: true,
        batchMaxCount: 1, // Prevent large JSON-RPC array batches that trigger -32005 rate limits on free tiers
      }
    );

    return {
      provider: jsonProvider,
      priority: index + 1,
      weight: 1,
      stallTimeout: 2000,
    };
  });

  cachedProvider = new ethers.FallbackProvider(configs, DEFAULT_SEPOLIA_NETWORK, {
    quorum: 1,
  });

  return cachedProvider;
}

export const readonlyProvider = getReadonlyProvider();
