import { z } from "zod";
import type { ToolDef } from "../registry";
import { fetchText } from "../net/http";

export function getMyLocationTool(): ToolDef<{}> {
  return {
    name: "get_my_location",
    description: "Get the user's current location (IP-based fallback).",
    schema: z.object({}),
    write: false,
    async run(_ctx) {
      const res = await fetchText("http://ip-api.com/json/", {
        headers: { "User-Agent": "marvin/1.0 (clean-room Node rewrite)" },
        timeoutMs: 10_000,
      });
      if (!res.ok) return `ERROR: get_my_location failed (status ${res.status}): ${res.error}`;

      let j: any;
      try {
        j = JSON.parse(res.text);
      } catch (e) {
        return `ERROR: get_my_location invalid JSON: ${String(e)}`;
      }

      return {
        latitude: typeof j?.lat === "number" ? j.lat : 0,
        longitude: typeof j?.lon === "number" ? j.lon : 0,
        source: "ip",
        city: j?.city ?? "",
        region: j?.regionName ?? "",
        country: j?.country ?? "",
      };
    },
  };
}
