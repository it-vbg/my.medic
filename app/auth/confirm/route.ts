export function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const target = /^[A-Za-z0-9_-]{43}$/.test(token) ? "/?confirm=" + token : "/?auth=expired";
  return new Response(null, {
    status: 307,
    headers: { Location: target, "Cache-Control": "private, no-store" },
  });
}
