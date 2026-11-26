import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { cardUser, pdf } from "./card-user.ts";
import { withTestDatabase } from "./database.ts";

async function waitForLocks(pool: Pool, expected: number) {
  await expect.poll(async () => {
    const result = await pool.query<{ count: number }>(`
      SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'my-medic-grants-test'
        AND cardinality(pg_blocking_pids(pid)) > 0
    `);
    return result.rows[0].count;
  }).toBe(expected);
}

test("concurrent revocation and document requests respect the order that acquired the grant", async () => {
  await withTestDatabase(async ({ url, client }) => {
    const pool = new Pool({ connectionString: url, application_name: "my-medic-grants-test" });
    try {
      const owner = await cardUser(pool, "Анна", "anna@example.test");
      const partner = await cardUser(pool, "Пётр", "peter@example.test");
      const id = await owner.store.upload(owner.self, pdf);
      await partner.store.accept(await owner.store.invite(owner.self, partner.email));
      const [grant] = await owner.store.listGrants(owner.self);

      // Let all three document requests reach the uncommitted revocation.
      await client.query("BEGIN");
      let requests: Promise<PromiseSettledResult<unknown>[]>;
      try {
        await client.query("DELETE FROM medic.card_grants WHERE id = $1", [grant.id]);
        requests = Promise.allSettled([
          partner.store.file(id), partner.store.documents(owner.self), partner.store.upload(owner.self, pdf),
        ]);
        await waitForLocks(pool, 3);
      } finally { await client.query("COMMIT"); }
      for (const result of await requests) {
        expect(result).toMatchObject({ status: "rejected", reason: { status: 404 } });
      }
      expect(await owner.store.documents(owner.self)).toHaveLength(1);

      await partner.store.accept(await owner.store.invite(owner.self, partner.email));
      const [renewed] = await owner.store.listGrants(owner.self);
      // Delay the INSERT after authorization, then start revocation while the upload still holds the grant.
      await client.query("BEGIN");
      let upload: Promise<string>;
      let revoke: Promise<void>;
      try {
        await client.query("LOCK TABLE medic.documents IN SHARE MODE");
        upload = partner.store.upload(owner.self, pdf);
        await waitForLocks(pool, 1);
        revoke = owner.store.revoke(owner.self, renewed.id);
        await waitForLocks(pool, 2);
      } finally { await client.query("COMMIT"); }
      const [uploaded] = await Promise.all([upload, revoke]);
      expect((await owner.store.file(uploaded)).record.cardId).toBe(owner.self);
      await expect(partner.store.file(uploaded)).rejects.toMatchObject({ status: 404 });
    } finally { await pool.end(); }
  });
});
