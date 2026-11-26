import { createHash, randomBytes, scrypt } from "node:crypto";

export type Session = { get(): string | undefined; set(token: string): void; clear(): void };

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function passwordKey(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
