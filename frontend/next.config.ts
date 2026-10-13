import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  ...(process.env.VERCEL ? {} : { output: "standalone" }),
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
};

export default nextConfig;
