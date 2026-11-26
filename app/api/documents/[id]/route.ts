import { problem } from "@/lib/http";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { record, bytes } = await (await getStore()).file(id);
    const disposition = new URL(request.url).searchParams.has("download") ? "attachment" : "inline";
    const ext = record.mime === "application/pdf" ? "pdf" : record.mime === "image/png" ? "png" : "jpg";
    const suffix = record.filename.split(".").pop()?.toLowerCase();
    const filename = suffix === ext || (ext === "jpg" && suffix === "jpeg") ? record.filename : record.filename + "." + ext;
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase());
    return new Response(new Uint8Array(bytes).buffer, { headers: {
      "Content-Type": record.mime,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": disposition + '; filename="document.' + ext + '"; filename*=UTF-8\'\'' + encoded,
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return problem(error); }
}
