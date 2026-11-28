import { resolve } from "path";
import type { NextConfig } from "next";
import { withEmulate } from "@emulators/adapter-next";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(import.meta.dirname, "../.."),
  },
  allowedDevOrigins: ["stripe-checkout.emulate.localhost"],
};

export default withEmulate(nextConfig);
