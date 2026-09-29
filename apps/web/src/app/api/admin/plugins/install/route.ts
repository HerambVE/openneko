import { proxyPluginAdmin } from "@/lib/plugin-admin";

export function POST(request: Request) {
  return proxyPluginAdmin("/admin/plugins/install", request);
}
