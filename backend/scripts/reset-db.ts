#!/usr/bin/env npx tsx
/**
 * Reset Database Script
 * Clears all claim/distribution/payment history while keeping table structure.
 * Use when switching to a new token or deployer wallet.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/reset-db.ts
 */

import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL environment variable is required");
  console.error('Usage: DATABASE_URL="postgresql://..." npx tsx scripts/reset-db.ts');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

async function resetDatabase() {
  const client = await pool.connect();

  try {
    // Discover tables
    const tablesResult = await client.query(`
      SELECT tablename FROM pg_tables 
      WHERE schemaname = 'public' 
      ORDER BY tablename
    `);
    const tables = tablesResult.rows.map((r: any) => r.tablename);
    console.log("\n📋 Tables found:", tables.join(", "));

    // Count rows before
    console.log("\n📊 Current row counts:");
    for (const table of tables) {
      const { rows } = await client.query(`SELECT COUNT(*) as count FROM "${table}"`);
      console.log(`   ${table}: ${rows[0].count} rows`);
    }

    console.log("\n⚠️  This will DELETE ALL DATA from all tables.");
    console.log("   Table structure will be preserved.");
    console.log("   Auto-increment IDs will reset to 1.\n");

    // Confirmation
    if (process.stdin.isTTY) {
      const readline = await import("readline");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((resolve) => {
        rl.question("   Type 'RESET' to confirm: ", resolve);
      });
      rl.close();
      if (answer !== "RESET") {
        console.log("❌ Aborted.");
        process.exit(0);
      }
    } else {
      console.log("🔄 Non-interactive mode, proceeding...\n");
    }

    // Truncate all tables
    await client.query("BEGIN");

    for (const table of tables) {
      if (table === "schema_version") {
        console.log(`   ⏭️  Skipped: ${table} (migration tracking)`);
        continue;
      }
      await client.query(`TRUNCATE TABLE "${table}" CASCADE`);
      console.log(`   ✅ Cleared: ${table}`);
    }

    // Reset sequences
    const { rows: seqs } = await client.query(`
      SELECT c.relname FROM pg_class c WHERE c.relkind = 'S'
    `);
    for (const seq of seqs) {
      await client.query(`ALTER SEQUENCE "${seq.relname}" RESTART WITH 1`);
    }
    console.log(`   ✅ Reset ${seqs.length} sequences`);

    await client.query("COMMIT");

    // Verify
    console.log("\n✅ Database reset complete:");
    for (const table of tables) {
      const { rows } = await client.query(`SELECT COUNT(*) as count FROM "${table}"`);
      console.log(`   ${table}: ${rows[0].count} rows`);
    }

    console.log("\n🎉 Ready for a new token.\n");

  } catch (err: any) {
    await client.query("ROLLBACK");
    console.error("❌ Error:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

resetDatabase();
