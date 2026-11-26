export type Category = "analysis" | "examination";
export type Account = { id: string; name: string; email: string };
export type Card = { id: string; name: string; relation: "self" | "child" | "spouse"; isOwner: boolean };
export type Grant = { id: string; email: string; status: "pending" | "active" };
export type MedicalDocument = {
  id: string;
  cardId: string;
  title: string;
  category: Category;
  examDate: string;
  filename: string;
  mime: string;
  size: number;
  createdAt: string;
};
export type NewDocument = Omit<MedicalDocument, "id" | "cardId" | "createdAt" | "size"> & { bytes: Uint8Array };
export type Overview = { user: Account; cards: Card[]; activeCardId: string; documents: MedicalDocument[]; grants: Grant[] };

export class CabinetError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "CabinetError";
    this.status = status;
  }
}

export interface CabinetStore {
  currentUser(): Promise<Account | null>;
  signUp(name: string, email: string, password: string): Promise<{ confirmationRequired: boolean }>;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  listCards(): Promise<Card[]>;
  addChild(name: string): Promise<string>;
  listGrants(cardId: string): Promise<Grant[]>;
  invite(cardId: string, email: string): Promise<string>;
  accept(code: string): Promise<string>;
  revoke(cardId: string, grantId: string): Promise<void>;
  documents(cardId: string): Promise<MedicalDocument[]>;
  upload(cardId: string, input: NewDocument): Promise<string>;
  file(id: string): Promise<{ record: MedicalDocument; bytes: Uint8Array }>;
}
