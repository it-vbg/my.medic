export type UploadFile = { name: string; mimeType: string; buffer: Buffer };

function png(data: string): UploadFile {
  return { name: "пиксель.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") };
}

export const redScan = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC");
export const greenScan = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC");

export function fullSizePdf(): UploadFile {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> >>",
  ];
  let body = "%PDF-1.4\n";
  const entries = ["0000000000 65535 f "];
  for (const [i, object] of objects.entries()) {
    entries.push(String(body.length).padStart(10, "0") + " 00000 n ");
    body += (i + 1) + " 0 obj\n" + object + "\nendobj\n";
  }
  const footer = "startxref\n" + body.length + "\n%%EOF\n";
  const xref = ["xref", "0 4", ...entries, "trailer", "<< /Size 4 /Root 1 0 R >>", ""].join("\n");
  // Whitespace between the trailer and startxref pads this one-page PDF to the upload limit.
  const buffer = Buffer.alloc(12 * 1024 * 1024, 0x20);
  buffer.write(body + xref);
  buffer.write(footer, buffer.length - footer.length);
  return { name: "пример.pdf", mimeType: "application/pdf", buffer };
}
