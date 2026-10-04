import Stripe from "stripe";
import { config, stripeKeyProblem } from "@/lib/config";

let client: Stripe | null = null;

export function stripe(): Stripe {
  const problem = stripeKeyProblem();
  if (problem) throw new Error(problem);
  // STRIPE_API_HOST (host:port, plain http) points the client at a local fake for testing; never set in production.
  const local = process.env.STRIPE_API_HOST?.trim();
  client ??= new Stripe(
    config.stripe.secretKey,
    local ? { host: local.split(":")[0], port: Number(local.split(":")[1] || 80), protocol: "http" } : undefined,
  );
  return client;
}
