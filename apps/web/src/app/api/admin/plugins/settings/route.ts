import { proxyPluginAdmin } from "@/lib/plugin-admin";

export function GET() {
  return proxyPluginAdmin("/admin/plugins/settings");
}

export function POST(request: Request) {
  return proxyPluginAdmin("/admin/plugins/settings", request);
}
