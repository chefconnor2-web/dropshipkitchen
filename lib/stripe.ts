import Stripe from "stripe";
import { config, stripeKeyProblem } from "@/lib/config";

let client: Stripe | null = null;

export function stripe(): Stripe {
  const problem = stripeKeyProblem();
  if (problem) throw new Error(problem);
  client ??= new Stripe(config.stripe.secretKey);
  return client;
}
