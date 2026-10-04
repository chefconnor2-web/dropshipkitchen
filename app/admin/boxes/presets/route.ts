// GET: preset build progress. POST: start building the preset boxes. Under /admin (admin login).
import { BOX_PRESETS, presetJob, startPresetBuild } from "@/lib/box-presets";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ...presetJob, presets: BOX_PRESETS.map((p) => p.key) });
}

export function POST() {
  return Response.json({ started: startPresetBuild() });
}
