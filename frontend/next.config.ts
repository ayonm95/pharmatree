import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  experimental: {
    agentUpgrade: "security",
  },
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default nextConfig;
