import assert from "node:assert/strict";
import test from "node:test";
import { parseUpload, readLimited, requireSameOrigin } from "../lib/input.ts";

function form(bytes: Uint8Array, filename: string, date = "2024-02-29") {
  const data = new FormData();
  data.set("file", new File([new Uint8Array(bytes).buffer], filename));
  data.set("category", "analysis");
  data.set("examDate", date);
  return data;
}

test("a real PDF signature is accepted, with a title derived from its name", async () => {
  const input = await parseUpload(form(new TextEncoder().encode("%PDF-1.7\nsample"), "Анализ.pdf"));
  assert.equal(input.title, "Анализ");
  assert.equal(input.mime, "application/pdf");
  assert.equal(input.examDate, "2024-02-29");
});

test("an unsupported format or invalid calendar date cannot be stored", async () => {
  await assert.rejects(parseUpload(form(new TextEncoder().encode("ordinary text"), "Файл.pdf")));
  await assert.rejects(parseUpload(form(new TextEncoder().encode("%PDF-1.7"), "Файл.pdf", "2025-02-29")));
  await assert.rejects(parseUpload(form(new Uint8Array([0xa5, 0xd0, 0xc4, 0xc6, 0xad]), "Файл.pdf")));
});

test("form mutations must come from this origin, including the scheme", () => {
  const make = (origin: string) => new Request("https://medical.example.test/api/cabinet", { headers: { origin } });
  assert.doesNotThrow(() => requireSameOrigin(make("https://medical.example.test")));
  assert.throws(() => requireSameOrigin(make("https://other.example.test")), { status: 403 });
  assert.throws(() => requireSameOrigin(make("http://medical.example.test")), { status: 403 });
});

test("a request without Content-Length is still bounded", async () => {
  const request = new Request("http://localhost", { method: "POST", body: new Uint8Array(101) });
  assert.equal(request.headers.get("content-length"), null);
  await assert.rejects(readLimited(request, 100), { status: 413 });
});
