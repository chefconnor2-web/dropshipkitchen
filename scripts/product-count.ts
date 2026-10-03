// Prints the number of storefront products (used by scripts/start.sh to decide whether to seed).
import { prisma } from "@/lib/db";

prisma.product
  .count()
  .then((n) => console.log(n))
  .finally(() => prisma.$disconnect());
