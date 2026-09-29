// Streams a supplier-hosted image through our own origin so customers never see supplier URLs.
export async function proxyImage(sourceUrl: string | null | undefined): Promise<Response> {
  if (!sourceUrl || !/^https?:\/\//.test(sourceUrl)) return new Response("Not found", { status: 404 });
  try {
    const upstream = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) });
    const type = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !type.startsWith("image/")) return new Response("Not found", { status: 404 });
    return new Response(upstream.body, {
      headers: { "content-type": type, "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return new Response("Upstream error", { status: 502 });
  }
}
