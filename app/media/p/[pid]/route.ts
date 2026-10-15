// Photos for the vetted picks (/picks). Only curated pids are served (no open proxy); the first request for a
// pick asks CJ for its main image once, then it's remembered for this process.
import { proxyImage } from "@/lib/media";
import { rememberImage, searchImage } from "@/lib/catalog-search";
import { curatedPick } from "@/lib/curated";
import { getProductDetail } from "@/lib/cj/client";
import { productImages } from "@/lib/cj/normalize";
import { processSingleton } from "@/lib/singleton";

const pending = processSingleton("pick-images", () => new Map<string, Promise<string | undefined>>());

async function pickImage(pid: string): Promise<string | undefined> {
  const known = searchImage(pid);
  if (known) return known;
  if (!pending.has(pid))
    pending.set(
      pid,
      getProductDetail(pid)
        .then((r) => {
          const url = r.data ? productImages(r.data)[0] : undefined;
          if (url) rememberImage(pid, url);
          else pending.delete(pid);
          return url;
        })
        .catch(() => {
          pending.delete(pid);
          return undefined;
        }),
    );
  return pending.get(pid);
}

export async function GET(_req: Request, { params }: { params: Promise<{ pid: string }> }) {
  const pid = (await params).pid;
  if (!curatedPick(pid)) return new Response("Not found", { status: 404 });
  return proxyImage(await pickImage(pid));
}
